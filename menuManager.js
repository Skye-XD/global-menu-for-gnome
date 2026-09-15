import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { ClipboardHistoryStore, ClipboardPanel } from './clipboardHistory.js';
import { EmojiPicker } from './emojiPicker.js';
import { AppActionMenu } from './appActionMenu.js';

// Error logging is gated behind the "debug-logging" setting (off by
// default) so the extension doesn't spam the journal in normal use.
// MenuManager keeps this in sync with the setting; toggled live.
let debugLoggingEnabled = false;

function logError(message) {
    if (debugLoggingEnabled) console.error(message);
}

// Long enough to coalesce the burst of action-added signals an action group
// emits as it populates, short enough not to lag behind a window switch.
const REBUILD_DEBOUNCE_MS = 40;

// Polling for an application that has not answered yet is a different job from
// coalescing the burst of action-added signals it sends once it does, and it
// wants a much finer interval: measurement showed an app replying in 2ms and
// the bar still taking 43ms to appear, because the reply then sat in the
// coalescing timer. Each poll that finds nothing costs two comparisons.
const POPULATE_POLL_MS = 8;

// How long to keep showing the previous application's menus while the newly
// focused one's action groups populate. An application that genuinely exports
// nothing never becomes populated, so this bounds the wait.
const POPULATE_GRACE_US = 400 * 1000;

// Waiting for a window to take focus is a different wait entirely, and a much
// longer one: an application being launched routinely takes more than a second
// to map its first window. Sharing the populate grace meant giving up early and
// showing the file manager's menus in the gap, which looked like the bar
// randomly deciding the user had switched to Files.
const TRANSIENT_FOCUS_GRACE_US = 2000 * 1000;

// Windows that are not applications the user switched to. The desktop is listed
// separately because focusing it is a deliberate act that should show the file
// manager, whereas focusing nothing at all is usually just an app starting up.
const DESKTOP_IDENTIFIERS = ['com.desktop.ding', 'com.desktop.dingextension'];

// Clicking the desktop and an application taking a moment to map its first
// window are indistinguishable from the shell's side: in both cases nothing is
// focused. No timeout can separate them -- a short one flashes the file
// manager's menus during launches, a long one makes a real desktop click take
// that long to resolve. The desktop-icons fork announces the click on the bus,
// which is the only signal that tells the two apart, so take it when it is
// there and fall back to the timeout when it is not.
const DING_BUS_NAME = 'com.desktop.ding';
const DING_CLICK_SIGNAL = 'desktopclick';
const DESKTOP_CLICK_FRESH_US = 1000 * 1000;

// Spawn a command safely using an argv array so no shell parsing/injection
// can occur, and so arguments with spaces or special characters are passed
// through intact.
function spawnCommand(argv) {
    try {
        GLib.spawn_async(
            null,
            argv,
            null,
            GLib.SpawnFlags.SEARCH_PATH,
            null
        );
    } catch (e) {
        logError(`[globalmenu] Failed to spawn '${argv.join(' ')}': ${e}`);
    }
}

const TopLevelMenuButton = GObject.registerClass(
  class TopLevelMenuButton extends PanelMenu.Button {
    _init(label, children, appInstance = null, clipboardPanel = null, emojiPicker = null, isAppMenu = false) {
      super._init(0.5, label);
      this._menuLabel = label;
      this._appInstance = appInstance;
      this._clipboardPanel = clipboardPanel;
      this._emojiPicker = emojiPicker;
      this._timeoutIds = [];

      let title = new St.Label({
          text: label,
          y_align: Clutter.ActorAlign.CENTER,
          style_class: 'panel-button-label'
      });
      this._titleLabel = title;
      this.add_child(title);

      this._setAppMenuStyle(isAppMenu);
      this._buildSubMenu(children, this.menu);

      if (this.menu) {
          this.menu.connectObject('open-state-changed', (_menu, _isOpen) => {
              this._alignMenuToLeft();
          }, this);
      }
    }

    _alignMenuToLeft() {
        if (!this.menu || !this.menu.actor) return;
        try {
            let buttonWidth = Math.round(this.get_width() || 0);
            let menuWidth = Math.round(this.menu.actor.get_width() || 0);
            if (buttonWidth <= 0 || menuWidth <= 0) return;

            let offset = Math.round((menuWidth - buttonWidth) / 2);

            // Clamp so the menu never gets pushed off-screen near a
            // monitor edge (matters most on smaller/secondary displays).
            let [buttonX] = this.get_transformed_position();
            let monitor = Main.layoutManager.findMonitorForActor(this) ||
                          Main.layoutManager.primaryMonitor;
            if (monitor) {
                let menuLeft = buttonX - offset;
                let menuRight = menuLeft + menuWidth;
                if (menuLeft < monitor.x)
                    offset -= (monitor.x - menuLeft);
                else if (menuRight > monitor.x + monitor.width)
                    offset += (menuRight - (monitor.x + monitor.width));
            }

            this.menu.actor.translation_x = offset;
        } catch (e) {
            logError(`[globalmenu] Error aligning menu: ${e}`);
        }
    }

    _executeNativeAction(action) {
        let display = global.display;
        let window = display.get_focus_window();

        if (action === "close") {
            if (window) window.delete(global.get_current_time());
            return true;
        } else if (action === "minimize") {
            if (window) window.minimize();
            return true;
        } else if (action === "maximize") {
            if (window) {
                if (window.is_maximized()) window.unmaximize();
                else window.maximize();
            }
            return true;
        }

        if (action.startsWith("custom-command:")) {
            let cmd = action.slice("custom-command:".length);
            try {
                let [, argv] = GLib.shell_parse_argv(cmd);
                spawnCommand(argv);
            } catch (e) {
                logError(`[globalmenu] Invalid custom command '${cmd}': ${e}`);
            }
            return true;
        }

        if (action.startsWith("custom-shortcut:")) {
            let accel = action.slice("custom-shortcut:".length);
            this._sendAccelerator(accel);
            return true;
        }

        if (action.startsWith("activate-window:")) {
            let winId = action.split(":")[1];
            if (this._appInstance) {
                let appWindows = this._appInstance.get_windows();
                let targetWin = appWindows.find(w => w.get_id().toString() === winId);
                if (targetWin) {
                    targetWin.activate(global.get_current_time());
                    return true;
                }
            }
            return false;
        }

        if (action === "new-app-window") {
            if (this._appInstance) {
                this._appInstance.open_new_window(-1);
                return true;
            }
            return false;
        }

        if (action.startsWith("app-details:")) {
            let appId = action.split(":")[1];
            if (appId) {
                spawnCommand(['gnome-software', `--details=${appId}`]);
                return true;
            }
        }

        try {
            if (action === "open-file-manager" || action === "new-file-manager-win" || action === "go-home") {
                spawnCommand(['xdg-open', GLib.get_home_dir()]);
                return true;
            } else if (action === "new-folder") {
                this._createNewFolder();
                return true;
            } else if (action === "open-settings") {
                spawnCommand(['gnome-control-center']);
                return true;
            } else if (action === "empty-bin") {
                spawnCommand(['gio', 'trash', '--empty']);
                return true;
            } else if (action === "open-system-help") {
                spawnCommand(['yelp']);
                return true;
            } else if (action === "go-recents") {
                spawnCommand(['xdg-open', 'recent:///']);
                return true;
            } else if (action === "go-documents") {
                let path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS) || `${GLib.get_home_dir()}/Documents`;
                spawnCommand(['xdg-open', path]);
                return true;
            } else if (action === "go-desktop") {
                let path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP) || `${GLib.get_home_dir()}/Desktop`;
                spawnCommand(['xdg-open', path]);
                return true;
            } else if (action === "go-downloads") {
                let path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) || `${GLib.get_home_dir()}/Downloads`;
                spawnCommand(['xdg-open', path]);
                return true;
            }
        } catch (e) {
            logError(`[globalmenu] Process execution error: ${e}`);
        }

        try {
            let seat = Clutter.get_default_backend().get_default_seat();
            let virtualDevice = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            
            if (virtualDevice) {
                if (action === "native-open-with") {
                    let timeUs = GLib.get_monotonic_time();
                    let shiftScanCode = 42; // Shift key
                    let f10ScanCode = 68;   // F10 key
                    let hScanCode = 35;     // 'h' key for mnemonic shortcut

                    // 1. Open context right-click popup menu on selection
                    virtualDevice.notify_key(timeUs, shiftScanCode, Clutter.KeyState.PRESSED);
                    virtualDevice.notify_key(timeUs + 10, f10ScanCode, Clutter.KeyState.PRESSED);
                    virtualDevice.notify_key(timeUs + 20, f10ScanCode, Clutter.KeyState.RELEASED);
                    virtualDevice.notify_key(timeUs + 30, shiftScanCode, Clutter.KeyState.RELEASED);

                    // 2. This button owns the timeout it creates and is responsible for
                    // clearing it in destroy().
                    let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                        let timeNow = GLib.get_monotonic_time();
                        virtualDevice.notify_key(timeNow, hScanCode, Clutter.KeyState.PRESSED);
                        virtualDevice.notify_key(timeNow + 10, hScanCode, Clutter.KeyState.RELEASED);

                        this._timeoutIds = this._timeoutIds.filter(id => id !== timeoutId);
                        return GLib.SOURCE_REMOVE;
                    });

                    this._timeoutIds.push(timeoutId);

                    return true;
                }

                let modifierScanCode = 29; // Ctrl
                let actionScanCode = 0;
                let useModifier = true;
                
                if (action === "copy") actionScanCode = 46;       
                else if (action === "paste") actionScanCode = 47;  
                else if (action === "cut") actionScanCode = 45;    
                else if (action === "undo") actionScanCode = 44;   
                else if (action === "redo") actionScanCode = 21;   
                else if (action === "select-all") actionScanCode = 30; 
                else if (action === "new-tab") actionScanCode = 28;    
                else if (action === "print") actionScanCode = 25; // Ctrl + P
                else if (action === "toggle-fullscreen") {
                    useModifier = false;
                    actionScanCode = 87; // F11 key
                }
                else if (action === "go-back") {
                    modifierScanCode = 56; 
                    actionScanCode = 105;  
                }
                else if (action === "go-forward") {
                    modifierScanCode = 56; 
                    actionScanCode = 106;  
                }
                else if (action === "delete-item") {
                    useModifier = false;
                    actionScanCode = 111; // Delete key
                }
                else if (action === "virtual-open") {
                    useModifier = false;
                    actionScanCode = 28;   
                }
                else if (action === "properties") {
                    modifierScanCode = 56; // Alt + Enter (Get Info)
                    actionScanCode = 28;   
                }

                if (actionScanCode !== 0) {
                    let timeUs = GLib.get_monotonic_time();
                    if (useModifier) {
                        virtualDevice.notify_key(timeUs, modifierScanCode, Clutter.KeyState.PRESSED);
                        virtualDevice.notify_key(timeUs + 10, actionScanCode, Clutter.KeyState.PRESSED);
                        virtualDevice.notify_key(timeUs + 20, actionScanCode, Clutter.KeyState.RELEASED);
                        virtualDevice.notify_key(timeUs + 30, modifierScanCode, Clutter.KeyState.RELEASED);
                    } else {
                        virtualDevice.notify_key(timeUs, actionScanCode, Clutter.KeyState.PRESSED);
                        virtualDevice.notify_key(timeUs + 10, actionScanCode, Clutter.KeyState.RELEASED);
                    }
                    return true;
                }
            }
        } catch (e) {
            logError(`[globalmenu] Virtual Keyboard error: ${e}`);
        }

        return false;
    }

    // Sends an arbitrary GTK-style accelerator string (e.g. "<Control><Alt>t")
    // as a real key event, for user-defined custom shortcuts.
    _sendAccelerator(accel) {
        try {
            let [success, keyval, mods] = Clutter.accelerator_parse(accel);
            if (!success) {
                logError(`[globalmenu] Could not parse shortcut '${accel}'`);
                return;
            }

            let seat = Clutter.get_default_backend().get_default_seat();
            let virtualDevice = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            if (!virtualDevice) return;

            let modKeyvals = [];
            if (mods & Clutter.ModifierType.CONTROL_MASK) modKeyvals.push(Clutter.KEY_Control_L);
            if (mods & Clutter.ModifierType.SHIFT_MASK) modKeyvals.push(Clutter.KEY_Shift_L);
            if (mods & Clutter.ModifierType.MOD1_MASK) modKeyvals.push(Clutter.KEY_Alt_L);
            if (mods & Clutter.ModifierType.SUPER_MASK) modKeyvals.push(Clutter.KEY_Super_L);

            let t = GLib.get_monotonic_time();
            modKeyvals.forEach(k => {
                virtualDevice.notify_keyval(t, k, Clutter.KeyState.PRESSED);
                t += 5;
            });
            virtualDevice.notify_keyval(t, keyval, Clutter.KeyState.PRESSED);
            t += 5;
            virtualDevice.notify_keyval(t, keyval, Clutter.KeyState.RELEASED);
            t += 5;
            modKeyvals.slice().reverse().forEach(k => {
                virtualDevice.notify_keyval(t, k, Clutter.KeyState.RELEASED);
                t += 5;
            });
        } catch (e) {
            logError(`[globalmenu] Failed to send accelerator '${accel}': ${e}`);
        }
    }

    _createNewFolder() {
        try {
            let desktopPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP)
                || `${GLib.get_home_dir()}/Desktop`;
            let baseName = "Untitled Folder";
            let folderName = baseName;
            let counter = 2;
            let file = Gio.File.new_for_path(GLib.build_filenamev([desktopPath, folderName]));

            while (file.query_exists(null)) {
                folderName = `${baseName} ${counter}`;
                file = Gio.File.new_for_path(GLib.build_filenamev([desktopPath, folderName]));
                counter++;
            }

            file.make_directory(null);
        } catch (e) {
            logError(`[globalmenu] Failed to create new folder: ${e}`);
        }
    }

    // macOS renders the focused application's own name in bold and the menus
    // after it in regular weight. The shell's own theme already sets
    // font-weight: bold on every panel button, so marking the application name
    // bold achieves nothing by itself -- the rest of the bar has to be lightened
    // for it to stand out. A rule on the label wins over the weight it would
    // otherwise inherit from the button, whatever the button's own specificity.
    _setAppMenuStyle(isAppMenu) {
      if (!this._titleLabel)
        return;
      const [add, remove] = isAppMenu
        ? ['globalmenu-app-name', 'globalmenu-menu-name']
        : ['globalmenu-menu-name', 'globalmenu-app-name'];
      this._titleLabel.remove_style_class_name(remove);
      this._titleLabel.add_style_class_name(add);
    }

    // Re-point an existing button at a different window rather than destroying
    // it. Removing and re-adding panel buttons churns the status area, which is
    // visible as a flicker -- most of all on a mirrored secondary panel, which
    // re-syncs whenever the status area changes.
    setContents(label, children, appInstance = null, isAppMenu = false) {
      this._appInstance = appInstance;
      if (this._menuLabel !== label) {
        this._menuLabel = label;
        if (this._titleLabel)
          this._titleLabel.text = label;
        this.set_accessible_name(label);
      }
      this._setAppMenuStyle(isAppMenu);
      this.menu.removeAll();
      this._buildSubMenu(children, this.menu);
    }

    _buildSubMenu(menuItems, parentMenu) {
      // Ornament.HIDDEN leaves no room for a checkmark; Ornament.NONE reserves
      // the column while drawing nothing. Setting it on only the checkable
      // items therefore indents those and leaves the rest flush, and a menu
      // that mixes exported actions with window operations gets a ragged left
      // edge. Reserve the column for every item as soon as one item in the
      // menu can be checked, which is what both GNOME and macOS do.
      const reserveOrnament = menuItems.some(i => i.isCheck);
      for (const item of menuItems) {
        if (item.type === "separator") {
          parentMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        } else if (item.type === "section-header") {
          let headerItem = new PopupMenu.PopupMenuItem(item.label, { activate: false });
          headerItem.setSensitive(false);
          headerItem.label.add_style_class_name('popup-subtitle-menu-item');
          parentMenu.addMenuItem(headerItem);
        } else if (item.type === "submenu") {
          const subMenu = new PopupMenu.PopupSubMenuMenuItem(item.label, !!item.icon);
          if (item.icon) subMenu.icon.icon_name = item.icon;
          this._buildSubMenu(item.children, subMenu.menu);
          parentMenu.addMenuItem(subMenu);
        } else {
          const menuItem = item.icon
            ? new PopupMenu.PopupImageMenuItem(item.label, item.icon)
            : new PopupMenu.PopupMenuItem(item.label);
          if (reserveOrnament) {
            // A boolean-stated action is a toggle; showing its state is the
            // only way the menu reflects what the app is actually doing. Items
            // that cannot be checked still reserve the column so the labels in
            // this menu share a left edge.
            menuItem.setOrnament(item.isCheck && item.checked
              ? PopupMenu.Ornament.CHECK
              : PopupMenu.Ornament.NONE);
          }
          if (item.enabled === false) {
            menuItem.setSensitive(false);
          } else if (typeof item.activate === "function") {
            // A real action read from the application's own action group.
            menuItem.connectObject("activate", () => item.activate(), menuItem);
          } else if (item.action === "show-clipboard") {
            // connectObject with the item itself as the tracker ties this
            // signal's lifetime to the item, so it's disconnected
            // automatically when the item (and thus the menu) is destroyed.
            menuItem.connectObject("activate", () => {
              if (this._clipboardPanel) this._clipboardPanel.toggle(this);
            }, menuItem);
          } else if (item.action === "emoji-picker") {
            menuItem.connectObject("activate", () => {
              if (this._emojiPicker) this._emojiPicker.toggle(this);
            }, menuItem);
          } else if (item.action) {
            menuItem.connectObject("activate", () => {
              this._executeNativeAction(item.action);
            }, menuItem);
          }
          parentMenu.addMenuItem(menuItem);
        }
      }
    }

    destroy() {
        if (this._timeoutIds && this._timeoutIds.length > 0) {
            this._timeoutIds.forEach(id => GLib.source_remove(id));
            this._timeoutIds = [];
        }
        super.destroy();
    }
  }
);

export class MenuManager {
    constructor(uuid, settings) {
        this.uuid = uuid;
        this._settings = settings;
        this._buttons = [];
        this._appMenu = null;
        this._rebuildTimeoutId = 0;
        this._context = null;
        this._fallbackIsTransient = false;
        this._desktopClickAt = 0;

        // The click is announced a moment after focus has already been handled
        // as a transient gap, so re-evaluate rather than only recording it.
        this._dingClickId = Gio.DBus.session.signal_subscribe(
            DING_BUS_NAME, DING_BUS_NAME, DING_CLICK_SIGNAL, null, null,
            Gio.DBusSignalFlags.NONE,
            () => {
                this._desktopClickAt = GLib.get_monotonic_time();
                this.updateMenuForWindow(global.display.focus_window);
            });
        // wl-clipboard is on this list for the same reason as the rest: it is
        // not an application anyone switched to. Owning a Wayland selection
        // requires a live client with a surface, so every text selection maps
        // a short-lived toplevel that takes focus and then vanishes.
        this._blacklist = ['gjs', 'org.gnome.gjs', 'gnome-shell', 'mutter', 'io.github.shiroosl.globalmenu', 'com.desktop.ding', 'com.desktop.dingextension', 'io.github.bugaevc.wl-clipboard'];

        debugLoggingEnabled = settings.get_boolean('debug-logging');
        this._debugLoggingChangedId = settings.connect('changed::debug-logging', () => {
            debugLoggingEnabled = settings.get_boolean('debug-logging');
        });

        this._clipboardStore = new ClipboardHistoryStore(settings);
        this._clipboardStore.start();
        this._clipboardPanel = new ClipboardPanel(this._clipboardStore);
        this._emojiPicker = new EmojiPicker();
    }

    updateMenuForWindow(window) {
        let appName = this._settings.get_string('desktop-app-name') || 'Nautilus';
        let isAppFocused = false;
        let isDesktop = false;
        let desktopId = "";
        let detectedApp = null;

        if (window) {
            let windowType = window.get_window_type();

            if (windowType === 0) {
                let tracker = Shell.WindowTracker.get_default();
                detectedApp = tracker.get_window_app(window);

                let checkId = detectedApp ? (detectedApp.get_id() || "") : "";
                let checkName = detectedApp ? (detectedApp.get_name() || "") : "";
                let wmClass = window.get_wm_class() || "";
                let title = window.get_title() || "";

                let combinedIdentifiers = `${checkId} ${checkName} ${wmClass} ${title}`.toLowerCase();

                let isBlacklisted = this._blacklist.some(item =>
                    combinedIdentifiers.includes(item.toLowerCase())
                );

                if (!isBlacklisted && (detectedApp || wmClass)) {
                    if (detectedApp) {
                        appName = detectedApp.get_name();
                        desktopId = detectedApp.get_id();
                        isAppFocused = true;
                    } else if (wmClass) {
                        appName = wmClass.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                        desktopId = wmClass.toLowerCase() + ".desktop";
                        isAppFocused = true;
                    }
                } else {
                    detectedApp = null;
                    isDesktop = DESKTOP_IDENTIFIERS.some(id => combinedIdentifiers.includes(id));
                }
            }
        }

        // Everything below describes what this application can actually do
        // right now. The window carries the D-Bus coordinates of its own action
        // groups, so the menus are read from the app rather than assumed.
        let source = null;
        if (isAppFocused && window) {
            this._fallbackIsTransient = false;
            source = {
                busName: window.get_gtk_unique_bus_name(),
                appPath: window.get_gtk_application_object_path(),
                windowPath: window.get_gtk_window_object_path(),
                menubarPath: window.get_gtk_menubar_object_path(),
                appInfo: detectedApp ? detectedApp.get_app_info() : null,
                appName,
            };
        } else {
            // Nothing is focused, which is what clicking the desktop looks like
            // -- the desktop is a window owned by the desktop-icons extension
            // rather than an app the user switched to. macOS shows Finder's
            // menus there, so show the file manager's.
            source = this._fileManagerSource();
            if (source) {
                appName = source.appName;
                detectedApp = source.app || null;
            }
            // Focusing the desktop is deliberate and should switch immediately.
            // Having no focused window at all usually means an application is
            // starting, and swapping to the file manager's menus for a moment on
            // the way is just noise.
            // A desktopclick that has just arrived means this really is the
            // desktop, however the window identifiers happened to look.
            const clickedDesktop = GLib.get_monotonic_time() -
                (this._desktopClickAt || 0) < DESKTOP_CLICK_FRESH_US;
            this._fallbackIsTransient = !(isDesktop || clickedDesktop);
        }

        this._context = { appName, detectedApp, window: isAppFocused ? window : null };
        this._switchedAt = GLib.get_monotonic_time();

        if (this._appMenu) {
            this._appMenu.destroy();
            this._appMenu = null;
        }

        if (source)
            this._appMenu = new AppActionMenu(source, () => this._queueRebuild());

        this._rebuild();
    }

    // Everything here is real: the actions come from the application's own
    // .desktop file, which is also where their translated names come from, and
    // quitting goes through the shell rather than a synthesised keystroke.
    _fallbackAppMenu(app, appName) {
        if (!app)
            return null;

        const children = [];
        const info = app.get_app_info();
        if (info) {
            for (const name of info.list_actions()) {
                const label = info.get_action_name(name);
                if (!label)
                    continue;
                children.push({
                    label,
                    enabled: true,
                    activate: () => app.launch_action(name, global.get_current_time(), -1),
                });
            }
        }

        if (children.length)
            children.push({ type: 'separator' });
        children.push({
            label: `Quit ${appName}`,
            enabled: true,
            activate: () => app.request_quit(),
        });

        return { label: appName, children, isAppMenu: true };
    }

    // Whichever application handles directories -- Nautilus here, but read from
    // the user's own default rather than assumed.
    _fileManagerSource() {
        let info = null;
        try {
            info = Gio.AppInfo.get_default_for_type('inode/directory', false);
        } catch (e) {
            logError(`[globalmenu] No handler for inode/directory: ${e}`);
        }
        if (!info)
            return null;

        const app = Shell.AppSystem.get_default().lookup_app(info.get_id());
        const appName = (app ? app.get_name() : info.get_name()) || 'Files';

        // An open window carries exact coordinates, and brings the
        // window-scoped actions with it.
        const windows = app ? app.get_windows() : [];
        if (windows.length) {
            const w = windows[0];
            return {
                app,
                appName,
                busName: w.get_gtk_unique_bus_name(),
                appPath: w.get_gtk_application_object_path(),
                windowPath: w.get_gtk_window_object_path(),
                menubarPath: w.get_gtk_menubar_object_path(),
                appInfo: app.get_app_info(),
            };
        }

        // With no window open there is nothing to read the coordinates from, so
        // fall back to the GApplication convention: the bus name is the
        // application id, and the object path is that id with its dots turned
        // into slashes. Only application-scoped actions exist in this case.
        const id = info.get_id().replace(/\.desktop$/, '');
        if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_-]+)+$/.test(id))
            return null;
        return {
            app,
            appName,
            busName: id,
            appPath: '/' + id.replace(/\./g, '/').replace(/-/g, '_'),
            windowPath: null,
            menubarPath: null,
            appInfo: info,
        };
    }

    // Action groups populate asynchronously and then report every enabled-state
    // change, so an app like Nautilus emits one on each undo or redo. Rebuilding
    // the panel on each would be both wasteful and visible -- it destroys the
    // buttons, which closes whatever menu the user currently has open -- so
    // coalesce them, and never rebuild underneath an open menu.
    _queueRebuild(delayMs = REBUILD_DEBOUNCE_MS) {
        if (this._rebuildTimeoutId)
            return;
        this._rebuildTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._rebuildTimeoutId = 0;
            if (this._buttons.some(b => b.menu && b.menu.isOpen)) {
                this._queueRebuild();
                return GLib.SOURCE_REMOVE;
            }
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Real operations every window supports regardless of what it exports over
    // D-Bus, so the Window menu is never empty and never lies.
    _windowOperations(window) {
        if (!window)
            return [];
        const items = [
            { label: 'Minimise', enabled: window.can_minimize(), activate: () => window.minimize() },
            {
                label: window.is_maximized() ? 'Unmaximise' : 'Maximise',
                enabled: window.can_maximize() || window.is_maximized(),
                activate: () => window.is_maximized()
                    ? window.unmaximize(Meta.MaximizeFlags.BOTH)
                    : window.maximize(Meta.MaximizeFlags.BOTH),
            },
            {
                label: window.is_fullscreen() ? 'Leave Full Screen' : 'Enter Full Screen',
                enabled: true,
                activate: () => window.is_fullscreen() ? window.unmake_fullscreen() : window.make_fullscreen(),
            },
        ];
        if (window.can_close())
            items.push({ type: 'separator' }, { label: 'Close Window', enabled: true, activate: () => window.delete(global.get_current_time()) });
        return items;
    }

    _rebuild() {
        const { appName, detectedApp, window } = this._context || {};

        // A D-Bus action group is empty the moment it is created and fills in
        // asynchronously, so rendering straight away would show an almost empty
        // bar on every single window switch and then replace it a moment later.
        // Keep the previous menus up until the new ones have something in them,
        // which is what a Mac does when you switch applications.
        if (this._appMenu && !this._appMenu.isPopulated &&
            GLib.get_monotonic_time() - (this._switchedAt || 0) < POPULATE_GRACE_US) {
            this._queueRebuild(POPULATE_POLL_MS);
            return;
        }

        // Nothing is focused and the desktop was not clicked, so an application
        // is most likely still starting. Keep the current menus rather than
        // showing the file manager's for a moment on the way there.
        if (this._fallbackIsTransient && this._buttons.length &&
            GLib.get_monotonic_time() - (this._switchedAt || 0) < TRANSIENT_FOCUS_GRACE_US) {
            this._queueRebuild(POPULATE_POLL_MS);
            return;
        }

        let menus = this._appMenu ? this._appMenu.getMenus() : [];

        // Chrome publishes no bus name at all and Firefox publishes one with no
        // action group behind it, so neither contributes a menu -- and without
        // one, the bar does not even show the application's name. Their .desktop
        // files still advertise real, launchable actions, and the shell can
        // still quit them, so build the application menu out of those.
        if (!menus.some(m => m.isAppMenu)) {
            const fallback = this._fallbackAppMenu(detectedApp, appName);
            if (fallback)
                menus = [fallback, ...menus];
        }

        // Which top-level menus the user has switched off. The generated menus
        // reuse the shipped keys, so these settings keep working untouched.
        const enabledFor = label => {
            const key = label === appName ? 'menu-app-enabled' : `menu-${String(label).toLowerCase()}-enabled`;
            try {
                return this._settings.get_boolean(key);
            } catch (e) {
                // A menu we generated that has no corresponding setting (an app
                // with an exported menubar of its own naming) is always shown.
                return true;
            }
        };

        let menuData = menus.filter(m => enabledFor(m.label)).map(m => {
            const children = [...m.children];
            // The app's own windows are real and worth listing, and only the
            // shell knows about them -- they are not on the bus.
            if (m.isAppMenu && detectedApp) {
                const windows = detectedApp.get_windows();
                if (windows.length > 1) {
                    children.push({ type: 'separator' }, { type: 'section-header', label: 'Open Windows' });
                    windows.forEach(win => children.push({
                        label: win.get_title() || appName,
                        enabled: true,
                        activate: () => win.activate(global.get_current_time()),
                    }));
                }
            }
            return { type: 'submenu', label: m.label, children, isAppMenu: !!m.isAppMenu };
        });

        // Window operations attach to an existing Window menu, or become one.
        const wmItems = this._windowOperations(window);
        if (wmItems.length && this._settings.get_boolean('menu-window-enabled')) {
            const existing = menuData.find(m => m.label === 'Window');
            if (existing)
                existing.children.push({ type: 'separator' }, ...wmItems);
            else
                menuData.push({ type: 'submenu', label: 'Window', children: wmItems });
        }

        // The clipboard panel and the emoji picker are real, working features of
        // this extension rather than faked application verbs, and macOS keeps
        // both at the foot of its Edit menu. Neither depends on the focused app,
        // so the Edit menu is created for them when the app exports no editing
        // actions of its own.
        if (this._settings.get_boolean('menu-edit-enabled')) {
            const shellItems = [
                { label: 'Show Clipboard', action: 'show-clipboard', icon: 'edit-paste-symbolic' },
                { label: 'Emoji & Symbols', action: 'emoji-picker', icon: 'face-smile-symbolic' },
            ];
            const editMenu = menuData.find(m => m.label === 'Edit');
            if (editMenu) {
                editMenu.children.push({ type: 'separator' }, ...shellItems);
            } else {
                // Keep Edit in its usual place rather than appending it last.
                const after = ['View', 'Go', 'Window', 'Help'];
                const at = menuData.findIndex(m => after.includes(m.label));
                const entry = { type: 'submenu', label: 'Edit', children: shellItems };
                if (at === -1)
                    menuData.push(entry);
                else
                    menuData.splice(at, 0, entry);
            }
        }

        menuData.push(...this._buildCustomMenus());

        // Panel buttons are kept and refilled rather than rebuilt. Adding or
        // removing one churns the panel's status area, and the mirrored
        // secondary panels are driven off that -- a mirrored button clones its
        // source, so it follows a label or menu change for free, but a source
        // that is destroyed and replaced has to be torn down and rebuilt, which
        // is the delay and blink seen on the secondary panels and not on the
        // primary. Surplus buttons are hidden, never destroyed, so switching
        // between applications with different numbers of menus costs nothing
        // more than switching between two windows of one application.
        menuData.forEach((item, index) => {
            let btn = this._buttons[index];
            if (btn) {
                btn.setContents(item.label, item.children, detectedApp, item.isAppMenu);
                btn.show();
                return;
            }
            btn = new TopLevelMenuButton(item.label, item.children, detectedApp, this._clipboardPanel, this._emojiPicker, item.isAppMenu);
            Main.panel.addToStatusArea(`${this.uuid}-${index}`, btn, index + 1, 'left');
            this._buttons.push(btn);
        });

        for (let i = menuData.length; i < this._buttons.length; i++)
            this._buttons[i].hide();
    }


    _buildCustomMenus() {
        let raw = this._settings.get_string('custom-menus') || '[]';
        let sections = [];
        try {
            sections = JSON.parse(raw);
        } catch (e) {
            sections = [];
        }

        return sections
            .filter(section => section && section.enabled !== false)
            .map(section => {
                let items = Array.isArray(section.items) ? section.items : [];
                let children = items
                    .filter(entry => entry && entry.value)
                    .map(entry => ({
                        label: entry.label || '(untitled)',
                        action: entry.kind === 'shortcut'
                            ? `custom-shortcut:${entry.value}`
                            : `custom-command:${entry.value}`,
                    }));

                if (children.length === 0) {
                    children.push({ label: 'No items configured', enabled: false });
                }

                return { type: "submenu", label: section.label || 'Custom', children };
            });
    }

    clear() {
        this._buttons.forEach(btn => btn.destroy());
        this._buttons = [];
    }

    destroy() {
        if (this._dingClickId) {
            Gio.DBus.session.signal_unsubscribe(this._dingClickId);
            this._dingClickId = 0;
        }
        // The action groups hold signal handlers onto a live D-Bus proxy, and
        // the rebuild timeout would fire into a destroyed manager.
        if (this._rebuildTimeoutId) {
            GLib.source_remove(this._rebuildTimeoutId);
            this._rebuildTimeoutId = 0;
        }
        if (this._appMenu) {
            this._appMenu.destroy();
            this._appMenu = null;
        }
        if (this._settings && this._debugLoggingChangedId) {
            this._settings.disconnect(this._debugLoggingChangedId);
            this._debugLoggingChangedId = null;
        }
        if (this._clipboardPanel) {
            this._clipboardPanel.destroy();
            this._clipboardPanel = null;
        }
        if (this._clipboardStore) {
            this._clipboardStore.destroy();
            this._clipboardStore = null;
        }
        if (this._emojiPicker) {
            this._emojiPicker.destroy();
            this._emojiPicker = null;
        }
        this.clear();
    }
}
