const MENU_NAVIGATION_KEYS = [
  "Escape",
  "ArrowDown",
  "ArrowUp",
  "Enter",
] as const;

export const isMenuNavigationKey = (key: string): boolean =>
  MENU_NAVIGATION_KEYS.some((navigationKey) => navigationKey === key);

const MENU_ITEM_ROLES = [
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
] as const;

type TabPickOptions = {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  targetRole: string | null;
};

/** A plain Tab on a highlighted (focused) menu row picks it, as Enter does;
 *  Shift+Tab and modified Tabs keep moving focus. */
export const isTabPick = ({
  altKey,
  ctrlKey,
  key,
  metaKey,
  shiftKey,
  targetRole,
}: TabPickOptions): boolean =>
  key === "Tab" &&
  !altKey &&
  !ctrlKey &&
  !metaKey &&
  !shiftKey &&
  MENU_ITEM_ROLES.some((role) => role === targetRole);

/** Backspace in an empty shortcut search erases the trigger character the
 *  field stands in for, which closes the shortcut popup. */
export const isTriggerErase = (key: string, value: string): boolean =>
  key === "Backspace" && value === "";

export const POPUP_KEY_ROUTE = {
  eraseTrigger: "erase-trigger",
  menu: "menu",
  search: "search",
} as const;

export type PopupKeyRoute =
  (typeof POPUP_KEY_ROUTE)[keyof typeof POPUP_KEY_ROUTE];

type RoutePopupKeyOptions = {
  /** The keystroke's `typedCharacter` (`@stll/ui/typed-character`). */
  character: string | null;
  hasTrigger: boolean;
  key: string;
  /** The search field's current text. */
  value: string;
};

/**
 * Where a key pressed in the popup outside its search field belongs. Base UI
 * menus move DOM focus to a hovered row (and to the popup when the pointer
 * leaves it), so a row can hold focus while the user is still typing a query.
 * Editing keys belong to the field: a typed character or a deletion goes
 * back to it, and Backspace with nothing left to delete erases the trigger
 * exactly as it does in the field. Space, named keys, command chords and IME
 * composition stay with the menu, where Space activates the highlighted row.
 */
export const routePopupKey = ({
  character,
  hasTrigger,
  key,
  value,
}: RoutePopupKeyOptions): PopupKeyRoute => {
  if (hasTrigger && isTriggerErase(key, value)) {
    return POPUP_KEY_ROUTE.eraseTrigger;
  }
  if (key === "Backspace" || key === "Delete") {
    return POPUP_KEY_ROUTE.search;
  }
  if (character === null || character === " ") {
    return POPUP_KEY_ROUTE.menu;
  }
  return POPUP_KEY_ROUTE.search;
};

type FocusableRef = {
  current: { focus: () => void } | null;
};

type FocusScheduler = {
  clearTimeout: (timeoutId: number) => void;
  setTimeout: (callback: () => void, delay: number) => number;
};

export const scheduleSearchFocus = ({
  ref,
  scheduler,
}: {
  ref: FocusableRef;
  scheduler: FocusScheduler;
}) => {
  const timeoutId = scheduler.setTimeout(() => ref.current?.focus(), 0);
  return () => {
    scheduler.clearTimeout(timeoutId);
  };
};
