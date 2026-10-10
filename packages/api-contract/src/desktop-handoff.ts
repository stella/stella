export const DESKTOP_HANDOFF_PROTOCOL_HEADER = "X-Stella-Desktop-Protocol";
export const DESKTOP_HANDOFF_PROTOCOL_VERSION = 1;
export const DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL = 1;

export const DESKTOP_HANDOFF_FAILURE = {
  updateRequired: "desktop_update_required",
  accountRequired: "desktop_account_required",
} as const;

export const DESKTOP_HANDOFF_FAILURE_REASONS = [
  DESKTOP_HANDOFF_FAILURE.updateRequired,
  DESKTOP_HANDOFF_FAILURE.accountRequired,
] as const;

export type DesktopHandoffFailureReason =
  (typeof DESKTOP_HANDOFF_FAILURE)[keyof typeof DESKTOP_HANDOFF_FAILURE];
