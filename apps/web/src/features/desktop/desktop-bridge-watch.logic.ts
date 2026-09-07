/** Gap between two reachability probes while the user installs the app. */
const DESKTOP_BRIDGE_WATCH_INTERVAL_MS = 3000;
/** Budget for the whole watch, long enough to cover a download and install. */
const DESKTOP_BRIDGE_WATCH_TIMEOUT_MS = 900_000;

const waitUnlessAborted = async (
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> => {
  // An `abort` listener never fires on an already-aborted signal, so a signal
  // aborted during the probe has to short-circuit here.
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const settled = new AbortController();
    const finish = () => {
      settled.abort();
      resolve();
    };

    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        finish();
      },
      { signal: settled.signal },
    );
  });
};

type WatchForDesktopBridgeOptions = {
  intervalMs?: number;
  /** Injected in tests; production reads the wall clock. */
  now?: () => number;
  /** Lightweight reachability probe; resolves false instead of throwing. */
  probe: (signal: AbortSignal) => Promise<boolean>;
  signal: AbortSignal;
  timeoutMs?: number;
};

/**
 * Poll the local desktop bridge until it answers. Resolves true on the first
 * answer and false once the watch window closes or the caller aborts, so a
 * caller links the account exactly once and never probes after that.
 *
 * The window is wall-clock: a slow probe spends the budget it takes, and the
 * caller's signal reaches the probe so an abort cancels the request in flight.
 */
export const watchForDesktopBridge = async ({
  intervalMs = DESKTOP_BRIDGE_WATCH_INTERVAL_MS,
  now = Date.now,
  probe,
  signal,
  timeoutMs = DESKTOP_BRIDGE_WATCH_TIMEOUT_MS,
}: WatchForDesktopBridgeOptions): Promise<boolean> => {
  const deadline = now() + timeoutMs;

  while (!signal.aborted && now() < deadline) {
    if (await probe(signal)) {
      return true;
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      break;
    }

    await waitUnlessAborted(Math.min(intervalMs, remaining), signal);
  }

  return false;
};
