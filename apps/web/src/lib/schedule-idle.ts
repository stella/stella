type ScheduleIdleOptions = IdleRequestOptions & {
  browser?: Window;
};

/** Schedule background work even in browsers without the idle callback API. */
export const scheduleIdle = (
  callback: () => void,
  { browser = window, timeout }: ScheduleIdleOptions = {},
): (() => void) => {
  if (typeof browser.requestIdleCallback === "function") {
    const handle = browser.requestIdleCallback(callback, { timeout });
    return () => browser.cancelIdleCallback(handle);
  }

  const handle = browser.setTimeout(callback, timeout ?? 0);
  return () => browser.clearTimeout(handle);
};
