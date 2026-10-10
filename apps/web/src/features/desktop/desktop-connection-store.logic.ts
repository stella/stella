import type { Result } from "better-result";

export type DesktopLinkOutcome =
  | { status: "connected"; email: string }
  | { status: "started" }
  | { status: "update-required" };

type DesktopConnectionOutcome = DesktopLinkOutcome | { status: "error" };

export type DesktopConnectionState =
  | Exclude<DesktopConnectionOutcome, { status: "started" }>
  | { status: "connecting" }
  | { status: "idle" };

const IDLE = { status: "idle" } as const satisfies DesktopConnectionState;

type DesktopConnectionStoreOptions = {
  /** Link the account to a running app with a typed failure result. */
  link: () => Promise<Result<DesktopLinkOutcome, unknown>>;
  /** Report a link failure; the store itself never throws into the UI. */
  onError: (error: unknown) => void;
};

/** Shared state lets multiple surfaces join the same explicit connection attempt. */
export const createDesktopConnectionStore = ({
  link,
  onError,
}: DesktopConnectionStoreOptions) => {
  const listeners = new Set<() => void>();
  let state: DesktopConnectionState = IDLE;
  let attempt: Promise<DesktopConnectionOutcome> | null = null;

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
            return result.value;
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
        publish(outcome.status === "started" ? IDLE : outcome);
        return outcome;
      });

    attempt = started;
    return await started;
  };

  return {
    connect,
    getServerState: () => IDLE,
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
