import type { SafeId } from "@/api/lib/branded-types";
import { resolveClientIp } from "@/api/lib/client-ip";

import { createAccountRecorder, recordAuditGroups } from "./db/audit-recording";
import type {
  AccountAuditBindings,
  AccountAuditRecorder,
  AsyncAuditRecorder,
  AuditExecutionContext,
} from "./db/audit-recording";

export {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  ORGANIZATION_AUDIT_LOG_RESOURCE_ID,
  CONTACT_DIRECTORY_AUDIT_RESOURCE_ID,
  auditEventChanges,
  recordAuditGroups,
  createBackgroundAuditRecorder,
  searchHistoryAuditEvent,
} from "./db/audit-recording";
export type {
  AccountAuditRecorder,
  AsyncAuditRecorder,
  AuditAction,
  AuditResourceType,
  NonChatAuditResourceType,
  FieldDiffs,
  AuditActivityCategory,
  AuditExecutionContext,
  AuditEvent,
  AuditRecorder,
} from "./db/audit-recording";

type ServerLike = {
  requestIP: (request: Request) => { address: string } | null;
};
type OrganizationAuditRecorderBindings = {
  account?: never;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace"> | null;
  userId: SafeId<"user">;
  request: Request;
  server: ServerLike | null;
  execution?: AuditExecutionContext;
};

const nullableHeader = (headers: Headers, name: string): string | null => {
  const value = headers.get(name);
  return value && value.length > 0 ? value : null;
};

const baseRequestMetadata = (request: Request, server: ServerLike | null) => ({
  ipAddress: resolveClientIp(request, server),
  // The raw forwarded-for chain stays in metadata for forensic
  // inspection, even though `ipAddress` only trusts it when the
  // socket peer is in the configured proxy set.
  forwardedFor: nullableHeader(request.headers, "x-forwarded-for"),
  userAgent: nullableHeader(request.headers, "user-agent"),
});

const createOrganizationAuditRecorder = (
  bindings: OrganizationAuditRecorderBindings,
): AsyncAuditRecorder => {
  const requestMetadata = baseRequestMetadata(
    bindings.request,
    bindings.server,
  );
  return async (tx, event) => {
    await recordAuditGroups({
      tx,
      requestMetadata,
      groups: [
        {
          bindings: {
            organizationId: bindings.organizationId,
            workspaceId: bindings.workspaceId,
            userId: bindings.userId,
            execution: bindings.execution ?? {
              performer: { type: "user", id: bindings.userId },
              trigger: { type: "direct" },
            },
          },
          events: Array.isArray(event) ? event : [event],
        },
      ],
    });
  };
};

type AccountRequestAuditBindings = AccountAuditBindings & {
  request: Request;
  server: ServerLike | null;
};

/** Bind exactly one owning scope from authenticated server context. */
export function createAuditRecorder(
  bindings: AccountRequestAuditBindings,
): AccountAuditRecorder;
export function createAuditRecorder(
  bindings: OrganizationAuditRecorderBindings,
): AsyncAuditRecorder;
export function createAuditRecorder(
  bindings: OrganizationAuditRecorderBindings | AccountRequestAuditBindings,
): AsyncAuditRecorder | AccountAuditRecorder {
  if (bindings.account !== undefined) {
    return createAccountRecorder(
      bindings,
      baseRequestMetadata(bindings.request, bindings.server),
    );
  }
  return createOrganizationAuditRecorder(bindings);
}
