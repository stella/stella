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
