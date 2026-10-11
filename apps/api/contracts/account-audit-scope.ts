import { expectTypeOf } from "bun:test";

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
expectTypeOf(accountRecorder).toEqualTypeOf<AccountAuditRecorder>();
expectTypeOf(
  createBackgroundAuditRecorder({ account }),
).toEqualTypeOf<AccountAuditRecorder>();
expectTypeOf(
  createAuditRecorder({ ...organization, ...transport }),
).toEqualTypeOf<AuditRecorder>();
expectTypeOf(
  createBackgroundAuditRecorder({
    ...organization,
    execution: {
      performer: { type: "user", id: userId },
      trigger: { type: "direct" },
    },
  }),
).toEqualTypeOf<AuditRecorder>();

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
const accountWithExecution = {
  account,
  execution: {
    performer: { type: "user", id: userId },
    trigger: { type: "direct" },
  },
} as const;
// @ts-expect-error Account scope cannot carry organization execution provenance.
createBackgroundAuditRecorder(accountWithExecution);

void accountRecorder(tx, {
  type: "account.data_export.requested",
  resourceId: "export",
});
// @ts-expect-error Account event types are enumerated.
void accountRecorder(tx, { type: "account.custom", resourceId: "export" });
void accountRecorder(tx, {
  type: "account.data_export.ready",
  resourceId: "export",
  // @ts-expect-error Account events cannot carry arbitrary metadata.
  metadata: { content: "unbounded" },
});
void accountRecorder(tx, {
  // @ts-expect-error Account events cannot carry organization resource payloads.
  action: AUDIT_ACTION.UPDATE,
  resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
  resourceId: "matter",
});
