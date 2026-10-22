/**
 * The clipboard shortcut as the windows see it: the shapes the native side
 * returns, and how a shortcut is labelled and read from key events. The
 * rules that accept or refuse a shortcut live in `clipboard_shortcut.rs`.
 */

export const SHORTCUT_MODIFIERS = ["control", "alt", "shift", "super"] as const;

export type ShortcutModifier = (typeof SHORTCUT_MODIFIERS)[number];

/** `code` is a W3C key code such as `KeyV`: the physical key, as the OS
 *  registers it. */
export type ShortcutKeys = {
  code: string;
  modifiers: ShortcutModifier[];
};

export const RESERVED_ACTIONS = [
  "copy",
  "paste",
  "cut",
  "undo",
  "redo",
  "selectAll",
  "quit",
  "closeWindow",
  "hide",
  "minimize",
  "appSwitcher",
  "spotlight",
  "inputSource",
  "screenshot",
  "forceQuit",
  "windowMenu",
  "start",
  "taskManager",
] as const;

type ReservedAction = (typeof RESERVED_ACTIONS)[number];

export type ShortcutRejection =
  | { reason: "needsModifier" }
  | { reason: "unsupportedKey" }
  | { action: ReservedAction; reason: "systemReserved" }
  | { reason: "windowsKeyReserved" }
  | { reason: "taken" };

type ShortcutRegistration = "active" | "paused" | "unavailable" | "managed";

export type ClipboardShortcutSnapshot = {
  defaultKeys: ShortcutKeys;
  keys: ShortcutKeys;
  registration: ShortcutRegistration;
};

export type ShortcutCheck =
  { status: "valid" } | { rejection: ShortcutRejection; status: "rejected" };

export type ShortcutUpdate =
  | { snapshot: ClipboardShortcutSnapshot; status: "saved" }
  | {
      rejection: ShortcutRejection;
      snapshot: ClipboardShortcutSnapshot;
      status: "rejected";
    };

/** Payload-free; windows re-read the snapshot. Mirrors `CHANGED_EVENT`. */
export const CLIPBOARD_SHORTCUT_CHANGED_EVENT = "clipboard-shortcut-changed";

export type DesktopPlatform = "mac" | "windows" | "other";

export const detectDesktopPlatform = (userAgent: string): DesktopPlatform => {
  if (userAgent.includes("Mac")) {
    return "mac";
  }
  if (userAgent.includes("Windows")) {
    return "windows";
  }
  return "other";
};

/** Apple's documented order (⌃⌥⇧⌘), and Windows' (Win+Ctrl+Alt+Shift). */
const MODIFIER_ORDER = {
  mac: ["control", "alt", "shift", "super"],
  other: ["super", "control", "alt", "shift"],
  windows: ["super", "control", "alt", "shift"],
} as const satisfies Record<DesktopPlatform, readonly ShortcutModifier[]>;

const MODIFIER_LABELS = {
  mac: { alt: "⌥", control: "⌃", shift: "⇧", super: "⌘" },
  other: { alt: "Alt", control: "Ctrl", shift: "Shift", super: "Super" },
  windows: { alt: "Alt", control: "Ctrl", shift: "Shift", super: "Win" },
} as const satisfies Record<DesktopPlatform, Record<ShortcutModifier, string>>;

/** Keyboards outside macOS print some modifier names in the local language
 *  (German keyboards say Strg, French Maj); macOS symbols are universal. */
const LOCAL_MODIFIER_LABELS = new Map<
  string,
  Partial<Record<ShortcutModifier, string>>
>([
  ["de", { control: "Strg", shift: "Umschalt" }],
  ["es", { shift: "Mayús" }],
  ["fr", { shift: "Maj" }],
]);

/** Modifiers that keep a shortcut from typing text, as the native rules
 *  require one of them. */
export const SHORTCUT_TRIGGER_MODIFIERS = {
  mac: ["super", "alt", "control"],
  other: ["control", "alt"],
  windows: ["control", "alt"],
} as const satisfies Record<DesktopPlatform, readonly ShortcutModifier[]>;

export const orderModifiers = (
  modifiers: readonly ShortcutModifier[],
  platform: DesktopPlatform,
): ShortcutModifier[] =>
  MODIFIER_ORDER[platform].filter((modifier) => modifiers.includes(modifier));

type ModifierLabelOptions = {
  locale: string;
  modifier: ShortcutModifier;
  platform: DesktopPlatform;
};

export const modifierLabel = ({
  locale,
  modifier,
  platform,
}: ModifierLabelOptions) => {
  const language = locale.split("-").at(0) ?? locale;
  const local =
    platform === "mac"
      ? undefined
      : LOCAL_MODIFIER_LABELS.get(language)?.[modifier];
  return local ?? MODIFIER_LABELS[platform][modifier];
};

const NAMED_KEY_LABELS = new Map<string, string>([
  ["ArrowDown", "↓"],
  ["ArrowLeft", "←"],
  ["ArrowRight", "→"],
  ["ArrowUp", "↑"],
  ["Backquote", "`"],
  ["Backslash", "\\"],
  ["Backspace", "⌫"],
  ["BracketLeft", "["],
  ["BracketRight", "]"],
  ["Comma", ","],
  ["Delete", "⌦"],
  ["End", "End"],
  ["Enter", "↩"],
  ["Equal", "="],
  ["Escape", "Esc"],
  ["Home", "Home"],
  ["Minus", "-"],
  ["PageDown", "PgDn"],
  ["PageUp", "PgUp"],
  ["Period", "."],
  ["Quote", "'"],
  ["Semicolon", ";"],
  ["Slash", "/"],
  ["Space", "Space"],
  ["Tab", "Tab"],
]);

/** The character a physical key types in the current layout, where the
 *  webview exposes it (`navigator.keyboard.getLayoutMap`). */
export type KeyboardLayout = { get: (code: string) => string | undefined };

export const keyLabel = (code: string, layout: KeyboardLayout | null) => {
  const typed = layout?.get(code);
  if (/^(?:Key[A-Z]|Digit\d)$/u.test(code)) {
    return typed ? typed.toUpperCase() : code.replace(/^(?:Key|Digit)/u, "");
  }
  return NAMED_KEY_LABELS.get(code) ?? code.replace(/^Numpad/u, "Num ");
};

type ShortcutLabelOptions = {
  keys: ShortcutKeys;
  layout: KeyboardLayout | null;
  locale: string;
  platform: DesktopPlatform;
};

/** One keycap per key, modifiers in platform order, ids stable per row. */
export const shortcutKeycaps = ({
  keys,
  layout,
  locale,
  platform,
}: ShortcutLabelOptions) => [
  ...orderModifiers(keys.modifiers, platform).map((modifier) => ({
    id: modifier,
    label: modifierLabel({ locale, modifier, platform }),
  })),
  { id: "key", label: keyLabel(keys.code, layout) },
];

/** One string for a shortcut inside a sentence: `⇧⌘V`, `Ctrl+Shift+V`. */
export const formatShortcut = (options: ShortcutLabelOptions) =>
  shortcutKeycaps(options)
    .map((cap) => cap.label)
    .join(options.platform === "mac" ? "" : "+");

export const sameShortcut = (left: ShortcutKeys, right: ShortcutKeys) =>
  left.code === right.code &&
  SHORTCUT_MODIFIERS.every(
    (modifier) =>
      left.modifiers.includes(modifier) === right.modifiers.includes(modifier),
  );

const MODIFIER_KEYS = new Map<string, ShortcutModifier>([
  ["Alt", "alt"],
  ["AltGraph", "alt"],
  ["Control", "control"],
  ["Meta", "super"],
  ["OS", "super"],
  ["Shift", "shift"],
]);

/** The modifier a `KeyboardEvent.key` names, or `null` for any other key. */
export const modifierOfKey = (key: string): ShortcutModifier | null =>
  MODIFIER_KEYS.get(key) ?? null;

/** The modifiers a key event reports as held, read from the event's own
 *  flags so a modifier pressed before the window had focus still counts. */
export const heldModifiers = (event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): ShortcutModifier[] =>
  SHORTCUT_MODIFIERS.filter(
    (modifier) =>
      ({
        alt: event.altKey,
        control: event.ctrlKey,
        shift: event.shiftKey,
        super: event.metaKey,
      })[modifier],
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isShortcutModifier = (value: unknown): value is ShortcutModifier =>
  typeof value === "string" &&
  (SHORTCUT_MODIFIERS as readonly string[]).includes(value);

const isReservedAction = (value: unknown): value is ReservedAction =>
  typeof value === "string" &&
  (RESERVED_ACTIONS as readonly string[]).includes(value);

const isShortcutKeys = (value: unknown): value is ShortcutKeys =>
  isRecord(value) &&
  typeof value["code"] === "string" &&
  Array.isArray(value["modifiers"]) &&
  value["modifiers"].every(isShortcutModifier);

const isShortcutRejection = (value: unknown): value is ShortcutRejection => {
  if (!isRecord(value)) {
    return false;
  }
  switch (value["reason"]) {
    case "needsModifier":
    case "unsupportedKey":
    case "windowsKeyReserved":
    case "taken":
      return true;
    case "systemReserved":
      return isReservedAction(value["action"]);
    default:
      return false;
  }
};

export const isClipboardShortcutSnapshot = (
  value: unknown,
): value is ClipboardShortcutSnapshot =>
  isRecord(value) &&
  isShortcutKeys(value["keys"]) &&
  isShortcutKeys(value["defaultKeys"]) &&
  (value["registration"] === "active" ||
    value["registration"] === "paused" ||
    value["registration"] === "unavailable" ||
    value["registration"] === "managed");

export const isShortcutCheck = (value: unknown): value is ShortcutCheck =>
  isRecord(value) &&
  (value["status"] === "valid" ||
    (value["status"] === "rejected" &&
      isShortcutRejection(value["rejection"])));

export const isShortcutUpdate = (value: unknown): value is ShortcutUpdate =>
  isRecord(value) &&
  isClipboardShortcutSnapshot(value["snapshot"]) &&
  (value["status"] === "saved" ||
    (value["status"] === "rejected" &&
      isShortcutRejection(value["rejection"])));
