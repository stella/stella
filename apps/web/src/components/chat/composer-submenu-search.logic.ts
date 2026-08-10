const MENU_NAVIGATION_KEYS = [
  "Escape",
  "ArrowDown",
  "ArrowUp",
  "Enter",
] as const;

export const isMenuNavigationKey = (key: string): boolean =>
  MENU_NAVIGATION_KEYS.some((navigationKey) => navigationKey === key);

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
