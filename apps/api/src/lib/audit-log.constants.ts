export {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  type AuditAction,
  type AuditResourceType,
} from "@stll/api-contract/audit-log";

/** Account events describe the export lifecycle without carrying export contents. */
export const ACCOUNT_AUDIT_EVENT_TYPES = [
  "account.data_export.requested",
  "account.data_export.ready",
  "account.data_export.downloaded",
  "account.data_export.expired",
] as const;

export type AccountAuditEventType = (typeof ACCOUNT_AUDIT_EVENT_TYPES)[number];
