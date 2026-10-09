import type { SafeId } from "@/api/lib/branded-types";
import { resolveClientIp } from "@/api/lib/client-ip";

import { recordAuditGroups } from "./db/audit-recording";
import type {
  AuditExecutionContext,
  AuditRecorder,
} from "./db/audit-recording";

export {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  ORGANIZATION_AUDIT_LOG_RESOURCE_ID,
  CONTACT_DIRECTORY_AUDIT_RESOURCE_ID,
  auditEventChanges,
  recordAuditGroups,
  createBackgroundAuditRecorder,
} from "./db/audit-recording";
export type {
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
type AuditMetadata = Record<string, unknown>;
type AuditRecorderBindings = {
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

const baseRequestMetadata = (
  request: Request,
  server: ServerLike | null,
): AuditMetadata => ({
  ipAddress: resolveClientIp(request, server),
  // The raw forwarded-for chain stays in metadata for forensic
  // inspection, even though `ipAddress` only trusts it when the
  // socket peer is in the configured proxy set.
  forwardedFor: nullableHeader(request.headers, "x-forwarded-for"),
  userAgent: nullableHeader(request.headers, "user-agent"),
});

export const createAuditRecorder = (
  bindings: AuditRecorderBindings,
): AuditRecorder => {
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
