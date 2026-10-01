const MENU_NAVIGATION_KEYS = [
  "Escape",
  "ArrowDown",
  "ArrowUp",
  "Enter",
] as const;

export const isMenuNavigationKey = (key: string): boolean =>
  MENU_NAVIGATION_KEYS.some((navigationKey) => navigationKey === key);

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
