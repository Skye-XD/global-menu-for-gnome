// Builds menus from what an application actually publishes over D-Bus.
//
// Two sources, in order of preference:
//
//   1. org.gtk.Menus, via the window's gtk-menubar-object-path. This is a real
//      menubar, exported by the app, and is rendered as-is. No application on a
//      stock GNOME 50 desktop currently exports one -- a survey of the session
//      bus found zero -- but it is the correct primary path and costs little
//      once the plumbing exists.
//
//   2. org.gtk.Actions, via the application and window object paths. Apps do
//      export these, they carry live enabled-state, and they invoke through the
//      app's own action group. This is what actually populates the bar today.
//
// Nothing here synthesises keyboard input, and an entry is only ever shown when
// the action behind it exists.
//
// Every D-Bus call is asynchronous. These run inside the compositor process, so
// a synchronous call to an application that has stopped responding would freeze
// the whole session until it timed out.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// DescribeAll carries no labels, and a .desktop file names only the few actions
// it advertises as launcher shortcuts, so the rest are labelled from here. These
// names are conventional across GTK/GNOME applications rather than specific to
// any one of them.
const KNOWN_LABELS = {
    'about': 'About %s',
    'clone-window': 'Duplicate Window',
    'close-current-view': 'Close Tab',
    'close-other-tabs': 'Close Other Tabs',
    'copy': 'Copy',
    'current-location-menu': 'Current Location',
    'cut': 'Cut',
    'find': 'Find…',
    'go-back': 'Back',
    'go-forward': 'Forward',
    'go-home': 'Home',
    'go-up': 'Enclosing Folder',
    'help': 'Help',
    'kill': 'Force Quit %s',
    'new-tab': 'New Tab',
    'new-window': 'New Window',
    'paste': 'Paste',
    'preferences': 'Preferences',
    'quit': 'Quit %s',
    'redo': 'Redo',
    'restore-tab': 'Reopen Closed Tab',
    'search-settings': 'Search Settings',
    'select-all': 'Select All',
    'shortcuts': 'Keyboard Shortcuts',
    'show-file-transfers': 'File Transfers',
    'show-hidden-files': 'Show Hidden Files',
    'tab-move-left': 'Move Tab Left',
    'tab-move-new-window': 'Move Tab to New Window',
    'tab-move-right': 'Move Tab Right',
    'toggle-sidebar': 'Show Sidebar',
    'undo': 'Undo',
    'zoom-in': 'Zoom In',
    'zoom-out': 'Zoom Out',
    'zoom-standard': 'Normal Size',
};

// Which menu each action appears under, and in what order. An explicit order
// reads far better than sorting alphabetically, and keeps a menu's contents
// stable as actions come and go. Actions not named here are not dropped -- they
// are appended to the application menu, so nothing real is ever hidden.
const MENU_LAYOUT = [
    { id: 'app', items: ['about', 'preferences', 'search-settings', 'kill', 'quit'] },
    { id: 'file', label: 'File', items: ['new-window', 'new-tab', 'clone-window', 'restore-tab', 'close-current-view', 'close-other-tabs'] },
    { id: 'edit', label: 'Edit', items: ['undo', 'redo', 'cut', 'copy', 'paste', 'select-all', 'find'] },
    { id: 'view', label: 'View', items: ['toggle-sidebar', 'show-hidden-files', 'zoom-in', 'zoom-standard', 'zoom-out'] },
    { id: 'go', label: 'Go', items: ['go-back', 'go-forward', 'go-up', 'go-home', 'current-location-menu'] },
    { id: 'window', label: 'Window', items: ['tab-move-left', 'tab-move-right', 'tab-move-new-window', 'show-file-transfers'] },
    { id: 'help', label: 'Help', items: ['help', 'shortcuts'] },
];

// Turn an unrecognised action id into something presentable: 'show-file-sizes'
// becomes 'Show File Sizes'. Better than hiding an action we simply have no
// label for.
function humanize(name) {
    return name.replace(/[-_.]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, c => c.toUpperCase());
}

export class AppActionMenu {
    // `appInfo` is the Gio.DesktopAppInfo behind the focused window, used only
    // for its translated action names. `onChanged` is called whenever the menu
    // contents would differ -- action groups populate asynchronously, so the
    // first useful call almost always arrives after the constructor returns.
    constructor({ busName, appPath, windowPath, menubarPath, appInfo, appName }, onChanged) {
        this._appName = appName || 'Application';
        this._appInfo = appInfo || null;
        this._onChanged = onChanged || (() => {});
        this._groups = [];
        this._menuModel = null;
        this._cancellable = new Gio.Cancellable();
        this._pendingProbes = 0;
        this._ready = false;

        const bus = Gio.DBus.session;
        if (!busName) {
            // Nothing publishes actions for this window -- Chrome and Firefox
            // both land here -- so there is nothing to wait for. Returning
            // without settling left isPopulated false forever and made the
            // caller hold the previous application's menus for the whole
            // populate grace on every switch to such an app.
            this._ready = true;
            return;
        }

        // A real exported menubar wins outright.
        if (menubarPath) {
            this._menuModel = Gio.DBusMenuModel.get(bus, busName, menubarPath);
            this._menubarChangedId = this._menuModel.connect('items-changed', () => this._onChanged());
        }

        // Window actions are listed before application ones so that a window's
        // own 'new-tab' shadows an identically named application action.
        for (const path of [windowPath, appPath]) {
            if (!path)
                continue;
            const group = Gio.DBusActionGroup.get(bus, busName, path);
            // list_actions() is what prompts the group to populate; without it
            // no signal ever arrives and the group stays permanently empty.
            group.list_actions();
            const ids = [
                group.connect('action-added', () => this._onChanged()),
                group.connect('action-removed', () => this._onChanged()),
                group.connect('action-enabled-changed', () => this._onChanged()),
            ];
            this._groups.push({ group, ids });

            // Knowing when an application has finished answering is not
            // something DBusActionGroup exposes: it emits one signal per action
            // as it populates, and nothing at all once it is done or when it has
            // no actions to send. A single DescribeAll per path settles that,
            // and settles it for an empty group too.
            this._pendingProbes++;
            bus.call(busName, path, 'org.gtk.Actions', 'DescribeAll', null,
                new GLib.VariantType('(a{s(bgav)})'), Gio.DBusCallFlags.NONE, 2000,
                this._cancellable, (source, res) => {
                    try {
                        bus.call_finish(res);
                    } catch (e) {
                        // A cancelled probe belongs to a menu that is already
                        // gone; anything else means the app did not answer, and
                        // either way this path is settled.
                        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                            return;
                    }
                    if (--this._pendingProbes === 0) {
                        this._ready = true;
                        this._onChanged();
                    }
                });
        }

        // Nothing to wait for.
        if (this._pendingProbes === 0)
            this._ready = true;
    }

    // True once every action group has answered -- including one that answered
    // with nothing -- so the caller can leave the previous menus in place rather
    // than flashing an almost empty bar while the app is still replying.
    get isPopulated() {
        if (this._menuModel)
            return this._menuModel.get_n_items() > 0;
        return this._ready;
    }

    _labelFor(name) {
        // A .desktop file's action names are translated; prefer them.
        if (this._appInfo) {
            try {
                if (this._appInfo.list_actions().includes(name)) {
                    const label = this._appInfo.get_action_name(name);
                    if (label)
                        return label;
                }
            } catch (e) {
                // An app info without actions throws rather than returning
                // empty; fall through to the table.
            }
        }
        const known = KNOWN_LABELS[name];
        if (known)
            return known.includes('%s') ? known.replace('%s', this._appName) : known;
        return humanize(name);
    }

    // Collect every invokable action, nearest scope first. An action taking a
    // parameter is skipped: DescribeAll reports the type but never a meaningful
    // value, so 'edit-profile' (which takes a profile uuid) has nothing sensible
    // to be invoked with from a menu.
    _collectActions() {
        const found = new Map();
        for (const { group } of this._groups) {
            for (const name of group.list_actions()) {
                if (found.has(name))
                    continue;
                const paramType = group.get_action_parameter_type(name);
                if (paramType)
                    continue;
                found.set(name, {
                    name,
                    enabled: group.get_action_enabled(name),
                    state: group.get_action_state(name),
                    activate: () => group.activate_action(name, null),
                });
            }
        }
        return found;
    }

    // Returns [{ label, children: [{ label, enabled, isCheck, checked, activate }] }].
    // A menu with no surviving children is omitted entirely rather than shown
    // empty or greyed out.
    getMenus() {
        if (this._menuModel)
            return this._fromMenuModel();

        const actions = this._collectActions();
        const placed = new Set();
        const menus = [];

        for (const section of MENU_LAYOUT) {
            const children = [];
            for (const name of section.items) {
                const action = actions.get(name);
                if (!action)
                    continue;
                placed.add(name);
                children.push(this._toItem(action));
            }
            if (section.id === 'app') {
                // Anything the layout does not name is real and invokable, so it
                // belongs somewhere. The application menu is the honest home for
                // it: separated, at the bottom, never silently dropped.
                const extras = [...actions.values()].filter(a => !MENU_LAYOUT.some(s => s.items.includes(a.name)));
                if (extras.length) {
                    if (children.length)
                        children.push({ type: 'separator' });
                    extras.forEach(a => children.push(this._toItem(a)));
                    extras.forEach(a => placed.add(a.name));
                }
            }
            if (!children.length)
                continue;
            menus.push({ label: section.label || this._appName, children, isAppMenu: section.id === 'app' });
        }
        return menus;
    }

    _toItem(action) {
        // A boolean-stated action is a toggle, and rendering it as a check item
        // is the only way the menu reflects what the app is actually doing.
        const isCheck = !!action.state && action.state.is_of_type(new GLib.VariantType('b'));
        return {
            label: this._labelFor(action.name),
            enabled: action.enabled,
            isCheck,
            checked: isCheck ? action.state.get_boolean() : false,
            activate: action.activate,
        };
    }

    // Render a genuine exported menubar. Nothing on this desktop exports one
    // today, so this path is correct-by-construction rather than battle-tested.
    _fromMenuModel() {
        const menus = [];
        const n = this._menuModel.get_n_items();
        for (let i = 0; i < n; i++) {
            const label = this._menuModel.get_item_attribute_value(i, 'label', null);
            const submenu = this._menuModel.get_item_link(i, 'submenu');
            if (!submenu)
                continue;
            menus.push({
                label: label ? label.get_string()[0].replace(/_/g, '') : '',
                children: this._itemsFrom(submenu),
                isAppMenu: i === 0,
            });
        }
        return menus;
    }

    _itemsFrom(model) {
        const items = [];
        const n = model.get_n_items();
        for (let i = 0; i < n; i++) {
            const label = model.get_item_attribute_value(i, 'label', null);
            const target = model.get_item_attribute_value(i, 'action', null);
            const section = model.get_item_link(i, 'section');
            const submenu = model.get_item_link(i, 'submenu');

            if (section) {
                if (items.length)
                    items.push({ type: 'separator' });
                items.push(...this._itemsFrom(section));
                continue;
            }
            if (submenu) {
                items.push({
                    type: 'submenu',
                    label: label ? label.get_string()[0].replace(/_/g, '') : '',
                    children: this._itemsFrom(submenu),
                });
                continue;
            }
            if (!label)
                continue;

            const actionName = target ? target.get_string()[0].replace(/^(app|win)\./, '') : null;
            const action = actionName ? this._collectActions().get(actionName) : null;
            items.push({
                label: label.get_string()[0].replace(/_/g, ''),
                enabled: action ? action.enabled : !!action,
                activate: action ? action.activate : () => {},
            });
        }
        return items;
    }

    destroy() {
        // A probe still in flight would otherwise call back into a menu that no
        // longer exists.
        this._cancellable.cancel();
        for (const { group, ids } of this._groups)
            ids.forEach(id => group.disconnect(id));
        this._groups = [];
        if (this._menuModel && this._menubarChangedId) {
            this._menuModel.disconnect(this._menubarChangedId);
            this._menubarChangedId = null;
        }
        this._menuModel = null;
    }
}
