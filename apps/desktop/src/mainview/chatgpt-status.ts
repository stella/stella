import { panic } from "better-result";

/**
 * The ChatGPT connection as the native side reports it
 * (`chatgpt_auth::ChatGptStatus`). It never carries a token.
 */

export const CHATGPT_AUTH_CHANGED_EVENT = "chatgpt-auth-changed";
export const CHATGPT_FAILURES = [
  "declined",
  "plan_usage_not_granted",
  "different_account",
  "state_mismatch",
  "timed_out",
  "browser_unavailable",
  "callback_unavailable",
  "registration_incomplete",
  "code_expired",
  "verification",
  "client_rejected",
  "unreachable",
  "storage",
] as const;

export type ChatGptFailure = (typeof CHATGPT_FAILURES)[number];

export type ChatGptStatus = ChatGptState & {
  /** Tokens are stored on this computer, so Disconnect is offered. */
  sessionStored: boolean;
  /** Other accounts signed in before, to switch back to. */
  accounts: ChatGptAccount[];
};

type ChatGptAccount = { id: string; email: string };

/** Which account a sign-in is for: the saved one, a new one, or `account`. */
export type ChatGptSignIn = { newAccount: boolean; account?: string };

type ChatGptState =
  | { state: "signed_out" }
  | { state: "signing_in" }
  | { state: "connected"; email: string | null; plan: string | null }
  | { state: "needs_reconnect"; email: string | null }
  | { state: "failed"; reason: ChatGptFailure };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOptionalString = (value: unknown) =>
  value === null || typeof value === "string";

const isFailure = (value: unknown): value is ChatGptFailure =>
  CHATGPT_FAILURES.some((failure) => failure === value);

const isAccount = (value: unknown): value is ChatGptAccount =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["email"] === "string";

export const isChatGptStatus = (value: unknown): value is ChatGptStatus => {
  if (
    !isRecord(value) ||
    typeof value["sessionStored"] !== "boolean" ||
    !Array.isArray(value["accounts"]) ||
    !value["accounts"].every(isAccount)
  ) {
    return false;
  }
  switch (value["state"]) {
    case "signed_out":
    case "signing_in": {
      return true;
    }
    case "connected": {
      return (
        isOptionalString(value["email"]) && isOptionalString(value["plan"])
      );
    }
    case "needs_reconnect": {
      return isOptionalString(value["email"]);
    }
    case "failed": {
      return isFailure(value["reason"]);
    }
    default: {
      return false;
    }
  }
};

/** A native command's error code, when it rejected with one. */
export const chatGptCommandError = (error: unknown) =>
  typeof error === "string" ? error : null;

/**
 * The sign-in a `stella://settings/agents?harness=codex` link starts: the
 * card's own "Continue as" when it offers exactly one, otherwise "Continue
 * with ChatGPT". `null` while ChatGPT is connected or a sign-in already runs,
 * when the link only brings the card into view.
 */
export const chatGptLinkSignIn = (
  status: ChatGptStatus,
): ChatGptSignIn | null => {
  switch (status.state) {
    case "connected":
    case "signing_in":
      return null;
    case "signed_out":
    case "needs_reconnect":
    case "failed": {
      const [only, ...others] = status.accounts;
      return only !== undefined && others.length === 0
        ? { account: only.id, newAccount: false }
        : { newAccount: false };
    }
    default:
      status satisfies never;
      return panic("Unknown ChatGPT state");
  }
};
