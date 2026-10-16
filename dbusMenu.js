import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import { fromDbusmenu } from './accel.js';

// Menus exported over com.canonical.dbusmenu, announced through the Unity
// AppMenu registrar. This is how Electron and Chromium (and Qt) hand their
// real menubar to a desktop-wide menu -- but only when running under X11:
// they register the X window id of each toplevel, and there is no Wayland
// equivalent they implement. An app that wants its menus here has to be
// started with --ozone-platform=x11.
//
// The registrar is ours to provide: nothing else owns the name on GNOME.

const REGISTRAR_NAME = 'com.canonical.AppMenu.Registrar';
const REGISTRAR_PATH = '/com/canonical/AppMenu/Registrar';
const DBUSMENU_IFACE = 'com.canonical.dbusmenu';

const REGISTRAR_XML = `<node>
  <interface name="${REGISTRAR_NAME}">
    <method name="RegisterWindow">
      <arg type="u" name="windowId" direction="in"/>
      <arg type="o" name="menuObjectPath" direction="in"/>
    </method>
    <method name="UnregisterWindow">
      <arg type="u" name="windowId" direction="in"/>
    </method>
    <method name="GetMenuForWindow">
      <arg type="u" name="windowId" direction="in"/>
      <arg type="s" name="service" direction="out"/>
      <arg type="o" name="menuObjectPath" direction="out"/>
    </method>
    <method name="GetMenus">
      <arg type="a(uso)" name="menus" direction="out"/>
    </method>
    <signal name="WindowRegistered">
      <arg type="u" name="windowId"/>
      <arg type="s" name="service"/>
      <arg type="o" name="menuObjectPath"/>
    </signal>
    <signal name="WindowUnregistered">
      <arg type="u" name="windowId"/>
    </signal>
  </interface>
</node>`;

// Refetching on every change signal would mean one GetLayout per property
// flip while an app rebuilds its menu; coalesce them.
const REFETCH_DEBOUNCE_MS = 100;

// Any client on the session bus can call the registrar, so its table is
// bounded: a client registering window after window would otherwise grow it
// without limit.
const MAX_WINDOWS_PER_SENDER = 64;

// An app registers when it maps its window, and the D-Bus call can arrive
// before mutter has managed the window it names -- they reach the compositor
// over different sockets. Wait this long for it to appear before refusing.
const REGISTER_WAIT_MS = 2000;

// The layout is the app's data, and walking it builds one actor per item;
// anything deeper or larger than this is dropped rather than rendered.
const MAX_DEPTH = 8;
const MAX_ITEMS = 1000;

// The X window id of an X11 window, or 0. Mutter does not introspect
// meta_window_x11_get_xwindow(), but describes every X11 window as
// "0x<xid> (<title>)".
export function xidOf(window) {
    if (!window || window.get_client_type() !== Meta.WindowClientType.X11)
        return 0;
    const m = /^0x([0-9a-f]+)/i.exec(window.get_description() ?? '');
    return m ? parseInt(m[1], 16) : 0;
}

// 0 is what xidOf() says for every Wayland window, so it never matches.
function isManagedXid(xid) {
    return xid !== 0 && global.display.list_all_windows().some(w => xidOf(w) === xid);
}

export class AppMenuRegistrar {
    // `onChanged(xid)` is called whenever a window's menu is registered or goes
    // away, so the caller can refresh if that window is the focused one.
    constructor(onChanged) {
        this._onChanged = onChanged || (() => {});
        this._menus = new Map();      // xid -> {busName, path}
        this._watches = new Map();    // busName -> watch id
        this._pending = new Set();    // {xid, busName, path, invocation, timeoutId}

        global.display.connectObject('window-created', (_display, window) => {
            const xid = xidOf(window);
            for (const p of this._pending) {
                if (p.xid === xid)
                    this._settle(p, true);
            }
        }, this);

        this._exported = Gio.DBusExportedObject.wrapJSObject(REGISTRAR_XML, this);
        this._exported.export(Gio.DBus.session, REGISTRAR_PATH);
        this._ownerId = Gio.bus_own_name_on_connection(Gio.DBus.session,
            REGISTRAR_NAME, Gio.BusNameOwnerFlags.NONE, null, null);
    }

    menuFor(xid) {
        return xid ? this._menus.get(xid) ?? null : null;
    }

    // D-Bus methods. The Async forms receive the invocation, which is the only
    // way to learn who is registering: the menu lives on the caller's bus name.
    //
    // First come owns a window: while the app that registered a window's menu
    // is still on the bus, nobody else can replace or remove it, so no other
    // process can put its own menu on an app's window. (Matching the sender's
    // pid against the window's would be stricter, but a flatpak reaches the
    // bus through xdg-dbus-proxy, whose pid is not the app's.) The claim ends
    // when the owner unregisters or leaves the bus (_watchSender).
    //
    // A registration is only accepted for a window mutter manages (or starts
    // managing within REGISTER_WAIT_MS), so nobody can stake out an xid long
    // ahead of the window that will get it. What this still allows: a client
    // can claim an existing window whose app never registers a menu of its
    // own (most windows), since there is no reliable mapping from a sender to
    // its windows -- see above on pids.
    RegisterWindowAsync([xid, path], invocation) {
        // 0 is what xidOf() gives every Wayland window: never a real one, and
        // held as pending, any Wayland window-created would settle it.
        if (xid === 0) {
            invocation.return_dbus_error('org.freedesktop.DBus.Error.InvalidArgs', 'no window 0');
            return;
        }
        const busName = invocation.get_sender();
        const previous = this._menus.get(xid);
        if (previous && previous.busName !== busName) {
            invocation.return_dbus_error('org.freedesktop.DBus.Error.AccessDenied',
                `window ${xid} already has a menu from ${previous.busName}`);
            return;
        }
        if (!previous && this._countFor(busName) >= MAX_WINDOWS_PER_SENDER) {
            invocation.return_dbus_error('org.freedesktop.DBus.Error.LimitsExceeded',
                `${busName} has registered ${MAX_WINDOWS_PER_SENDER} windows`);
            return;
        }
        if (!isManagedXid(xid)) {
            const p = {xid, busName, path, invocation};
            p.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REGISTER_WAIT_MS, () => {
                p.timeoutId = 0;
                // Checked again rather than assumed: the window may have been
                // managed without its xid being readable at window-created.
                this._settle(p, isManagedXid(p.xid));
                return GLib.SOURCE_REMOVE;
            });
            this._pending.add(p);
            return;
        }
        this._register(xid, busName, path, invocation);
    }

    // Windows held by a sender, pending ones included. A client that never
    // unregisters a closed window would reach the cap over a long session, so
    // at the cap its entries for windows that no longer exist are dropped.
    _countFor(busName) {
        const count = () => [...this._menus.values(), ...this._pending]
            .filter(e => e.busName === busName).length;
        const n = count();
        if (n < MAX_WINDOWS_PER_SENDER)
            return n;
        for (const [xid, entry] of this._menus) {
            if (entry.busName === busName && !isManagedXid(xid)) {
                this._menus.delete(xid);
                this._exported.emit_signal('WindowUnregistered', new GLib.Variant('(u)', [xid]));
            }
        }
        return count();
    }

    _settle(p, managed) {
        this._pending.delete(p);
        if (p.timeoutId) {
            GLib.source_remove(p.timeoutId);
            p.timeoutId = 0;
        }
        if (!managed) {
            p.invocation.return_dbus_error('org.freedesktop.DBus.Error.InvalidArgs',
                `no window ${p.xid}`);
            return;
        }
        // Someone else may have claimed it while this one waited.
        const previous = this._menus.get(p.xid);
        if (previous && previous.busName !== p.busName) {
            p.invocation.return_dbus_error('org.freedesktop.DBus.Error.AccessDenied',
                `window ${p.xid} already has a menu from ${previous.busName}`);
            return;
        }
        this._register(p.xid, p.busName, p.path, p.invocation);
    }

    _register(xid, busName, path, invocation) {
        this._menus.set(xid, {busName, path});
        this._watchSender(busName);
        invocation.return_value(null);
        this._exported.emit_signal('WindowRegistered',
            new GLib.Variant('(uso)', [xid, busName, path]));
        this._onChanged(xid);
    }

    UnregisterWindowAsync([xid], invocation) {
        const entry = this._menus.get(xid);
        if (entry && entry.busName !== invocation.get_sender()) {
            invocation.return_dbus_error('org.freedesktop.DBus.Error.AccessDenied',
                `window ${xid} has a menu from ${entry.busName}`);
            return;
        }
        invocation.return_value(null);
        if (entry) {
            this._menus.delete(xid);
            this._unwatchSenderIfUnused(entry.busName);
            this._exported.emit_signal('WindowUnregistered', new GLib.Variant('(u)', [xid]));
            this._onChanged(xid);
        }
    }

    GetMenuForWindow(xid) {
        const entry = this._menus.get(xid);
        return entry ? [entry.busName, entry.path] : ['', '/'];
    }

    GetMenus() {
        return [...this._menus].map(([xid, {busName, path}]) => [xid, busName, path]);
    }

    // An app that exits never unregisters; drop everything it owned when its
    // bus name goes away.
    _watchSender(busName) {
        if (this._watches.has(busName))
            return;
        const id = Gio.bus_watch_name_on_connection(Gio.DBus.session, busName,
            Gio.BusNameWatcherFlags.NONE, null, () => {
                Gio.bus_unwatch_name(this._watches.get(busName));
                this._watches.delete(busName);
                for (const [xid, entry] of this._menus) {
                    if (entry.busName === busName) {
                        this._menus.delete(xid);
                        this._onChanged(xid);
                    }
                }
            });
        this._watches.set(busName, id);
    }

    // A sender that has unregistered its last window needs no watching.
    _unwatchSenderIfUnused(busName) {
        for (const entry of this._menus.values()) {
            if (entry.busName === busName)
                return;
        }
        const id = this._watches.get(busName);
        if (id) {
            Gio.bus_unwatch_name(id);
            this._watches.delete(busName);
        }
    }

    destroy() {
        global.display.disconnectObject(this);
        for (const p of this._pending) {
            if (p.timeoutId)
                GLib.source_remove(p.timeoutId);
            p.invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed',
                'registrar is shutting down');
        }
        this._pending.clear();
        for (const id of this._watches.values())
            Gio.bus_unwatch_name(id);
        this._watches.clear();
        this._menus.clear();
        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = 0;
        }
        this._exported?.unexport();
        this._exported = null;
    }
}

// Mnemonics are marked with '_'; '__' is a literal underscore.
function plainLabel(label) {
    return str(label).replace(/__/g, '\u0000').replace(/_/g, '').replace(/\u0000/g, '_');
}

// After recursiveUnpack a child out of `av` can be anything the app sent. A
// menu node is (int32 id, a{sv} props, av children); skip whatever is not.
function isNode(node) {
    return Array.isArray(node) && node.length === 3 &&
        Number.isInteger(node[0]) && (node[0] | 0) === node[0] &&
        node[1] !== null && typeof node[1] === 'object' && !Array.isArray(node[1]) &&
        Array.isArray(node[2]);
}

// Property values are just as untyped; a string is the only thing St takes.
function str(value) {
    return typeof value === 'string' ? value : '';
}

// Same interface as AppActionMenu -- isPopulated, getMenus(), destroy() --
// over one window's dbusmenu tree. The menus are the app's own, authored and
// ordered by it, so nothing is grouped or guessed here.
export class DbusMenuSource {
    constructor({busName, path}, onChanged) {
        this._busName = busName;
        this._path = path;
        this._onChanged = onChanged || (() => {});
        this._layout = null;
        this._cancellable = new Gio.Cancellable();
        this._refetchId = 0;

        this._signalId = Gio.DBus.session.signal_subscribe(busName, DBUSMENU_IFACE,
            null, path, null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, signal) => {
                if (signal === 'LayoutUpdated' || signal === 'ItemsPropertiesUpdated')
                    this._queueRefetch();
            });

        this._fetch(true);
    }

    get isPopulated() {
        return this._layout !== null;
    }

    _call(method, params, replyType) {
        return new Promise((resolve, reject) => {
            Gio.DBus.session.call(this._busName, this._path, DBUSMENU_IFACE,
                method, params, replyType ? new GLib.VariantType(replyType) : null,
                Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
                    try {
                        resolve(conn.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    async _fetch(first = false) {
        try {
            let reply = await this._call('GetLayout',
                new GLib.Variant('(iias)', [0, -1, []]), '(u(ia{sv}av))');
            let [, layout] = reply.recursiveUnpack();

            // A menubar opens its menus before showing them, and an app may only
            // fill a submenu in then. Do it once up front, so the first render
            // already has everything.
            //
            // Once destroy() has cancelled, nothing may land: _onChanged would
            // rebuild the bar for a source that is gone, possibly after the
            // whole extension was disabled.
            if (first) {
                let stale = false;
                for (const node of layout[2]) {
                    if (!isNode(node))
                        continue;
                    try {
                        const [needUpdate] = (await this._call('AboutToShow',
                            new GLib.Variant('(i)', [node[0]]), '(b)')).deepUnpack();
                        stale ||= needUpdate;
                    } catch (e) {
                        // AboutToShow is optional in the spec; cancellation is not.
                        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                            throw e;
                    }
                    if (this._cancellable.is_cancelled())
                        return;
                }
                if (stale) {
                    reply = await this._call('GetLayout',
                        new GLib.Variant('(iias)', [0, -1, []]), '(u(ia{sv}av))');
                    [, layout] = reply.recursiveUnpack();
                }
            }

            if (this._cancellable.is_cancelled())
                return;
            this._layout = layout;
            this._onChanged();
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`[globalmenu] dbusmenu ${this._busName}${this._path}: ${e.message}`);
        }
    }

    _queueRefetch() {
        if (this._refetchId)
            return;
        this._refetchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFETCH_DEBOUNCE_MS, () => {
            this._refetchId = 0;
            this._fetch();
            return GLib.SOURCE_REMOVE;
        });
    }

    _activate(id) {
        this._call('Event', new GLib.Variant('(isvu)',
            [id, 'clicked', new GLib.Variant('i', 0), global.get_current_time()]), null)
            .catch(e => console.warn(`[globalmenu] dbusmenu Event: ${e.message}`));
    }

    // `walk` counts items across the whole tree, so a wide menu is bounded as
    // well as a deep one.
    _items(children, walk, depth) {
        const items = [];
        if (depth > MAX_DEPTH)
            return items;
        for (const node of children) {
            if (!isNode(node) || walk.count >= MAX_ITEMS)
                continue;
            walk.count++;
            const [id, props, grandchildren] = node;
            if (props.visible === false)
                continue;
            if (props.type === 'separator') {
                // Never lead, trail or double up.
                if (items.length && items[items.length - 1].type !== 'separator')
                    items.push({type: 'separator'});
                continue;
            }
            const label = plainLabel(props.label);
            const icon = str(props['icon-name']) || undefined;
            if (props['children-display'] === 'submenu' || grandchildren.length) {
                const sub = this._items(grandchildren, walk, depth + 1);
                if (sub.length)
                    items.push({type: 'submenu', label, children: sub, icon});
                continue;
            }
            const toggle = props['toggle-type'];
            items.push({
                label,
                icon,
                enabled: props.enabled !== false,
                isCheck: toggle === 'checkmark' || toggle === 'radio',
                checked: props['toggle-state'] === 1,
                accel: fromDbusmenu(props.shortcut),
                activate: () => this._activate(id),
            });
        }
        while (items.length && items[items.length - 1].type === 'separator')
            items.pop();
        return items;
    }

    getMenus() {
        if (!this._layout)
            return [];
        const menus = [];
        const walk = {count: 0};
        for (const node of this._layout[2]) {
            if (!isNode(node) || walk.count >= MAX_ITEMS)
                continue;
            walk.count++;
            const [, props, children] = node;
            if (props.visible === false)
                continue;
            const items = this._items(children, walk, 1);
            if (items.length)
                menus.push({label: plainLabel(props.label), children: items});
        }
        return menus;
    }

    destroy() {
        this._cancellable.cancel();
        if (this._refetchId) {
            GLib.source_remove(this._refetchId);
            this._refetchId = 0;
        }
        if (this._signalId) {
            Gio.DBus.session.signal_unsubscribe(this._signalId);
            this._signalId = 0;
        }
    }
}
