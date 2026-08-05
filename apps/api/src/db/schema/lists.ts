import { timestamptz } from "@/api/db/columns";
import { ENTITY_PRIORITIES, TASK_STATUSES } from "@/api/lib/entity-constants";

import type { LegalListSourceLocator } from "../../lib/lists/types";
import {
  LIST_ITEM_TYPES,
  jsonb,
  p,
  pUuid,
  safeUuid,
  safeWorkspaceId,
  sql,
  stella,
  user,
  workspaceCheck,
  wsPolicies,
} from "./common";
import type { SafeId } from "./common";
import { workspaces } from "./contacts";
import { entities, entityVersions } from "./entities";
import { properties } from "./properties";

export const LEGAL_LIST_STATUSES = ["active", "archived"] as const;
export type LegalListStatus = (typeof LEGAL_LIST_STATUSES)[number];

export const LEGAL_LIST_ITEM_REVIEW_STATUSES = [
  "unreviewed",
  "in_review",
  "verified",
  "changes_requested",
  "rejected",
] as const;
export type LegalListItemReviewStatus =
  (typeof LEGAL_LIST_ITEM_REVIEW_STATUSES)[number];

export const LEGAL_LIST_SOURCE_VERIFICATION_STATUSES = [
  "unverified",
  "verified",
  "rejected",
] as const;
export type LegalListSourceVerificationStatus =
  (typeof LEGAL_LIST_SOURCE_VERIFICATION_STATUSES)[number];

export const LEGAL_LIST_GENERATION_STATUSES = [
  "queued",
  "running",
  "review",
  "committed",
  "failed",
  "cancelled",
] as const;
export type LegalListGenerationStatus =
  (typeof LEGAL_LIST_GENERATION_STATUSES)[number];

export const LEGAL_LIST_GENERATION_CANDIDATE_STATUSES = [
  "pending",
  "accepting",
  "accepted",
  "rejected",
] as const;
export type LegalListGenerationCandidateStatus =
  (typeof LEGAL_LIST_GENERATION_CANDIDATE_STATUSES)[number];

export const LEGAL_LIST_REVIEW_DECISIONS = [
  "verified",
  "changes_requested",
  "rejected",
] as const;
export type LegalListReviewDecision =
  (typeof LEGAL_LIST_REVIEW_DECISIONS)[number];

export const legalLists = p.pgTable(
  "legal_lists",
  {
    id: pUuid<"legalList">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 256 }).notNull(),
    description: p.text(),
    status: p
      .text("status", { enum: LEGAL_LIST_STATUSES })
      .notNull()
      .default("active"),
    createdBy: p
      .text("created_by")
      .references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.unique("legal_lists_id_ws_unq").on(table.id, table.workspaceId),
    p.check(
      "legal_lists_status_check",
      sql`${table.status} in ('active', 'archived')`,
    ),
    p
      .index("legal_lists_workspace_status_created_idx")
      .on(table.workspaceId, table.status, table.createdAt, table.id),
    ...wsPolicies(),
  ],
);

export const legalListSections = p.pgTable(
  "legal_list_sections",
  {
    id: pUuid<"legalListSection">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    listId: safeUuid<"legalList">("list_id").notNull(),
    name: p.varchar({ length: 256 }).notNull(),
    position: p.varchar({ length: 64 }).notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        name: "legal_list_sections_list_fk",
        columns: [table.listId, table.workspaceId],
        foreignColumns: [legalLists.id, legalLists.workspaceId],
      })
      .onDelete("cascade"),
    p
      .unique("legal_list_sections_id_list_ws_unq")
      .on(table.id, table.listId, table.workspaceId),
    p
      .index("legal_list_sections_list_position_idx")
      .on(table.workspaceId, table.listId, table.position, table.id),
    ...wsPolicies(),
  ],
);

export const legalListColumns = p.pgTable(
  "legal_list_columns",
  {
    id: pUuid<"legalListColumn">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    listId: safeUuid<"legalList">("list_id").notNull(),
    propertyId: safeUuid<"property">("property_id").notNull(),
    position: p.integer().notNull(),
    required: p.boolean().notNull().default(false),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        name: "legal_list_columns_list_fk",
        columns: [table.listId, table.workspaceId],
        foreignColumns: [legalLists.id, legalLists.workspaceId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "legal_list_columns_property_fk",
        columns: [table.propertyId, table.workspaceId],
        foreignColumns: [properties.id, properties.workspaceId],
      })
      .onDelete("cascade"),
    p
      .uniqueIndex("legal_list_columns_list_property_uidx")
      .on(table.listId, table.propertyId),
    p
      .index("legal_list_columns_list_position_idx")
      .on(table.workspaceId, table.listId, table.position, table.id),
    ...wsPolicies(),
  ],
);

export const legalListItems = p.pgTable(
  "legal_list_items",
  {
    entityId: safeUuid<"entity">("entity_id").primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    listId: safeUuid<"legalList">("list_id").notNull(),
    sectionId: safeUuid<"legalListSection">("section_id"),
    position: p.varchar({ length: 64 }).notNull(),
    description: p.text(),
    reviewStatus: p
      .text("review_status", { enum: LEGAL_LIST_ITEM_REVIEW_STATUSES })
      .notNull()
      .default("unreviewed"),
    addedBy: p.text("added_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        name: "legal_list_items_entity_fk",
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "legal_list_items_list_fk",
        columns: [table.listId, table.workspaceId],
        foreignColumns: [legalLists.id, legalLists.workspaceId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "legal_list_items_section_fk",
        columns: [table.sectionId, table.listId, table.workspaceId],
        foreignColumns: [
          legalListSections.id,
          legalListSections.listId,
          legalListSections.workspaceId,
        ],
      })
      .onDelete("restrict"),
    p
      .unique("legal_list_items_entity_list_ws_unq")
      .on(table.entityId, table.listId, table.workspaceId),
    p
      .index("legal_list_items_list_section_position_idx")
      .on(
        table.workspaceId,
        table.listId,
        table.sectionId,
        table.position,
        table.entityId,
      ),
    p
      .index("legal_list_items_list_review_idx")
      .on(table.workspaceId, table.listId, table.reviewStatus, table.entityId),
    p.check(
      "legal_list_items_review_status_check",
      sql`${table.reviewStatus} in ('unreviewed', 'in_review', 'verified', 'changes_requested', 'rejected')`,
    ),
    ...wsPolicies(),
  ],
);

export const legalListItemSources = p.pgTable(
  "legal_list_item_sources",
  {
    id: pUuid<"legalListItemSource">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    listId: safeUuid<"legalList">("list_id").notNull(),
    itemEntityId: safeUuid<"entity">("item_entity_id").notNull(),
    sourceEntityId: safeUuid<"entity">("source_entity_id").notNull(),
    sourceEntityVersionId: safeUuid<"entityVersion">(
      "source_entity_version_id",
    ).notNull(),
    locator: jsonb().$type<LegalListSourceLocator>().notNull(),
    quote: p.text(),
    verificationStatus: p
      .text("verification_status", {
        enum: LEGAL_LIST_SOURCE_VERIFICATION_STATUSES,
      })
      .notNull()
      .default("unverified"),
    verifiedBy: p.text("verified_by").references(() => user.id, {
      onDelete: "set null",
    }),
    verifiedAt: timestamptz("verified_at"),
    createdBy: p.text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        name: "legal_list_item_sources_item_fk",
        columns: [table.itemEntityId, table.listId, table.workspaceId],
        foreignColumns: [
          legalListItems.entityId,
          legalListItems.listId,
          legalListItems.workspaceId,
        ],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "legal_list_item_sources_version_fk",
        columns: [
          table.sourceEntityVersionId,
          table.sourceEntityId,
          table.workspaceId,
        ],
        foreignColumns: [
          entityVersions.id,
          entityVersions.entityId,
          entityVersions.workspaceId,
        ],
      })
      .onDelete("cascade"),
    p.check(
      "legal_list_item_sources_verification_status_check",
      sql`${table.verificationStatus} in ('unverified', 'verified', 'rejected')`,
    ),
    p
      .foreignKey({
        name: "legal_list_item_sources_source_entity_fk",
        columns: [table.sourceEntityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    p
      .index("legal_list_item_sources_item_created_idx")
      .on(table.workspaceId, table.itemEntityId, table.createdAt, table.id),
    p
      .index("legal_list_item_sources_source_version_idx")
      .on(table.workspaceId, table.sourceEntityVersionId, table.id),
    p.pgPolicy("workspace_select", {
      for: "select",
      to: stella,
      using: workspaceCheck,
    }),
    p.pgPolicy("workspace_insert", {
      for: "insert",
      to: stella,
      withCheck: workspaceCheck,
    }),
    p.pgPolicy("workspace_update", {
      for: "update",
      to: stella,
      using: workspaceCheck,
      withCheck: workspaceCheck,
    }),
    p.pgPolicy("legal_list_item_sources_no_delete", {
      as: "restrictive",
      for: "delete",
      to: stella,
      using: sql`false`,
    }),
  ],
);

export const legalListGenerationRuns = p.pgTable(
  "legal_list_generation_runs",
  {
    id: pUuid<"legalListGenerationRun">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    listId: safeUuid<"legalList">("list_id").notNull(),
    status: p
      .text("status", { enum: LEGAL_LIST_GENERATION_STATUSES })
      .notNull()
      .default("queued"),
    instruction: p.varchar({ length: 4000 }).notNull(),
    requestedBy: p.text("requested_by").references(() => user.id, {
      onDelete: "set null",
    }),
    error: p.text(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    completedAt: timestamptz("completed_at"),
  },
  (table) => [
    p
      .foreignKey({
        name: "legal_list_generation_runs_list_fk",
        columns: [table.listId, table.workspaceId],
        foreignColumns: [legalLists.id, legalLists.workspaceId],
      })
      .onDelete("cascade"),
    p
      .unique("legal_list_generation_runs_id_list_ws_unq")
      .on(table.id, table.listId, table.workspaceId),
    p
      .index("legal_list_generation_runs_list_created_idx")
      .on(table.workspaceId, table.listId, table.createdAt, table.id),
    p
      .index("legal_list_generation_runs_status_idx")
      .on(table.workspaceId, table.status, table.createdAt, table.id),
    p.check(
      "legal_list_generation_runs_status_check",
      sql`${table.status} in ('queued', 'running', 'review', 'committed', 'failed', 'cancelled')`,
    ),
    ...wsPolicies(),
  ],
);

export const legalListGenerationSources = p.pgTable(
  "legal_list_generation_sources",
  {
    id: pUuid<"legalListGenerationSource">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    listId: safeUuid<"legalList">("list_id").notNull(),
    runId: safeUuid<"legalListGenerationRun">("run_id").notNull(),
    sourceEntityId: safeUuid<"entity">("source_entity_id").notNull(),
    sourceEntityVersionId: safeUuid<"entityVersion">(
      "source_entity_version_id",
    ).notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        name: "legal_list_generation_sources_run_fk",
        columns: [table.runId, table.listId, table.workspaceId],
        foreignColumns: [
          legalListGenerationRuns.id,
          legalListGenerationRuns.listId,
          legalListGenerationRuns.workspaceId,
        ],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "legal_list_generation_sources_version_fk",
        columns: [
          table.sourceEntityVersionId,
          table.sourceEntityId,
          table.workspaceId,
        ],
        foreignColumns: [
          entityVersions.id,
          entityVersions.entityId,
          entityVersions.workspaceId,
        ],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "legal_list_generation_sources_entity_fk",
        columns: [table.sourceEntityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    p
      .uniqueIndex("legal_list_generation_sources_run_entity_uidx")
      .on(table.runId, table.sourceEntityId),
    p
      .index("legal_list_generation_sources_run_idx")
      .on(table.workspaceId, table.runId, table.id),
    p.pgPolicy("workspace_select", {
      for: "select",
      to: stella,
      using: workspaceCheck,
    }),
    p.pgPolicy("workspace_insert", {
      for: "insert",
      to: stella,
      withCheck: workspaceCheck,
    }),
    p.pgPolicy("legal_list_generation_sources_no_update", {
      as: "restrictive",
      for: "update",
      to: stella,
      using: sql`false`,
    }),
    p.pgPolicy("legal_list_generation_sources_no_delete", {
      as: "restrictive",
      for: "delete",
      to: stella,
      using: sql`false`,
    }),
  ],
);

export const legalListGenerationCandidates = p.pgTable(
  "legal_list_generation_candidates",
  {
    id: pUuid<"legalListGenerationCandidate">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    listId: safeUuid<"legalList">("list_id").notNull(),
    runId: safeUuid<"legalListGenerationRun">("run_id").notNull(),
    position: p.integer().notNull(),
    name: p.varchar({ length: 2000 }).notNull(),
    description: p.text(),
    itemType: p.text("item_type", { enum: LIST_ITEM_TYPES }).notNull(),
    itemStatus: p.text("item_status", { enum: TASK_STATUSES }),
    priority: p.text("priority", { enum: ENTITY_PRIORITIES }),
    dueDate: p.date("due_date", { mode: "string" }),
    suggestedAssigneeUserIds: jsonb("suggested_assignee_user_ids")
      .$type<SafeId<"user">[]>()
      .notNull()
      .default([]),
    status: p
      .text("status", { enum: LEGAL_LIST_GENERATION_CANDIDATE_STATUSES })
      .notNull()
      .default("pending"),
    acceptedEntityId: safeUuid<"entity">("accepted_entity_id"),
    acceptedEntityWorkspaceId: safeWorkspaceId("accepted_entity_workspace_id"),
    reservedEntityId: safeUuid<"entity">("reserved_entity_id"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        name: "legal_list_generation_candidates_run_fk",
        columns: [table.runId, table.listId, table.workspaceId],
        foreignColumns: [
          legalListGenerationRuns.id,
          legalListGenerationRuns.listId,
          legalListGenerationRuns.workspaceId,
        ],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "legal_list_gen_candidates_accepted_entity_fk",
        columns: [table.acceptedEntityId, table.acceptedEntityWorkspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("set null"),
    p
      .unique("legal_list_gen_candidates_id_run_list_ws_unq")
      .on(table.id, table.runId, table.listId, table.workspaceId),
    p
      .uniqueIndex("legal_list_generation_candidates_run_position_uidx")
      .on(table.runId, table.position),
    p
      .index("legal_list_generation_candidates_run_status_idx")
      .on(
        table.workspaceId,
        table.runId,
        table.status,
        table.position,
        table.id,
      ),
    p.check(
      "legal_list_generation_candidates_item_type_check",
      sql`${table.itemType} in ('task', 'fact', 'issue', 'requirement', 'event')`,
    ),
    p.check(
      "legal_list_generation_candidates_item_status_check",
      sql`${table.itemStatus} is null or ${table.itemStatus} in ('open', 'in_progress', 'in_review', 'done', 'cancelled')`,
    ),
    p.check(
      "legal_list_generation_candidates_priority_check",
      sql`${table.priority} is null or ${table.priority} in ('none', 'urgent', 'high', 'medium', 'low')`,
    ),
    p.check(
      "legal_list_generation_candidates_status_check",
      sql`${table.status} in ('pending', 'accepting', 'accepted', 'rejected')`,
    ),
    p.check(
      "legal_list_generation_candidates_accepted_entity_scope_check",
      sql`(${table.acceptedEntityId} is null and ${table.acceptedEntityWorkspaceId} is null) or (${table.acceptedEntityId} is not null and ${table.acceptedEntityWorkspaceId} = ${table.workspaceId})`,
    ),
    ...wsPolicies(),
  ],
);

export const legalListGenerationCandidateSources = p.pgTable(
  "legal_list_generation_candidate_sources",
  {
    id: pUuid<"legalListGenerationCandidateSource">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    listId: safeUuid<"legalList">("list_id").notNull(),
    runId: safeUuid<"legalListGenerationRun">("run_id").notNull(),
    candidateId:
      safeUuid<"legalListGenerationCandidate">("candidate_id").notNull(),
    sourceEntityId: safeUuid<"entity">("source_entity_id").notNull(),
    sourceEntityVersionId: safeUuid<"entityVersion">(
      "source_entity_version_id",
    ).notNull(),
    locator: jsonb().$type<LegalListSourceLocator>().notNull(),
    quote: p.text(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        name: "legal_list_candidate_sources_candidate_fk",
        columns: [
          table.candidateId,
          table.runId,
          table.listId,
          table.workspaceId,
        ],
        foreignColumns: [
          legalListGenerationCandidates.id,
          legalListGenerationCandidates.runId,
          legalListGenerationCandidates.listId,
          legalListGenerationCandidates.workspaceId,
        ],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "legal_list_candidate_sources_run_fk",
        columns: [table.runId, table.listId, table.workspaceId],
        foreignColumns: [
          legalListGenerationRuns.id,
          legalListGenerationRuns.listId,
          legalListGenerationRuns.workspaceId,
        ],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "legal_list_candidate_sources_version_fk",
        columns: [
          table.sourceEntityVersionId,
          table.sourceEntityId,
          table.workspaceId,
        ],
        foreignColumns: [
          entityVersions.id,
          entityVersions.entityId,
          entityVersions.workspaceId,
        ],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "legal_list_candidate_sources_entity_fk",
        columns: [table.sourceEntityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    p
      .index("legal_list_generation_candidate_sources_candidate_idx")
      .on(table.workspaceId, table.candidateId, table.id),
    p.pgPolicy("workspace_select", {
      for: "select",
      to: stella,
      using: workspaceCheck,
    }),
    p.pgPolicy("workspace_insert", {
      for: "insert",
      to: stella,
      withCheck: workspaceCheck,
    }),
    p.pgPolicy("legal_list_generation_candidate_sources_no_update", {
      as: "restrictive",
      for: "update",
      to: stella,
      using: sql`false`,
    }),
    p.pgPolicy("legal_list_generation_candidate_sources_no_delete", {
      as: "restrictive",
      for: "delete",
      to: stella,
      using: sql`false`,
    }),
  ],
);

export const legalListItemComments = p.pgTable(
  "legal_list_item_comments",
  {
    id: pUuid<"legalListItemComment">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    listId: safeUuid<"legalList">("list_id").notNull(),
    itemEntityId: safeUuid<"entity">("item_entity_id").notNull(),
    body: p.varchar({ length: 10_000 }).notNull(),
    authorId: p.text("author_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        name: "legal_list_item_comments_item_fk",
        columns: [table.itemEntityId, table.listId, table.workspaceId],
        foreignColumns: [
          legalListItems.entityId,
          legalListItems.listId,
          legalListItems.workspaceId,
        ],
      })
      .onDelete("cascade"),
    p
      .index("legal_list_item_comments_item_created_idx")
      .on(table.workspaceId, table.itemEntityId, table.createdAt, table.id),
    ...wsPolicies(),
  ],
);

export const legalListItemReviews = p.pgTable(
  "legal_list_item_reviews",
  {
    id: pUuid<"legalListItemReview">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    listId: safeUuid<"legalList">("list_id").notNull(),
    itemEntityId: safeUuid<"entity">("item_entity_id").notNull(),
    decision: p
      .text("decision", { enum: LEGAL_LIST_REVIEW_DECISIONS })
      .notNull(),
    note: p.varchar({ length: 10_000 }),
    reviewerId: p.text("reviewer_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        name: "legal_list_item_reviews_item_fk",
        columns: [table.itemEntityId, table.listId, table.workspaceId],
        foreignColumns: [
          legalListItems.entityId,
          legalListItems.listId,
          legalListItems.workspaceId,
        ],
      })
      .onDelete("cascade"),
    p
      .index("legal_list_item_reviews_item_created_idx")
      .on(table.workspaceId, table.itemEntityId, table.createdAt, table.id),
    p.check(
      "legal_list_item_reviews_decision_check",
      sql`${table.decision} in ('verified', 'changes_requested', 'rejected')`,
    ),
    p.pgPolicy("workspace_select", {
      for: "select",
      to: stella,
      using: workspaceCheck,
    }),
    p.pgPolicy("workspace_insert", {
      for: "insert",
      to: stella,
      withCheck: workspaceCheck,
    }),
    p.pgPolicy("legal_list_item_reviews_no_update", {
      as: "restrictive",
      for: "update",
      to: stella,
      using: sql`false`,
    }),
    p.pgPolicy("legal_list_item_reviews_no_delete", {
      as: "restrictive",
      for: "delete",
      to: stella,
      using: sql`false`,
    }),
  ],
);
