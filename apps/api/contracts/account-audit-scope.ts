import type { Transaction } from "@/api/db/root";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { AccountAuditRecorder, AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

declare const userId: SafeId<"user">;
declare const organizationId: SafeId<"organization">;
declare const tx: Transaction;
declare const request: Request;

const account = { userId };
const organization = { organizationId, workspaceId: null, userId };
const transport = { request, server: null };

const accountRecorder = createAuditRecorder({ account, ...transport });
accountRecorder satisfies AccountAuditRecorder;
createBackgroundAuditRecorder({ account }) satisfies AccountAuditRecorder;
createAuditRecorder({ ...organization, ...transport }) satisfies AuditRecorder;
createBackgroundAuditRecorder({
  ...organization,
  execution: {
    performer: { type: "user", id: userId },
    trigger: { type: "direct" },
  },
}) satisfies AuditRecorder;

// @ts-expect-error An audit recorder requires a scope.
createAuditRecorder(transport);
// @ts-expect-error A background recorder requires a scope.
createBackgroundAuditRecorder({});
// @ts-expect-error Account and organization scopes are mutually exclusive.
createAuditRecorder({ account, ...organization, ...transport });
// @ts-expect-error Background scopes are mutually exclusive too.
createBackgroundAuditRecorder({ account, ...organization });
// @ts-expect-error Account scope excludes matter ownership.
createBackgroundAuditRecorder({ account, workspaceId: null });
// @ts-expect-error Account scope has one authoritative user binding.
createBackgroundAuditRecorder({ account, userId });
// @ts-expect-error Account scope cannot carry organization execution provenance.
createBackgroundAuditRecorder({
  account,
  execution: {
    performer: { type: "user", id: userId },
    trigger: { type: "direct" },
  },
});

accountRecorder(tx, {
  type: "account.data_export.requested",
  resourceId: "export",
});
// @ts-expect-error Account event types are enumerated.
accountRecorder(tx, { type: "account.custom", resourceId: "export" });
accountRecorder(tx, {
  type: "account.data_export.ready",
  resourceId: "export",
  // @ts-expect-error Account events cannot carry arbitrary metadata.
  metadata: { content: "unbounded" },
});
accountRecorder(tx, {
  // @ts-expect-error Account events cannot carry organization resource payloads.
  action: AUDIT_ACTION.UPDATE,
  resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
  resourceId: "matter",
});
