import type { Transaction } from "@/api/db";
import { auditLogs } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { resolveClientIp } from "@/api/lib/client-ip";

type ServerLike = {
  requestIP: (request: Request) => { address: string } | null;
};

export const AUDIT_ACTION = {
  CREATE: "create",
  UPDATE: "update",
  DELETE: "delete",
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

export const AUDIT_RESOURCE_TYPE = {
  AGENT_SKILL: "agent_skill",
  ENTITY: "entity",
  ORGANIZATION_SETTINGS: "organization_settings",
  WORKSPACE: "workspace",
  PROPERTY: "property",
} as const;

export type AuditResourceType =
  (typeof AUDIT_RESOURCE_TYPE)[keyof typeof AUDIT_RESOURCE_TYPE];

type AuditMetadata = Record<string, unknown>;
type AuditChanges = Record<string, unknown>;

export type AuditContext = {
  organizationId: SafeId<"organization">;
  workspaceId?: SafeId<"workspace"> | null;
  userId: SafeId<"user">;
  metadata: AuditMetadata;
};

type CreateAuditContextOptions = {
  organizationId: SafeId<"organization">;
  workspaceId?: SafeId<"workspace"> | null;
  userId: SafeId<"user">;
  request: Request;
  server: ServerLike | null;
};

type AuditEntry = AuditContext & {
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string;
  changes?: AuditChanges | null;
};

const nullableHeader = (headers: Headers, name: string): string | null => {
  const value = headers.get(name);
  return value && value.length > 0 ? value : null;
};

export const createAuditContext = ({
  organizationId,
  workspaceId = null,
  userId,
  request,
  server,
}: CreateAuditContextOptions): AuditContext => ({
  organizationId,
  workspaceId,
  userId,
  metadata: {
    ipAddress: resolveClientIp(request, server),
    // The raw forwarded-for chain stays in metadata for forensic
    // inspection, even though `ipAddress` only trusts it when the
    // socket peer is in the configured proxy set.
    forwardedFor: nullableHeader(request.headers, "x-forwarded-for"),
    userAgent: nullableHeader(request.headers, "user-agent"),
  },
});

export const writeAuditLog = async (
  entry: AuditEntry | AuditEntry[],
  tx: Transaction,
) => {
  const entries = Array.isArray(entry) ? entry : [entry];

  if (entries.length === 0) {
    return;
  }

  await tx.insert(auditLogs).values(
    entries.map((e) => ({
      organizationId: e.organizationId,
      workspaceId: e.workspaceId ?? null,
      userId: e.userId,
      action: e.action,
      resourceType: e.resourceType,
      resourceId: e.resourceId,
      metadata: e.metadata,
      changes: e.changes ?? null,
    })),
  );
};
