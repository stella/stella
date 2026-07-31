import type { Transaction } from "@/api/db/root";
import type {
  AUDIT_ACTIVITY_CATEGORIES,
  AUDIT_APPROVAL_STATUSES,
  AUDIT_PERFORMER_TYPES,
  AUDIT_TRIGGER_TYPES,
} from "@/api/db/schema";
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
  ACCESS: "access",
  CANCEL: "cancel",
  REVIEW: "review",
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

export const ORGANIZATION_AUDIT_LOG_RESOURCE_ID = "organization-logs";

export const AUDIT_RESOURCE_TYPE = {
  AUDIT_LOG: "audit_log",
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
  DOCUMENT_TYPE: "document_type",
  USAGE_ALLOCATION: "usage_allocation",
  USAGE_ENTITLEMENT: "usage_entitlement",
  USAGE_EVENT: "usage_event",
  DESKTOP_EDIT_SESSION: "desktop_edit_session",
  ENTITY: "entity",
  ENTITY_VERSION: "entity_version",
  EXPENSE: "expense",
  FIELD: "field",
  FLOW_DEFINITION: "flow_definition",
  FLOW_RUN: "flow_run",
  FOLIO_COLLAB_SESSION: "folio_collab_session",
  INVOICE: "invoice",
  MACHINE_API_KEY: "machine_api_key",
  MCP_GATEWAY_TOOL: "mcp_gateway_tool",
  ORGANIZATION_SETTINGS: "organization_settings",
  PLAYBOOK: "playbook",
  PROPERTY: "property",
  RATE_ENTRY: "rate_entry",
  REPORT_EXPORT: "report_export",
  RATE_TABLE: "rate_table",
  SAVED_SEARCH: "saved_search",
  STYLE_SET: "style_set",
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

export type AuditPerformerType = (typeof AUDIT_PERFORMER_TYPES)[number];
export type AuditTriggerType = (typeof AUDIT_TRIGGER_TYPES)[number];
export type AuditApprovalStatus = (typeof AUDIT_APPROVAL_STATUSES)[number];
export type AuditActivityCategory = (typeof AUDIT_ACTIVITY_CATEGORIES)[number];

export type AuditExecutionContext = {
  performer:
    | { type: "user"; id: SafeId<"user"> }
    | { type: "agent" | "service"; id: string; name: string | null };
  trigger:
    | { type: "direct" }
    | {
        type: "user_dispatch";
        userId: SafeId<"user">;
        source: "chat" | "action" | "api";
        sourceId?: string;
      }
    | {
        type: "agent_delegation";
        agentId: string;
        rootUserId: SafeId<"user">;
      }
    | {
        type: "schedule" | "webhook" | "credential";
        ownerUserId: SafeId<"user">;
        source?: string;
        sourceId?: string;
      }
    | { type: "system"; source?: string };
  runId?: string;
  approval?:
    | { status: "not_required" | "pending" }
    | {
        status: "approved" | "rejected";
        userId: SafeId<"user">;
      };
};

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
  execution?: AuditExecutionContext;
};

const executionColumns = (
  execution: AuditExecutionContext | undefined,
  accountableUserId: SafeId<"user">,
) => {
  const performer = execution?.performer ?? {
    type: "user" as const,
    id: accountableUserId,
  };
  const trigger = execution?.trigger ?? { type: "direct" as const };
  const approval = execution?.approval ?? { status: "not_required" as const };

  const triggerUserId = (() => {
    switch (trigger.type) {
      case "user_dispatch":
        return trigger.userId;
      case "agent_delegation":
        return trigger.rootUserId;
      case "schedule":
      case "webhook":
      case "credential":
        return trigger.ownerUserId;
      case "direct":
      case "system":
        return null;
      default: {
        const exhaustive: never = trigger;
        return exhaustive;
      }
    }
  })();

  const triggerSource = (() => {
    switch (trigger.type) {
      case "user_dispatch":
        return trigger.source;
      case "schedule":
      case "webhook":
      case "credential":
      case "system":
        return trigger.source ?? null;
      case "agent_delegation":
        return trigger.agentId;
      case "direct":
        return null;
      default: {
        const exhaustive: never = trigger;
        return exhaustive;
      }
    }
  })();

  return {
    performerType: performer.type,
    performerId: performer.id,
    performerName: performer.type === "user" ? null : performer.name,
    triggerType: trigger.type,
    triggerUserId,
    triggerSource,
    triggerSourceId: "sourceId" in trigger ? (trigger.sourceId ?? null) : null,
    runId: execution?.runId ?? null,
    approvalStatus: approval.status,
    approvedByUserId:
      approval.status === "approved" || approval.status === "rejected"
        ? approval.userId
        : null,
  };
};

const activityCategoryForEvent = (event: AuditEvent): AuditActivityCategory => {
  switch (event.resourceType) {
    case "entity": {
      const createdEntity = event.changes?.["created"]?.new;
      const createdKind =
        typeof createdEntity === "object" &&
        createdEntity !== null &&
        "kind" in createdEntity
          ? createdEntity.kind
          : null;
      const deletedEntity = event.changes?.["deleted"]?.old;
      const deletedKind =
        typeof deletedEntity === "object" &&
        deletedEntity !== null &&
        "kind" in deletedEntity
          ? deletedEntity.kind
          : null;
      return event.metadata?.["kind"] === "task" ||
        createdKind === "task" ||
        deletedKind === "task"
        ? "tasks"
        : "documents";
    }
    case "field":
      return event.metadata?.["kind"] === "task" ? "tasks" : "documents";
    case "entity_version":
    case "user_file":
      return "documents";
    case "workspace_member":
    case "workspace_contact":
      return "team";
    case "case_law_matter_link":
      return "court";
    case "flow_run":
      return "automation";
    case "workspace":
      return event.changes?.["membersAdded"] !== undefined ||
        event.changes?.["membersRemoved"] !== undefined
        ? "team"
        : "matter";
    default:
      return "other";
  }
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

/**
 * Audit recorder for background jobs (BullMQ workers) that run without an HTTP
 * request. Same insert shape as {@link createAuditRecorder}, but with no
 * request-derived metadata (IP, UA, forwarded-for) since there is no request.
 */
export const createBackgroundAuditRecorder =
  (bindings: {
    organizationId: SafeId<"organization">;
    workspaceId: SafeId<"workspace"> | null;
    userId: SafeId<"user">;
    execution: AuditExecutionContext;
  }): AuditRecorder =>
  async (tx, event) => {
    const events = Array.isArray(event) ? event : [event];
    if (events.length === 0) {
      return;
    }

    const groupId = Bun.randomUUIDv7();
    const execution = executionColumns(bindings.execution, bindings.userId);
    const toRow = (e: AuditEvent) => ({
      action: e.action,
      changes: e.changes ?? null,
      metadata: e.metadata ?? null,
      organizationId: bindings.organizationId,
      resourceId: e.resourceId,
      resourceType: e.resourceType,
      userId: bindings.userId,
      workspaceId:
        e.workspaceId === undefined ? bindings.workspaceId : e.workspaceId,
      ...execution,
      activityCategory: activityCategoryForEvent(e),
      groupId,
    });
    await tx.insert(auditLogs).values(events.map(toRow));
  };

export const createAuditRecorder = (
  bindings: AuditRecorderBindings,
): AuditRecorder => {
  const base = baseRequestMetadata(bindings.request, bindings.server);

  return async (tx, event) => {
    const events = Array.isArray(event) ? event : [event];
    if (events.length === 0) {
      return;
    }

    const groupId = Bun.randomUUIDv7();
    const execution = executionColumns(bindings.execution, bindings.userId);
    const toRow = (e: AuditEvent) => ({
      action: e.action,
      changes: e.changes ?? null,
      metadata: e.metadata ? { ...base, ...e.metadata } : base,
      organizationId: bindings.organizationId,
      resourceId: e.resourceId,
      resourceType: e.resourceType,
      userId: bindings.userId,
      workspaceId:
        e.workspaceId === undefined ? bindings.workspaceId : e.workspaceId,
      ...execution,
      activityCategory: activityCategoryForEvent(e),
      groupId,
    });
    await tx.insert(auditLogs).values(events.map(toRow));
  };
};
