import { panic } from "better-result";
import { createHash } from "node:crypto";

import type { MatterActivityFilters } from "@stll/api-contract/matter-activity";

import {
  type AuditAction,
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  type AuditActivityCategory,
  type AuditResourceType,
} from "@/api/lib/audit-log";
import { isUuid } from "@/api/lib/custom-schema";
import type { TimestampIdCursorCodec } from "@/api/lib/db-pagination";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import {
  brandPersistedEntityVersionId,
  brandPersistedFieldId,
} from "@/api/lib/safe-id-boundaries";

export type FieldAuditResource =
  | { type: "field"; fieldId: ReturnType<typeof brandPersistedFieldId> }
  | {
      type: "cell";
      entityVersionId: ReturnType<typeof brandPersistedEntityVersionId>;
    };

export const matterActivityFilterKey = ({
  action,
  actorId,
  category,
  from,
  toExclusive,
}: MatterActivityFilters): string =>
  createHash("sha256")
    .update(JSON.stringify([category, action, actorId, from, toExclusive]))
    .digest("base64url");

export const timestampMicroseconds = (value: string): bigint | null => {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  const fraction = /\.(\d+)(?=Z|[+-]\d\d:\d\d$)/iu.exec(value)?.[1] ?? "";
  if (fraction.length > 6) {
    return null;
  }
  const microseconds = BigInt(fraction.padEnd(6, "0") || "0");
  return BigInt(Math.floor(milliseconds / 1000)) * 1_000_000n + microseconds;
};

export const bindActivityCursorToFilters = <Id>({
  codec,
  filters,
}: {
  codec: TimestampIdCursorCodec<Id>;
  filters: MatterActivityFilters;
}): TimestampIdCursorCodec<Id> => {
  const filterKey = matterActivityFilterKey(filters);
  return {
    cursorValue: codec.cursorValue,
    keysetAfter: codec.keysetAfter,
    encode: (timestampValue, id) =>
      encodePaginationCursor([codec.encode(timestampValue, id), filterKey]),
    decode: (cursor) => {
      const parts = decodePaginationCursor(cursor);
      const innerCursor = parts?.at(0);
      const cursorFilterKey = parts?.at(1);
      if (
        parts?.length !== 2 ||
        typeof innerCursor !== "string" ||
        cursorFilterKey !== filterKey
      ) {
        return null;
      }
      return codec.decode(innerCursor);
    },
  };
};

export const parseFieldAuditResourceId = (
  resourceId: string,
): FieldAuditResource | null => {
  if (isUuid(resourceId)) {
    return { fieldId: brandPersistedFieldId(resourceId), type: "field" };
  }

  const parts = resourceId.split(":");
  const entityVersionId = parts.at(0);
  const propertyId = parts.at(1);
  if (
    parts.length !== 2 ||
    entityVersionId === undefined ||
    propertyId === undefined ||
    !isUuid(entityVersionId) ||
    !isUuid(propertyId)
  ) {
    return null;
  }

  return {
    entityVersionId: brandPersistedEntityVersionId(entityVersionId),
    type: "cell",
  };
};

/**
 * Where a row's target comes from, per audited resource type.
 *
 * `null` means the resource never belongs in a matter's activity: the feed
 * filters those out rather than rendering them under a catch-all label.
 */
export type ActivityTargetSource =
  | "automation"
  | "court"
  | "documentReviewRun"
  | "entity"
  | "entityVersion"
  | "field"
  | "playbook"
  | "team"
  | "translationRun"
  | "userFile"
  | "workspace";

/**
 * Total over `AuditResourceType`: a new audited resource does not compile
 * until it is either given a named target or excluded from the feed. It
 * replaces an if-chain whose fall-through rendered every unlisted resource as
 * "automation", so each new resource type silently arrived as an unnamed
 * automation row.
 */
export const ACTIVITY_TARGET_SOURCE_BY_RESOURCE_TYPE = {
  // Audited against the entity the obligation governs, so it reads as that
  // task rather than as a separate record.
  work_obligation: "entity",
  entity: "entity",
  entity_version: "entityVersion",
  field: "field",
  user_file: "userFile",
  workspace: "workspace",
  workspace_member: "team",
  workspace_contact: "team",
  case_law_matter_link: "court",
  case_law_decision_annotation: "court",
  bilingual_translation_run: "translationRun",
  document_translation_run: "translationRun",
  document_review_run: "documentReviewRun",
  flow_run: "automation",
  playbook: "playbook",
  // Housekeeping and organization-level records: audited for compliance,
  // never part of what happened in a matter.
  agent_skill: null,
  agent_skill_comment: null,
  agent_skill_proposal: null,
  ai_memory: null,
  announcement: null,
  audit_log: null,
  billing_code: null,
  chat_file: null,
  chat_message: null,
  chat_thread: null,
  clause: null,
  clause_category: null,
  clause_template_link: null,
  clause_variant: null,
  contact: null,
  contact_directory: null,
  desktop_edit_session: null,
  document_type: null,
  expense: null,
  flow_definition: null,
  folio_collab_room: null,
  invoice: null,
  legal_list: null,
  legal_list_generation: null,
  legal_list_item: null,
  machine_api_key: null,
  mcp_gateway_tool: null,
  organization_settings: null,
  property: null,
  rate_entry: null,
  rate_table: null,
  report_export: null,
  saved_search: null,
  signal: null,
  style_set: null,
  template: null,
  time_entry: null,
  usage_allocation: null,
  usage_entitlement: null,
  usage_event: null,
  view: null,
  view_template: null,
} as const satisfies Record<AuditResourceType, ActivityTargetSource | null>;

/** The allow-list the feed query filters on: every resource type with a named target. */
export const FEED_ACTIVITY_RESOURCE_TYPES = Object.values(
  AUDIT_RESOURCE_TYPE,
).filter(
  (resourceType) =>
    ACTIVITY_TARGET_SOURCE_BY_RESOURCE_TYPE[resourceType] !== null,
);

const isAuditResourceType = (value: string): value is AuditResourceType =>
  value in ACTIVITY_TARGET_SOURCE_BY_RESOURCE_TYPE;

/**
 * The row's target source. A miss means a row the allow-list should have
 * filtered reached the projection, which is a bug rather than a row to label
 * generically.
 */
export const activityTargetSource = (
  resourceType: string,
): ActivityTargetSource => {
  const source = isAuditResourceType(resourceType)
    ? ACTIVITY_TARGET_SOURCE_BY_RESOURCE_TYPE[resourceType]
    : null;
  if (source === null) {
    return panic(`Activity row has no target source: ${resourceType}`);
  }
  return source;
};

/** The actions the feed narrates; the rest are access records, not activity. */
export type VisibleActivityAction =
  | typeof AUDIT_ACTION.CANCEL
  | typeof AUDIT_ACTION.CREATE
  | typeof AUDIT_ACTION.DELETE
  | typeof AUDIT_ACTION.EXECUTE
  | typeof AUDIT_ACTION.REVIEW
  | typeof AUDIT_ACTION.UPDATE;

/** Total over `AuditAction`, so a new action must be narrated or excluded. */
export const VISIBLE_ACTIVITY_ACTION_BY_ACTION = {
  access: null,
  cancel: AUDIT_ACTION.CANCEL,
  create: AUDIT_ACTION.CREATE,
  delete: AUDIT_ACTION.DELETE,
  download: null,
  execute: AUDIT_ACTION.EXECUTE,
  review: AUDIT_ACTION.REVIEW,
  update: AUDIT_ACTION.UPDATE,
} as const satisfies Record<AuditAction, VisibleActivityAction | null>;

export const VISIBLE_ACTIVITY_ACTIONS = Object.values(
  VISIBLE_ACTIVITY_ACTION_BY_ACTION,
).filter((action): action is VisibleActivityAction => action !== null);

export type LegacyActivityCategory =
  | "automation"
  | "court"
  | "documents"
  | "matter"
  | "tasks"
  | "team";

export const legacyActivityCategory = (
  resourceType: string,
  kind: string | null,
  workspaceTeamEvent: boolean,
): LegacyActivityCategory => {
  if (
    kind === "task" &&
    (resourceType === AUDIT_RESOURCE_TYPE.ENTITY ||
      resourceType === AUDIT_RESOURCE_TYPE.ENTITY_VERSION ||
      resourceType === AUDIT_RESOURCE_TYPE.FIELD)
  ) {
    return "tasks";
  }
  if (
    resourceType === AUDIT_RESOURCE_TYPE.ENTITY ||
    resourceType === AUDIT_RESOURCE_TYPE.ENTITY_VERSION ||
    resourceType === AUDIT_RESOURCE_TYPE.FIELD ||
    resourceType === AUDIT_RESOURCE_TYPE.USER_FILE
  ) {
    return "documents";
  }
  if (
    resourceType === AUDIT_RESOURCE_TYPE.WORKSPACE_MEMBER ||
    resourceType === AUDIT_RESOURCE_TYPE.WORKSPACE_CONTACT
  ) {
    return "team";
  }
  if (resourceType === AUDIT_RESOURCE_TYPE.CASE_LAW_MATTER_LINK) {
    return "court";
  }
  if (resourceType === AUDIT_RESOURCE_TYPE.WORKSPACE) {
    return workspaceTeamEvent ? "team" : "matter";
  }
  return "automation";
};

type ResolveActivityCategoryOptions = {
  kind: string | null;
  persistedCategory: AuditActivityCategory | null;
  resourceType: string;
  workspaceTeamEvent: boolean;
};

export const resolveActivityCategory = ({
  kind,
  persistedCategory,
  resourceType,
  workspaceTeamEvent,
}: ResolveActivityCategoryOptions): LegacyActivityCategory => {
  const derivedCategory = legacyActivityCategory(
    resourceType,
    kind,
    workspaceTeamEvent,
  );
  if (derivedCategory === "tasks") {
    return derivedCategory;
  }
  if (persistedCategory && persistedCategory !== "other") {
    return persistedCategory;
  }
  return derivedCategory;
};

type ResolveActivityRunIdOptions = {
  resourceId: string;
  resourceType: string;
  runId: string | null;
};

export const resolveActivityRunId = ({
  resourceId,
  resourceType,
  runId,
}: ResolveActivityRunIdOptions): string | null =>
  runId ?? (resourceType === AUDIT_RESOURCE_TYPE.FLOW_RUN ? resourceId : null);

type ResolveActivityActionOptions<TAction extends AuditAction> = {
  action: TAction;
  relationshipChange: "add" | "remove" | null;
};

export const resolveActivityAction = <TAction extends AuditAction>({
  action,
  relationshipChange,
}: ResolveActivityActionOptions<TAction>): TAction | "add" | "remove" =>
  relationshipChange ?? action;
