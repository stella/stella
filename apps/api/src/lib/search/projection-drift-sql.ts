import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * Detection queries for the three drifted-projection shapes the standing
 * reconcilers repair. Kept apart from the reconciler itself so the predicates
 * can be exercised against a real database without pulling in the projection
 * writers.
 *
 * Every entity, contact, and matter mutation updates its search projection
 * through an unawaited post-commit call, so a call lost to a restart is never
 * retried: the source row stays unfindable, or the read fence keeps serving
 * text from before the last edit. Both shapes are detected here as
 * "projection row absent" and "projection row older than its source".
 */

/**
 * Rows repaired per projection per run. The bound is what makes a
 * five-minute cadence cheap: each run repairs at most this many rows per
 * projection, oldest projection first, and the next run picks up whatever is
 * left. Nothing here is a cursor — a repaired row simply stops matching.
 */
export const SEARCH_PROJECTION_REPAIR_BATCH_SIZE = 100;

/**
 * Matters sealed for deletion are mid-teardown: their rows are about to be
 * removed and their projection with them. Reindexing one races the cascade
 * and can only produce work the delete then throws away.
 */
const WORKSPACE_STATUS_DELETING = "deleting";

/**
 * Missing projections sort ahead of every stale one. A row that was never
 * written is not findable at all, which is strictly worse than one serving
 * text from an earlier edit.
 */
const stalenessOrder = (indexedAt: SQL): SQL =>
  sql`COALESCE(${indexedAt}, '-infinity'::timestamptz)`;

/**
 * Entities whose `search_documents` row is missing or predates the entity.
 *
 * `upsertSearchDocument` writes `updated_at` as `COALESCE(e.updated_at,
 * e.created_at)` under a compare-and-set on that same value, so the
 * projection can trail the entity but never lead it; `<` is therefore the
 * whole drift space. Entities are hard-deleted and the projection row
 * cascades with them, so driving the scan from `entities` cannot resurrect a
 * deleted document. An entity without a current version has no document to
 * project.
 */
// oxlint-disable-next-line require-search-scope/require-search-scope -- system reconciler detecting drifted projection rows across all tenants; it returns ids to reindex, never request data
export const staleEntitySearchDocumentsQuery = (limit: number): SQL => sql`
  SELECT e.id AS "id"
  FROM entities e
  INNER JOIN workspaces w ON w.id = e.workspace_id
  LEFT JOIN search_documents sd ON sd.entity_id = e.id
  WHERE e.current_version_id IS NOT NULL
    AND w.status <> ${WORKSPACE_STATUS_DELETING}
    AND (
      sd.entity_id IS NULL
      OR sd.updated_at < COALESCE(e.updated_at, e.created_at)
    )
  ORDER BY ${stalenessOrder(sql`sd.updated_at`)}, e.id
  LIMIT ${limit}
`;

/**
 * Contacts whose `contact_search_documents` row is missing or predates the
 * contact. `updated_at` is copied straight from `contacts.updated_at`, which
 * the schema maintains on every write. Contacts are hard-deleted and the
 * projection row cascades with them.
 */
// oxlint-disable-next-line require-search-scope/require-search-scope -- system reconciler detecting drifted projection rows across all tenants; it returns ids to reindex, never request data
export const staleContactSearchDocumentsQuery = (limit: number): SQL => sql`
  SELECT c.id AS "id"
  FROM contacts c
  LEFT JOIN contact_search_documents csd ON csd.contact_id = c.id
  WHERE csd.contact_id IS NULL
     OR csd.updated_at < c.updated_at
  ORDER BY ${stalenessOrder(sql`csd.updated_at`)}, c.id
  LIMIT ${limit}
`;

/**
 * Matters whose `workspace_search_documents` row is missing or predates the
 * inputs it projects.
 *
 * A matter has no `updated_at` of its own: `upsertWorkspaceSearchDocument`
 * stores the latest of the matter's own timestamps and the timestamps of
 * every contact whose text it folds in (the client and each party), because
 * editing a party changes the matter's searchable text. The detection has to
 * recompute the same maximum or a party rename would never be picked up.
 * `GREATEST` ignores nulls, and `created_at` / `last_activity_at` are both
 * non-null, so the expression is always defined. Matters are hard-deleted
 * and the projection row cascades with them.
 */
// oxlint-disable-next-line require-search-scope/require-search-scope -- system reconciler detecting drifted projection rows across all tenants; it returns ids to reindex, never request data
export const staleWorkspaceSearchDocumentsQuery = (limit: number): SQL => sql`
  SELECT w.id AS "id"
  FROM workspaces w
  LEFT JOIN workspace_search_documents wsd ON wsd.workspace_id = w.id
  LEFT JOIN contacts client ON client.id = w.client_id
  LEFT JOIN LATERAL (
    SELECT max(party.updated_at) AS updated_at
    FROM workspace_contacts wc
    INNER JOIN contacts party ON party.id = wc.contact_id
    WHERE wc.workspace_id = w.id
  ) parties ON TRUE
  WHERE w.status <> ${WORKSPACE_STATUS_DELETING}
    AND (
      wsd.workspace_id IS NULL
      OR wsd.updated_at < GREATEST(
        w.created_at,
        w.last_activity_at,
        client.updated_at,
        parties.updated_at
      )
    )
  ORDER BY ${stalenessOrder(sql`wsd.updated_at`)}, w.id
  LIMIT ${limit}
`;
