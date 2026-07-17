import { chatThreads } from "./chat";
import {
  type AnyPgColumn,
  jsonb,
  p,
  pUuid,
  safeUuid,
  safeWorkspaceId,
  user,
  wsPolicies,
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
 * Severity the AI assigned. Mirrors folio's `FolioAIEditSeverity`
 * (`low | medium | high`) plus `unspecified` for the review store's
 * legacy/unclassified rows.
 */
export const DOCX_SUGGESTION_SEVERITIES = [
  "low",
  "medium",
  "high",
  "unspecified",
] as const;
export type DocxSuggestionSeverity =
  (typeof DOCX_SUGGESTION_SEVERITIES)[number];

/** Mode a suggestion was applied in. Mirrors `FolioAIEditApplyMode`. */
export const DOCX_SUGGESTION_APPLY_MODES = [
  "tracked-changes",
  "direct",
] as const;
export type DocxSuggestionApplyMode =
  (typeof DOCX_SUGGESTION_APPLY_MODES)[number];

/**
 * Persisted AI DOCX review suggestions, so a review session survives a
 * reload and leaves an audit trail of who resolved what, when.
 *
 * `opPayload` is stored opaquely (the client-prepared `FolioAIEditOperation`):
 * the server never introspects it, only persists and returns it. The web
 * client re-derives block id, summary, and the inline preview from it against
 * the live document snapshot on hydration, so no denormalized render fields
 * are stored. Re-applying a hydrated suggestion in folio "suggested" mode is
 * deferred (needs the folio release); today hydrated rows render in the
 * panel/bar and accept through the existing operation-apply path.
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
    /** The client-prepared editor operation; opaque to the server. */
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
    resolvedAt: p.timestamp("resolved_at"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
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
      .foreignKey({
        name: "docx_suggestions_entity_fk",
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    ...wsPolicies(),
  ],
);
