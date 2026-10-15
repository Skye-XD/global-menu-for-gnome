import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

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

// The X window id of an X11 window, or 0. Mutter does not introspect
// meta_window_x11_get_xwindow(), but describes every X11 window as
// "0x<xid> (<title>)".
export function xidOf(window) {
    if (!window || window.get_client_type() !== Meta.WindowClientType.X11)
        return 0;
    const m = /^0x([0-9a-f]+)/i.exec(window.get_description() ?? '');
    return m ? parseInt(m[1], 16) : 0;
}

export class AppMenuRegistrar {
    // `onChanged(xid)` is called whenever a window's menu is registered or goes
    // away, so the caller can refresh if that window is the focused one.
    constructor(onChanged) {
        this._onChanged = onChanged || (() => {});
        this._menus = new Map();      // xid -> {busName, path}
        this._watches = new Map();    // busName -> watch id

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
    RegisterWindowAsync([xid, path], invocation) {
        const busName = invocation.get_sender();
        this._menus.set(xid, {busName, path});
        this._watchSender(busName);
        invocation.return_value(null);
        this._exported.emit_signal('WindowRegistered',
            new GLib.Variant('(uso)', [xid, busName, path]));
        this._onChanged(xid);
    }

    UnregisterWindow(xid) {
        if (this._menus.delete(xid)) {
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

    destroy() {
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
    return String(label ?? '').replace(/__/g, '\u0000').replace(/_/g, '').replace(/\u0000/g, '_');
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
            if (first) {
                let stale = false;
                for (const [id] of layout[2]) {
                    try {
                        const [needUpdate] = (await this._call('AboutToShow',
                            new GLib.Variant('(i)', [id]), '(b)')).deepUnpack();
                        stale ||= needUpdate;
                    } catch (_e) {
                        // AboutToShow is optional in the spec.
                    }
                }
                if (stale) {
                    reply = await this._call('GetLayout',
                        new GLib.Variant('(iias)', [0, -1, []]), '(u(ia{sv}av))');
                    [, layout] = reply.recursiveUnpack();
                }
            }

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

    _items(children) {
        const items = [];
        for (const [id, props, grandchildren] of children) {
            if (props.visible === false)
                continue;
            if (props.type === 'separator') {
                // Never lead, trail or double up.
                if (items.length && items[items.length - 1].type !== 'separator')
                    items.push({type: 'separator'});
                continue;
            }
            const label = plainLabel(props.label);
            if (props['children-display'] === 'submenu' || grandchildren.length) {
                const sub = this._items(grandchildren);
                if (sub.length)
                    items.push({type: 'submenu', label, children: sub, icon: props['icon-name']});
                continue;
            }
            const toggle = props['toggle-type'];
            items.push({
                label,
                icon: props['icon-name'] || undefined,
                enabled: props.enabled !== false,
                isCheck: toggle === 'checkmark' || toggle === 'radio',
                checked: props['toggle-state'] === 1,
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
        for (const [, props, children] of this._layout[2]) {
            if (props.visible === false)
                continue;
            const items = this._items(children);
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
