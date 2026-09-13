import type { Result } from "better-result";

type DesktopConnectionOutcome =
  | { status: "connected"; email: string }
  | { status: "error" };

export type DesktopConnectionState =
  | DesktopConnectionOutcome
  | { status: "connecting" }
  | { status: "idle" }
  | { status: "waiting" };

const IDLE = { status: "idle" } as const satisfies DesktopConnectionState;

type DesktopConnectionStoreOptions = {
  /** Link the account to a running app with a typed failure result. */
  link: () => Promise<Result<string, unknown>>;
  /** Report a link failure; the store itself never throws into the UI. */
  onError: (error: unknown) => void;
  /** Resolve true once the local bridge answers, false when the watch ends. */
  watch: (signal: AbortSignal) => Promise<boolean>;
};

/**
 * Page-scoped state for linking the account to the desktop app.
 *
 * The store is shared rather than per component because several surfaces show
 * this at once: the onboarding step mounts its desktop panel twice (a
 * phone-only copy plus the preview column), and settings can be open alongside
 * it. They share one attempt and one watch, so every mounted surface shows the
 * same status and the account is linked once per page visit however many of
 * them are listening.
 *
 * Watching starts on a download click, never on mount: a page reaching the
 * loopback bridge unprompted costs every visitor a local-network permission
 * prompt and a poll loop for an app they may not be installing.
 */
export const createDesktopConnectionStore = ({
  link,
  onError,
  watch,
}: DesktopConnectionStoreOptions) => {
  const listeners = new Set<() => void>();
  let state: DesktopConnectionState = IDLE;
  let attempt: Promise<DesktopConnectionOutcome> | null = null;
  let watcher: AbortController | null = null;
  let consumers = 0;

  const publish = (next: DesktopConnectionState) => {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  };

  /**
   * Link a desktop app that is already running. Resolves to the outcome
   * instead of throwing. Every caller joins the one account-link attempt.
   */
  const connect = async (): Promise<DesktopConnectionOutcome> => {
    if (attempt) {
      return await attempt;
    }

    publish({ status: "connecting" });
    const started = link()
      .then(
        (result): DesktopConnectionOutcome => {
          if (result.isOk()) {
            return { status: "connected", email: result.value };
          }
          onError(result.error);
          return { status: "error" };
        },
        (error: unknown): DesktopConnectionOutcome => {
          onError(error);
          return { status: "error" };
        },
      )
      .then((outcome) => {
        if (attempt === started) {
          attempt = null;
        }
        if (outcome.status === "connected") {
          // A manual click can win while the watch is still between probes.
          // Retiring the watch here stops it from linking the same account a
          // second time and overwriting this outcome with a later failure.
          watcher?.abort();
          watcher = null;
        }
        publish(outcome);
        return outcome;
      });

    attempt = started;
    return await started;
  };

  const isConnected = () => state.status === "connected";

  /**
   * Begin watching the local bridge for an app the user is installing. Call it
   * from the download gesture; it is a no-op while a watch runs or once the
   * account is linked.
   */
  const startWatch = async () => {
    if (watcher || isConnected()) {
      return;
    }

    // Claimed synchronously, before the first await, so a second download click
    // joins this watch instead of starting one.
    const controller = new AbortController();
    watcher = controller;
    publish({ status: "waiting" });

    try {
      const reachable = await watch(controller.signal);
      if (reachable && !controller.signal.aborted && !isConnected()) {
        await connect();
      }
    } finally {
      if (watcher === controller) {
        watcher = null;
      }
      if (state.status === "waiting") {
        // The window closed (or there was nothing to watch) without a link;
        // the page must stop telling the user the app will connect itself.
        publish(IDLE);
      }
    }
  };

  const release = () => {
    consumers -= 1;
    if (consumers > 0) {
      return;
    }

    watcher?.abort();
    watcher = null;
    if (state.status === "waiting") {
      // Nothing is watching any more, so the page must not keep claiming it is.
      publish(IDLE);
    }
  };

  return {
    connect,
    getServerState: () => IDLE,
    getState: () => state,
    /**
     * Register a mounted surface. The returned release stops the watch once the
     * last surface is gone; mounting alone never touches the bridge.
     */
    retain: () => {
      consumers += 1;
      return release;
    },
    startWatch,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
