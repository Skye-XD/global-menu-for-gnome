// Keyboard shortcuts shown beside menu items. Every menu source hands over a
// GTK accelerator string ("<Control><Shift>n"); this turns it into the label
// drawn at the right edge of the item.

// dbusmenu's "shortcut" property is a list of key combinations, each a list of
// modifier names followed by the key: [['Control', 'Shift', 'n']]. Only the
// first combination is shown, as GTK and macOS menus do.
export function fromDbusmenu(shortcut) {
    const combo = Array.isArray(shortcut) ? shortcut[0] : null;
    if (!Array.isArray(combo) || !combo.length)
        return null;
    const key = combo[combo.length - 1];
    return combo.slice(0, -1).map(m => `<${m}>`).join('') + key;
}

const MOD_NAMES = {
    control: 'Ctrl', ctrl: 'Ctrl', primary: 'Ctrl',
    shift: 'Shift',
    alt: 'Alt', mod1: 'Alt',
    super: 'Super', meta: 'Super',
};

// macOS order is Control, Option, Shift, Command. Ctrl is drawn as Command:
// that is the key this desktop's apps receive when Command is pressed.
const MAC_MODS = { Super: '⌃', Alt: '⌥', Shift: '⇧', Ctrl: '⌘' };
const MAC_ORDER = ['Super', 'Alt', 'Shift', 'Ctrl'];

const KEY_NAMES = {
    Return: ['Enter', '↩'], KP_Enter: ['Enter', '⌤'],
    BackSpace: ['Backspace', '⌫'], Delete: ['Del', '⌦'],
    Escape: ['Esc', '⎋'], Tab: ['Tab', '⇥'], space: ['Space', 'Space'],
    Left: ['Left', '←'], Right: ['Right', '→'], Up: ['Up', '↑'], Down: ['Down', '↓'],
    Page_Up: ['PgUp', '⇞'], Prior: ['PgUp', '⇞'], Page_Down: ['PgDn', '⇟'], Next: ['PgDn', '⇟'],
    Home: ['Home', '↖'], End: ['End', '↘'], Insert: ['Ins', 'Ins'],
    plus: ['+', '+'], minus: ['-', '-'], equal: ['=', '='], comma: [',', ','],
    period: ['.', '.'], slash: ['/', '/'], backslash: ['\\', '\\'],
    bracketleft: ['[', '['], bracketright: [']', ']'], semicolon: [';', ';'],
    apostrophe: ["'", "'"], grave: ['`', '`'],
    question: ['?', '?'],
};

export function formatAccel(accel, mac = false) {
    if (!accel)
        return null;
    const mods = new Set();
    const key = accel.replace(/<([^>]+)>/g, (_m, name) => {
        const mod = MOD_NAMES[name.toLowerCase()];
        if (mod)
            mods.add(mod);
        return '';
    });
    if (!key)
        return null;

    const named = KEY_NAMES[key];
    const keyLabel = named ? named[mac ? 1 : 0] : key.length === 1 ? key.toUpperCase() : key;
    if (mac)
        return MAC_ORDER.filter(m => mods.has(m)).map(m => MAC_MODS[m]).join('') + keyLabel;
    return [...['Ctrl', 'Super', 'Alt', 'Shift'].filter(m => mods.has(m)), keyLabel].join('+');
}
