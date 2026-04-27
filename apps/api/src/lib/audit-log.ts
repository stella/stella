import type { Transaction } from "@/api/db";
import { auditLogs } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export const AUDIT_ACTION = {
  CREATE: "create",
  UPDATE: "update",
  DELETE: "delete",
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

export const AUDIT_RESOURCE_TYPE = {
  ENTITY: "entity",
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
};

type AuditEntry = AuditContext & {
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string;
  changes?: AuditChanges | null;
};

const firstForwardedIp = (forwardedFor: string | null): string | null => {
  if (!forwardedFor) {
    return null;
  }

  const first = forwardedFor.split(",").at(0)?.trim();
  return first && first.length > 0 ? first : null;
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
}: CreateAuditContextOptions): AuditContext => {
  const forwardedFor = nullableHeader(request.headers, "x-forwarded-for");
  const realIp = nullableHeader(request.headers, "x-real-ip");
  const cloudflareIp = nullableHeader(request.headers, "cf-connecting-ip");

  return {
    organizationId,
    workspaceId,
    userId,
    metadata: {
      ipAddress: cloudflareIp ?? realIp ?? firstForwardedIp(forwardedFor),
      forwardedFor,
      userAgent: nullableHeader(request.headers, "user-agent"),
    },
  };
};

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
