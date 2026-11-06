/**
 * The managed Claude Code CLI's sign-in as the native side reports it
 * (`claude_code_auth::ClaudeCodeStatus`). It never carries a credential or
 * the sign-in link.
 */

export const CLAUDE_CODE_AUTH_CHANGED_EVENT = "claude-code-auth-changed";
export const CLAUDE_CODE_FAILURES = [
  "not_completed",
  "timed_out",
  "unavailable",
] as const;

export type ClaudeCodeFailure = (typeof CLAUDE_CODE_FAILURES)[number];

export type ClaudeCodeStatus =
  | { state: "not_installed" }
  | { state: "signed_out" }
  | { state: "signing_in"; signInPage: boolean }
  | { state: "signed_in"; email: string | null; plan: string | null }
  | { state: "api_key" }
  | { state: "failed"; reason: ClaudeCodeFailure };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOptionalString = (value: unknown) =>
  value === null || typeof value === "string";

const isFailure = (value: unknown): value is ClaudeCodeFailure =>
  CLAUDE_CODE_FAILURES.some((failure) => failure === value);

export const isClaudeCodeStatus = (
  value: unknown,
): value is ClaudeCodeStatus => {
  if (!isRecord(value)) {
    return false;
  }
  switch (value["state"]) {
    case "not_installed":
    case "signed_out":
    case "api_key": {
      return true;
    }
    case "signing_in": {
      return typeof value["signInPage"] === "boolean";
    }
    case "signed_in": {
      return (
        isOptionalString(value["email"]) && isOptionalString(value["plan"])
      );
    }
    case "failed": {
      return isFailure(value["reason"]);
    }
    default: {
      return false;
    }
  }
};
