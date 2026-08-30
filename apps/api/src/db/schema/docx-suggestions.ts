import type {
  FolioAIEditApplyMode,
  FolioAIEditSeverity,
} from "@stll/folio-core/ai-edits";

import { chatThreads } from "./chat";
import {
  type AnyPgColumn,
  jsonb,
  p,
  pUuid,
  safeUuid,
  safeWorkspaceId,
  user,
  wsDataScopePolicies,
  timestamptz,
} from "./common";
import { entities } from "./entities";

/**
 * Lifecycle of a persisted AI DOCX suggestion. A named union, not a
 * pair of booleans, so a fourth state is a deliberate schema change
 * rather than a new flag combination:
 *  - "pending"  : proposed, awaiting review (visible in the panel/bar).
 *  - "accepted" : applied to the document as the reviewing user.
 *  - "rejected" : dismissed.
 */
export const DOCX_SUGGESTION_STATUSES = [
  "pending",
  "accepted",
  "rejected",
] as const;
export type DocxSuggestionStatus = (typeof DOCX_SUGGESTION_STATUSES)[number];

/**
 * Severity the AI assigned, plus `unspecified` for the review store's
 * legacy/unclassified rows.
 */
export type DocxSuggestionSeverity = FolioAIEditSeverity | "unspecified";

export const DOCX_SUGGESTION_SEVERITIES = [
  "low",
  "medium",
  "high",
  "unspecified",
] as const satisfies readonly DocxSuggestionSeverity[];

type MissingDocxSuggestionSeverity = Exclude<
  DocxSuggestionSeverity,
  (typeof DOCX_SUGGESTION_SEVERITIES)[number]
>;

true satisfies MissingDocxSuggestionSeverity extends never ? true : never;

export type DocxSuggestionApplyMode = FolioAIEditApplyMode;

/** Mode a suggestion was applied in. */
export const DOCX_SUGGESTION_APPLY_MODES = [
  "tracked-changes",
  "direct",
  "suggested",
] as const satisfies readonly DocxSuggestionApplyMode[];

type MissingDocxSuggestionApplyMode = Exclude<
  DocxSuggestionApplyMode,
  (typeof DOCX_SUGGESTION_APPLY_MODES)[number]
>;

true satisfies MissingDocxSuggestionApplyMode extends never ? true : never;

/**
 * Persisted AI DOCX review suggestions, so a review session survives a
 * reload and leaves an audit trail of who resolved what, when.
 *
 * `opPayload` stays opaque at the database boundary. Writes validate it as a
 * `FolioAIEditOperation`; reads validate it again because existing rows and
 * direct database writes are not covered by TypeScript. The web client then
 * re-derives block id, summary, and the inline preview from it against the live
 * document snapshot, so no denormalized render fields are stored.
 */
export const docxSuggestions = p.pgTable(
  "docx_suggestions",
  {
    id: pUuid<"docxSuggestion">().primaryKey(),
    // No direct workspaces FK: the composite FK below binds (entity_id,
    // workspace_id) to entities, and entities already cascade from a
    // workspace delete — mirrors entity_versions. The composite FK also
    // makes it impossible to attach a suggestion to an entity in a
    // different workspace than the (server-validated) workspace_id.
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    // Nullable + set-null: the suggestion outlives the chat thread it came
    // from, keeping the audit trail intact if the thread is later deleted.
    originThreadId: safeUuid<"chatThread">("origin_thread_id").references(
      (): AnyPgColumn => chatThreads.id,
      { onDelete: "set null" },
    ),
    /**
     * Matters whose content contributed to this suggestion, carried over from
     * the originating thread's own data scope and narrowed to what the author
     * could read at the time. Empty means nothing outside this matter fed it.
     * Non-empty values gate RLS reads the way `chat_threads.data_workspace_ids`
     * does, so model text restating another matter cannot outlive access to it.
     */
    sourceDataWorkspaceIds: safeWorkspaceId("source_data_workspace_ids")
      .array()
      .notNull()
      .default([]),
    /** Opaque durable JSON; validate at every read and write boundary. */
    opPayload: jsonb("op_payload").notNull(),
    /** AI rationale / reviewer note, when the model supplied one. */
    comment: p.text("comment"),
    severity: p
      .text("severity", { enum: DOCX_SUGGESTION_SEVERITIES })
      .notNull(),
    area: p.varchar("area", { length: 128 }).notNull(),
    status: p
      .text("status", { enum: DOCX_SUGGESTION_STATUSES })
      .notNull()
      .default("pending"),
    /** Mode the op was applied in; null until resolved as accepted. */
    appliedMode: p.text("applied_mode", { enum: DOCX_SUGGESTION_APPLY_MODES }),
    // Nullable + set-null on user delete, like entities.createdBy: an account
    // deletion is never blocked by an old resolution record.
    resolvedByUserId: p
      .text("resolved_by_user_id")
      .references(() => user.id, { onDelete: "set null" }),
    resolvedAt: timestamptz("resolved_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    // Status-scoped lookups within an entity (task-specified).
    p
      .index("docx_suggestions_ws_entity_status_idx")
      .on(table.workspaceId, table.entityId, table.status),
    // Keyset pagination: list an entity's suggestions oldest-first by
    // (created_at, id) within the workspace tenant scope.
    p
      .index("docx_suggestions_ws_entity_created_idx")
      .on(table.workspaceId, table.entityId, table.createdAt, table.id),
    p
      .index("docx_suggestions_source_data_workspace_ids_idx")
      .using("gin", table.sourceDataWorkspaceIds),
    p
      .foreignKey({
        name: "docx_suggestions_entity_fk",
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    ...wsDataScopePolicies("source_data_workspace_ids"),
  ],
);
