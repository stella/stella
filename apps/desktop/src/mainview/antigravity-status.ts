/**
 * Status of the member-installed Antigravity CLI as the native side reports it
 * (`desktop_runner::member_agents::AntigravityCliStatus`). The sign-in is the
 * CLI's own answer to the run probe.
 */

/** Why the CLI's sign-in could not be asked about. */
export type AntigravityUncheckedReason = "not_connected" | "check_failed";

export type AntigravityStatus =
  | { state: "not_installed" }
  | { state: "too_old"; version: string }
  | { state: "signed_out"; version: string }
  | { state: "signed_in"; version: string }
  | {
      state: "unchecked";
      version: string;
      reason: AntigravityUncheckedReason;
    };

const UNCHECKED_REASONS: ReadonlySet<unknown> =
  new Set<AntigravityUncheckedReason>(["not_connected", "check_failed"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isAntigravityStatus = (
  value: unknown,
): value is AntigravityStatus => {
  if (!isRecord(value)) {
    return false;
  }
  switch (value["state"]) {
    case "not_installed":
      return true;
    case "too_old":
    case "signed_out":
    case "signed_in":
      return typeof value["version"] === "string";
    case "unchecked":
      return (
        typeof value["version"] === "string" &&
        UNCHECKED_REASONS.has(value["reason"])
      );
    default:
      return false;
  }
};
