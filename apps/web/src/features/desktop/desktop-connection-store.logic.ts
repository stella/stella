import { panic } from "better-result";
import type { Result } from "better-result";

import type { DesktopLinkFailure } from "@stll/api-contract/desktop-rpc";

/**
 * How the page may answer a desktop challenge: after the person's own click,
 * or on its own once the app on this computer proved the challenge is its
 * own. Without that proof the page keeps asking for the click.
 */
export type DesktopLinkApproval = "explicit" | "local-proof";

/**
 * Why the app refused a link, for the refusals the page names with their own
 * next step. An update has its own outcome; an unclassified failure is an
 * error.
 */
export type DesktopLinkRefusal = Extract<
  DesktopLinkFailure,
  "account_conflict" | "switch_declined" | "declined"
>;

export type DesktopLinkOutcome =
  | { status: "connected"; email: string }
  | { status: "started" }
  | { status: "approval-required" }
  | { status: "update-required" }
  | { status: "refused"; reason: DesktopLinkRefusal };

/**
 * How linking the account to the app ended: an outcome, or the failure the
 * link reported. Named, so no caller infers it from the link's body.
 */
export type DesktopLinkResult = Result<DesktopLinkOutcome, unknown>;

type DesktopConnectionOutcome = DesktopLinkOutcome | { status: "error" };

export type DesktopConnectionState =
  | Exclude<
      DesktopConnectionOutcome,
      { status: "started" } | { status: "approval-required" }
    >
  | { status: "connecting"; approval: DesktopLinkApproval }
  | { status: "opening"; desktopUrl: string }
  | { status: "idle" };

const IDLE = { status: "idle" } as const satisfies DesktopConnectionState;

type DesktopLinkOptions = {
  approval: DesktopLinkApproval;
  onDesktopOpening: (desktopUrl: string) => void;
};

type DesktopConnectionStoreOptions = {
  /** Link the account to a running app with a typed failure result. */
  link: (options: DesktopLinkOptions) => Promise<DesktopLinkResult>;
  /** Report a link failure; the store itself never throws into the UI. */
  onError: (error: unknown) => void;
  /** Ask the app to switch to this account; it confirms in its own window. */
  requestSwitch: () => void;
};

/** Shared state lets multiple surfaces join the same connection attempt. */
export const createDesktopConnectionStore = ({
  link,
  onError,
  requestSwitch,
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
  const connect = async (
    approval: DesktopLinkApproval,
  ): Promise<DesktopConnectionOutcome> => {
    if (attempt) {
      return await attempt;
    }

    publish({ status: "connecting", approval });
    let live = true;
    const started = link({
      approval,
      onDesktopOpening: (desktopUrl) => {
        if (live) {
          publish({ status: "opening", desktopUrl });
        }
      },
    })
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
        live = false;
        if (attempt === started) {
          attempt = null;
        }
        publish(settledState(outcome));
        return outcome;
      });

    attempt = started;
    return await started;
  };

  /**
   * Asks the app that refused this account to switch to it. The app asks the
   * member to confirm and reports back on the page it opens, so this page
   * drops the refusal it showed.
   */
  const switchAccount = () => {
    if (attempt) {
      return;
    }
    publish(IDLE);
    requestSwitch();
  };

  return {
    connect,
    switchAccount,
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

/** Outcomes that leave the next step to the person read as idle. */
function settledState(
  outcome: DesktopConnectionOutcome,
): DesktopConnectionState {
  switch (outcome.status) {
    case "started":
    case "approval-required":
      return IDLE;
    case "connected":
    case "update-required":
    case "refused":
    case "error":
      return outcome;
    default:
      outcome satisfies never;
      return panic("Unhandled desktop connection outcome");
  }
}
