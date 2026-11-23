/**
 * Status of the member-installed Antigravity CLI as the native side reports it
 * (`desktop_runner::member_agents::AntigravityCliStatus`).
 */

export type AntigravityStatus =
  | { state: "not_installed" }
  | { state: "too_old"; version: string }
  | { state: "signed_out"; version: string }
  | { state: "signed_in"; version: string };

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
    default:
      return false;
  }
};
