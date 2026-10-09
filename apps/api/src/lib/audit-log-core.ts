import { panic } from "better-result";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { Transaction } from "@/api/db/root";
import type { AUDIT_ACTIVITY_CATEGORIES } from "@/api/db/schema";
import { auditLogs } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { insertInChunks } from "@/api/lib/db/bulk-write";
import { recordContentDeliveryReceipt } from "@/api/lib/files/content-delivery";

import {
  auditChangesForResource,
  auditMetadataForResource,
} from "./audit-log-details";
import type {
  ChatAuditChanges,
  ChatAuditResourceType,
  NonChatAuditResourceType,
} from "./audit-log-details";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "./audit-log.constants";
import type { AuditAction, AuditResourceType } from "./audit-log.constants";

export { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "./audit-log.constants";
export type { AuditAction, AuditResourceType } from "./audit-log.constants";
export type { NonChatAuditResourceType } from "./audit-log-details";

export const ORGANIZATION_AUDIT_LOG_RESOURCE_ID = "organization-logs";
/** The directory itself, for events about the whole contact set (exports). */
export const CONTACT_DIRECTORY_AUDIT_RESOURCE_ID = "contact-directory";

// Generic field-diff shape. Every existing audit payload in the
// codebase is `{ [field]: { old, new } }` — see entities/move.ts,
// properties/update-by-id.ts, etc. Codifying it here gives audit
// rows a documented contract without forcing per-event schemas.
export type FieldDiffs = Record<string, { old: unknown; new: unknown }>;

type AuditMetadata = Record<string, unknown>;

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

type AuditEventFields = {
  action: AuditAction;
  resourceId: string;
  // Merged onto the base request metadata (IP, UA, forwardedFor).
  // Use for non-diff context (download s3Key, fileName, etc.).
  metadata?: AuditMetadata;
  // Overrides the recorder's bound workspaceId. Required when the
  // handler is root-scoped (no ctx.workspaceId) or operates on a
  // workspace other than ctx.workspaceId.
  workspaceId?: SafeId<"workspace"> | null;
};

// Requiring rollback keeps a database handle from standing in for a transaction.
type AuditTransaction = Pick<
  PgAsyncDatabase<PgQueryResultHKT>,
  "insert" | "select"
> &
  Pick<Transaction, "rollback">;

/** Chat entries carry only the change fields their resource type lists. */
type ChatAuditEvent = {
  [T in ChatAuditResourceType]: AuditEventFields & {
    resourceType: T;
    changes?: ChatAuditChanges[T] | null;
  };
}[ChatAuditResourceType];

export type AuditEvent =
  | ChatAuditEvent
  | (AuditEventFields & {
      resourceType: NonChatAuditResourceType;
      changes?: FieldDiffs | null;
    })
  // Any resource without a change payload, for helpers that take the
  // resource type as a parameter.
  | (AuditEventFields & {
      resourceType: AuditResourceType;
      changes?: null;
    });

export type AuditRecorder = (
  tx: AuditTransaction,
  event: AuditEvent | AuditEvent[],
) => Promise<void>;

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

/** An event's change payload read as plain field diffs, whatever its resource. */
export const auditEventChanges = (
  event: AuditEvent,
): FieldDiffs | null | undefined => event.changes;

const entityActivityCategory = (event: AuditEvent): AuditActivityCategory => {
  const createdEntity = auditEventChanges(event)?.["created"]?.new;
  const createdKind =
    typeof createdEntity === "object" &&
    createdEntity !== null &&
    "kind" in createdEntity
      ? createdEntity.kind
      : null;
  const deletedEntity = auditEventChanges(event)?.["deleted"]?.old;
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
  auditEventChanges(event)?.["membersAdded"] !== undefined ||
  auditEventChanges(event)?.["membersRemoved"] !== undefined
    ? "team"
    : "matter";

type AuditActivityCategoryResolver =
  | AuditActivityCategory
  | ((event: AuditEvent) => AuditActivityCategory);

const AUDIT_ACTIVITY_CATEGORY_BY_RESOURCE_TYPE = {
  service_oauth_client: "team",
  legal_resolve: "court",
  entity: entityActivityCategory,
  field: taskOrDocumentActivityCategory,
  entity_version: taskOrDocumentActivityCategory,
  work_obligation: "tasks",
  user_file: "documents",
  workspace_member: "team",
  workspace_contact: "team",
  case_law_matter_link: "court",
  case_law_decision_annotation: "court",
  statute_annotation: "court",
  case_law_research_column: "court",
  correspondence: "correspondence",
  bilingual_translation_run: "automation",
  document_translation_run: "automation",
  document_review_run: "documents",
  legal_list_verification: "documents",
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
  file_comparison: "documents",
  usage_allocation: "other",
  usage_entitlement: "other",
  usage_event: "other",
  usage_provider_event: "other",
  desktop_edit_session: "other",
  pdf_signing_session: "other",
  expense: "other",
  feedback_report: "other",
  flow_definition: "other",
  folio_collab_room: "other",
  signal: "other",
  invoice: "other",
  personal_api_key: "other",
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
  seller_profile: "other",
  saved_time_narrative: "other",
  number_series: "other",
  vat_rate: "other",
  style_set: "other",
  template: "other",
  template_lookup_format: "other",
  time_entry: "other",
  time_timer: "other",
  time_daily_target: "other",
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

/**
 * Write one recorder call's rows. Chunking is a bind-parameter detail, not a
 * change of meaning: the caller's `groupId` spans every batch, so a call is one
 * audit group however many statements it takes. Every array caller goes through
 * here, so no call site has to remember the cap — an audit row spends more than
 * a dozen parameters and a recorder can be handed an array with no natural
 * upper bound (a folder-tree upload commits up to `LIMITS.entitiesCount`
 * creations in one transaction).
 */
const insertAuditRows = async (
  tx: AuditTransaction,
  rows: readonly (typeof auditLogs.$inferInsert)[],
): Promise<void> => {
  await insertInChunks(rows, (batch) => tx.insert(auditLogs).values(batch));
  if (
    rows.some(
      ({ action }) =>
        action === AUDIT_ACTION.ACCESS || action === AUDIT_ACTION.DOWNLOAD,
    )
  ) {
    recordContentDeliveryReceipt();
  }
};

type BackgroundAuditRecorderBindings = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace"> | null;
  userId: string;
  execution: AuditExecutionContext;
};

type BackgroundAuditGroup = {
  bindings: BackgroundAuditRecorderBindings;
  events: AuditEvent[];
};

type RecordAuditGroupsOptions = {
  tx: AuditTransaction;
  groups: readonly BackgroundAuditGroup[];
  requestMetadata?: AuditMetadata;
  recordAuditEvent?: AuditRecorder | undefined;
};

/** Retain request metadata when supplied; otherwise keep each tenant group's provenance. */
export const recordAuditGroups = async ({
  tx,
  groups,
  requestMetadata,
  recordAuditEvent,
}: RecordAuditGroupsOptions): Promise<void> => {
  if (recordAuditEvent) {
    await recordAuditEvent(
      tx,
      groups.flatMap(({ events }) => events),
    );
    return;
  }
  const rows = groups.flatMap(({ bindings, events }) => {
    const groupId = Bun.randomUUIDv7();
    const execution = executionColumns(bindings.execution, bindings.userId);
    return events.map((event) => ({
      action: event.action,
      changes: auditChangesForResource(event.resourceType, event.changes),
      metadata:
        requestMetadata === undefined
          ? (auditMetadataForResource(event.resourceType, event.metadata) ??
            null)
          : {
              ...requestMetadata,
              ...auditMetadataForResource(event.resourceType, event.metadata),
            },
      organizationId: bindings.organizationId,
      resourceId: event.resourceId,
      resourceType: event.resourceType,
      userId: bindings.userId,
      workspaceId:
        event.workspaceId === undefined
          ? bindings.workspaceId
          : event.workspaceId,
      ...execution,
      activityCategory: activityCategoryForEvent(event),
      groupId,
      runId: runIdForEvent(event, execution),
    }));
  });
  if (rows.length === 0) {
    return;
  }
  await insertAuditRows(tx, rows);
};

/**
 * Audit recorder for background jobs (BullMQ workers) that run without an HTTP
 * request. Uses the same insertion owner as the HTTP recorder, but with no
 * request-derived metadata (IP, UA, forwarded-for) since there is no request.
 */
export const createBackgroundAuditRecorder =
  (bindings: BackgroundAuditRecorderBindings): AuditRecorder =>
  async (tx, event) => {
    await recordAuditGroups({
      tx,
      groups: [{ bindings, events: Array.isArray(event) ? event : [event] }],
    });
  };
