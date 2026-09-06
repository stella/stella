import { panic } from "better-result";

import type { Transaction } from "@/api/db/root";
import type {
  AUDIT_ACTIVITY_CATEGORIES,
  AUDIT_APPROVAL_STATUSES,
  AUDIT_PERFORMER_TYPES,
  AUDIT_TRIGGER_TYPES,
} from "@/api/db/schema";
import { auditLogs } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { chunked } from "@/api/lib/chunked";
import { resolveClientIp } from "@/api/lib/client-ip";

import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "./audit-log.constants";
import type { AuditAction, AuditResourceType } from "./audit-log.constants";

export { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "./audit-log.constants";
export type { AuditAction, AuditResourceType } from "./audit-log.constants";

type ServerLike = {
  requestIP: (request: Request) => { address: string } | null;
};

export const ORGANIZATION_AUDIT_LOG_RESOURCE_ID = "organization-logs";
/** The directory itself, for events about the whole contact set (exports). */
export const CONTACT_DIRECTORY_AUDIT_RESOURCE_ID = "contact-directory";

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
    | { type: "direct"; source?: "mcp" }
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
        type: "schedule" | "credential";
        ownerUserId: SafeId<"user">;
        source?: string;
        sourceId?: string;
      }
    | {
        type: "webhook";
        ownerUserId?: SafeId<"user">;
        source?: string;
        sourceId?: string;
      }
    | { type: "system"; source?: string; sourceId?: string };
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
  accountableUserId: string,
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
      case "credential":
        return trigger.ownerUserId;
      case "webhook":
        return trigger.ownerUserId ?? null;
      case "direct":
      case "system":
        return null;
      default: {
        trigger satisfies never;
        return panic(`Unhandled trigger: ${String(trigger)}`);
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
        return trigger.source ?? null;
      default: {
        trigger satisfies never;
        return panic(`Unhandled trigger: ${String(trigger)}`);
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

const entityActivityCategory = (event: AuditEvent): AuditActivityCategory => {
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
};

const taskOrDocumentActivityCategory = (
  event: AuditEvent,
): AuditActivityCategory =>
  event.metadata?.["kind"] === "task" ? "tasks" : "documents";

const playbookActivityCategory = (event: AuditEvent): AuditActivityCategory =>
  event.action === AUDIT_ACTION.EXECUTE ? "automation" : "other";

const workspaceActivityCategory = (event: AuditEvent): AuditActivityCategory =>
  event.changes?.["membersAdded"] !== undefined ||
  event.changes?.["membersRemoved"] !== undefined
    ? "team"
    : "matter";

type AuditActivityCategoryResolver =
  | AuditActivityCategory
  | ((event: AuditEvent) => AuditActivityCategory);

const AUDIT_ACTIVITY_CATEGORY_BY_RESOURCE_TYPE = {
  entity: entityActivityCategory,
  field: taskOrDocumentActivityCategory,
  entity_version: taskOrDocumentActivityCategory,
  work_obligation: "tasks",
  user_file: "documents",
  workspace_member: "team",
  workspace_contact: "team",
  case_law_matter_link: "court",
  case_law_decision_annotation: "court",
  case_law_research_table: "court",
  bilingual_translation_run: "automation",
  document_translation_run: "automation",
  document_review_run: "documents",
  flow_run: "automation",
  playbook: playbookActivityCategory,
  workspace: workspaceActivityCategory,
  audit_log: "other",
  agent_skill: "other",
  agent_skill_comment: "other",
  agent_skill_proposal: "other",
  ai_memory: "other",
  announcement: "other",
  billing_code: "other",
  chat_file: "other",
  chat_message: "other",
  chat_thread: "other",
  clause: "other",
  clause_category: "other",
  clause_template_link: "other",
  clause_variant: "other",
  contact: "other",
  contact_directory: "other",
  document_type: "other",
  usage_allocation: "other",
  usage_entitlement: "other",
  usage_event: "other",
  desktop_edit_session: "other",
  expense: "other",
  flow_definition: "other",
  folio_collab_room: "other",
  signal: "other",
  invoice: "other",
  machine_api_key: "other",
  legal_list: "other",
  legal_list_generation: "other",
  legal_list_item: "other",
  mcp_gateway_tool: "other",
  organization_settings: "other",
  property: "other",
  rate_entry: "other",
  report_export: "other",
  rate_table: "other",
  saved_search: "other",
  style_set: "other",
  template: "other",
  time_entry: "other",
  view: "other",
  view_template: "other",
} as const satisfies Record<AuditResourceType, AuditActivityCategoryResolver>;

const activityCategoryForEvent = (event: AuditEvent): AuditActivityCategory => {
  const resolver = AUDIT_ACTIVITY_CATEGORY_BY_RESOURCE_TYPE[event.resourceType];
  return typeof resolver === "function" ? resolver(event) : resolver;
};

const runIdForEvent = (
  event: AuditEvent,
  execution: ReturnType<typeof executionColumns>,
): string | null =>
  execution.runId ??
  (event.resourceType === AUDIT_RESOURCE_TYPE.FLOW_RUN
    ? event.resourceId
    : null);

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
 * Rows per audit INSERT. A single statement can carry at most 65,535 bind
 * parameters and an audit row spends more than a dozen, so a recorder handed an
 * array with no natural upper bound (a folder-tree upload commits up to
 * `LIMITS.entitiesCount` creations in one transaction) would otherwise build a
 * statement PostgreSQL refuses.
 */
const AUDIT_INSERT_BATCH_SIZE = 500;

/**
 * Write one recorder call's rows. Chunking is a bind-parameter detail, not a
 * change of meaning: the caller's `groupId` spans every batch, so a call is one
 * audit group however many statements it takes. Every array caller goes through
 * here, so no call site has to remember the cap.
 */
const insertAuditRows = async (
  tx: Transaction,
  rows: readonly (typeof auditLogs.$inferInsert)[],
): Promise<void> => {
  for (const batch of chunked(rows, AUDIT_INSERT_BATCH_SIZE)) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- each batch is already one insert; the bind-parameter cap forbids a single statement
    await tx.insert(auditLogs).values(batch);
  }
};

/**
 * Audit recorder for background jobs (BullMQ workers) that run without an HTTP
 * request. Same insert shape as {@link createAuditRecorder}, but with no
 * request-derived metadata (IP, UA, forwarded-for) since there is no request.
 */
export const createBackgroundAuditRecorder =
  (bindings: {
    organizationId: SafeId<"organization">;
    workspaceId: SafeId<"workspace"> | null;
    userId: string;
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
      runId: runIdForEvent(e, execution),
    });
    await insertAuditRows(tx, events.map(toRow));
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
      runId: runIdForEvent(e, execution),
    });
    await insertAuditRows(tx, events.map(toRow));
  };
};
