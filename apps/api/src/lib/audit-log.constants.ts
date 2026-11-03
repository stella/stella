export {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  type AuditAction,
  type AuditResourceType,
} from "@stll/api-contract/audit-log";

export const ORGANIZATION_EVALUATION_STARTED_EVENT_TYPE =
  "organization.evaluation.started";

/** Account events record lifecycle changes without carrying private contents. */
export const ACCOUNT_AUDIT_EVENT_TYPES = [
  "account.data_export.requested",
  "account.data_export.ready",
  "account.data_export.downloaded",
  "account.data_export.expired",
  "account.sign_in_method.disconnected",
  "organization.created",
  ORGANIZATION_EVALUATION_STARTED_EVENT_TYPE,
] as const;

export type AccountAuditEventType = (typeof ACCOUNT_AUDIT_EVENT_TYPES)[number];
