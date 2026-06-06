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
  DOWNLOAD: "download",
  EXECUTE: "execute",
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

export const AUDIT_RESOURCE_TYPE = {
  AGENT_SKILL: "agent_skill",
  BILLING_CODE: "billing_code",
  CASE_LAW_MATTER_LINK: "case_law_matter_link",
  CHAT_FILE: "chat_file",
  CHAT_MESSAGE: "chat_message",
  CHAT_THREAD: "chat_thread",
  CLAUSE: "clause",
  CLAUSE_CATEGORY: "clause_category",
  CLAUSE_TEMPLATE_LINK: "clause_template_link",
  CLAUSE_VARIANT: "clause_variant",
  CONTACT: "contact",
  USAGE_ALLOCATION: "usage_allocation",
  USAGE_ENTITLEMENT: "usage_entitlement",
  USAGE_EVENT: "usage_event",
  DESKTOP_EDIT_SESSION: "desktop_edit_session",
  ENTITY: "entity",
  ENTITY_VERSION: "entity_version",
  EXPENSE: "expense",
  FIELD: "field",
  FOLIO_COLLAB_SESSION: "folio_collab_session",
  INVOICE: "invoice",
  MCP_GATEWAY_TOOL: "mcp_gateway_tool",
  ORGANIZATION_SETTINGS: "organization_settings",
  PROMPT_SHORTCUT: "prompt_shortcut",
  PROPERTY: "property",
  RATE_ENTRY: "rate_entry",
  RATE_TABLE: "rate_table",
  TEMPLATE: "template",
  TIME_ENTRY: "time_entry",
  USER_FILE: "user_file",
  VIEW: "view",
  VIEW_TEMPLATE: "view_template",
  WORKSPACE: "workspace",
  WORKSPACE_CONTACT: "workspace_contact",
  WORKSPACE_MEMBER: "workspace_member",
} as const;

export type AuditResourceType =
  (typeof AUDIT_RESOURCE_TYPE)[keyof typeof AUDIT_RESOURCE_TYPE];

// Generic field-diff shape. Every existing audit payload in the
// codebase is `{ [field]: { old, new } }` — see entities/move.ts,
// properties/update-by-id.ts, etc. Codifying it here gives audit
// rows a documented contract without forcing per-event schemas.
export type FieldDiffs = Record<string, { old: unknown; new: unknown }>;

type AuditMetadata = Record<string, unknown>;

export type AuditEvent = {
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string;
  changes?: FieldDiffs | null;
  // Merged onto the base request metadata (IP, UA, forwardedFor).
  // Use for non-diff context (download s3Key, fileName, etc.).
  metadata?: AuditMetadata;
  // Overrides the recorder's bound workspaceId. Required when the
  // handler is root-scoped (no ctx.workspaceId) or operates on a
  // workspace other than ctx.workspaceId.
  workspaceId?: SafeId<"workspace"> | null;
};

export type AuditRecorder = (
  tx: Transaction,
  event: AuditEvent | AuditEvent[],
) => Promise<void>;

type AuditRecorderBindings = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace"> | null;
  userId: SafeId<"user">;
  request: Request;
  server: ServerLike | null;
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
  const base = baseRequestMetadata(bindings.request, bindings.server);

  return async (tx, event) => {
    const events = Array.isArray(event) ? event : [event];
    if (events.length === 0) {
      return;
    }

    await tx.insert(auditLogs).values(
      events.map((e) => ({
        organizationId: bindings.organizationId,
        workspaceId:
          e.workspaceId === undefined ? bindings.workspaceId : e.workspaceId,
        userId: bindings.userId,
        action: e.action,
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        metadata: e.metadata ? { ...base, ...e.metadata } : base,
        changes: e.changes ?? null,
      })),
    );
  };
};
