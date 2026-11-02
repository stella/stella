import type { DesktopMessages } from "../i18n/index";
import type { ActivityDeletionStatus } from "./activity-types";

/** Why saved activity cannot be opened, by its deletion status. */
export const DELETION_ONLY_NOTICE = {
  available: "errorRead",
  pending: "errorRead",
  unavailable: "errorRead",
  keyMissing: "deletionOnly",
  unreadable: "unreadableEraseNotice",
  incompatible: "incompatibleActivity",
} as const satisfies Record<
  ActivityDeletionStatus,
  keyof DesktopMessages["activity"]
>;
