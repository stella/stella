import { panic } from "better-result";
import { and, eq, inArray, isNull, or } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { anonymizationAllowlistEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { boundedAll } from "@/api/lib/db/bounded-all";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

/**
 * Org-wide allowlist rows a read may also return.
 *
 * Deliberately not in `LIMITS`: that table is serialized to the client on every
 * workspace read, and this is a server-side read capacity allowance the client
 * has no use for. There is no writer for org-wide rows today —
 * `anonymization-allowlist/create` always stamps a workspace — so this is an
 * allowance rather than an enforced cap, and the endpoint that first writes one
 * is the one that must enforce it.
 */
const ALLOWLIST_ORG_WIDE_ALLOWANCE = 1000;

/**
 * Bound for a complete allowlist read, wherever one happens.
 *
 * Both readers union three scopes: org-wide rows, a workspace's own rows, and
 * a requested entity's. Only the workspace cap has a writer enforcing it, so
 * the bound is that cap plus the org-wide allowance. Bounding by the workspace
 * cap alone would panic a workspace at its cap the moment a single org-wide
 * row exists — on the list endpoint and, worse, on the masking loader, where
 * a failed read is a document that goes out unmasked.
 */
const allowlistReadBound = (workspaceCount: number): number =>
  LIMITS.anonymizationAllowlistEntriesPerWorkspace * workspaceCount +
  ALLOWLIST_ORG_WIDE_ALLOWANCE;

export const ALLOWLIST_READ_BOUND = allowlistReadBound(1);

export const ALLOWLIST_READ_INVARIANT =
  "LIMITS.anonymizationAllowlistEntriesPerWorkspace (enforced by the create endpoint) plus ALLOWLIST_ORG_WIDE_ALLOWANCE (capacity allowance; org-wide rows have no writer yet)";

/**
 * Server-side helper that returns the canonicals the user (or
 * an org admin) has marked as false positives, so the chat-anon
 * pipeline can pass them through as `excludedCanonicals`.
 *
 * Scopes returned, in the same union the inspector facet shows:
 *   - org-wide                (workspace_id IS NULL, entity_id IS NULL)
 *   - workspace-wide          (workspace_id = $, entity_id IS NULL)
 *   - document-scoped         (workspace_id = $, entity_id = $)
 *
 * When the caller doesn't have an `entityId` (e.g. chat content
 * not tied to a specific file), the document scope is skipped
 * and only the broader two tiers apply.
 */
export const loadAnonymizationAllowlistCanonicals = async ({
  organizationId,
  scopeId,
  entityId,
  scopedDb,
}: {
  organizationId: SafeId<"organization">;
  /**
   * Plain string at the seam so the chat boundary can pass its
   * anonymization scope id directly (which is a workspace UUID
   * for workspace-bound threads and a thread id for global
   * threads — the latter never matches a workspace row, so it
   * collapses cleanly to the org-wide branch).
   */
  scopeId?: string | undefined;
  entityId?: SafeId<"entity"> | undefined;
  scopedDb: ScopedDb;
}): Promise<string[]> => {
  const branded = scopeId ? brandPersistedWorkspaceId(scopeId) : undefined;
  const scopeMatch = branded
    ? or(
        and(
          isNull(anonymizationAllowlistEntries.workspaceId),
          isNull(anonymizationAllowlistEntries.entityId),
        ),
        and(
          eq(anonymizationAllowlistEntries.workspaceId, branded),
          isNull(anonymizationAllowlistEntries.entityId),
        ),
        entityId
          ? and(
              eq(anonymizationAllowlistEntries.workspaceId, branded),
              eq(anonymizationAllowlistEntries.entityId, entityId),
            )
          : undefined,
      )
    : and(
        isNull(anonymizationAllowlistEntries.workspaceId),
        isNull(anonymizationAllowlistEntries.entityId),
      );

  const rows = await scopedDb(
    async (tx) =>
      await boundedAll({
        // Same three scopes as the list endpoint, so the same bound: the
        // org-wide branch is read whether or not a workspace scope is given,
        // and a masking loader that panics leaves a document unmasked.
        invariant: ALLOWLIST_READ_INVARIANT,
        max: ALLOWLIST_READ_BOUND,
        table: "anonymization_allowlist_entries",
        query: (limit) =>
          tx
            .select({ canonical: anonymizationAllowlistEntries.canonical })
            .from(anonymizationAllowlistEntries)
            .where(
              and(
                eq(
                  anonymizationAllowlistEntries.organizationId,
                  organizationId,
                ),
                scopeMatch,
              ),
            )
            .limit(limit),
      }),
  );

  return rows.map((row) => row.canonical);
};

/**
 * The same allowlist as {@link loadAnonymizationAllowlistCanonicals}, resolved
 * for a whole set of workspaces in one read.
 *
 * Two of the three scopes apply here: org-wide (workspace_id IS NULL) and
 * workspace-wide. The document scope is deliberately absent, exactly as it is
 * for a single-scope read with no `entityId`: a caller batching several
 * workspaces is anonymizing a payload, not one entity's text.
 *
 * The returned map has an entry for every requested id, so a lookup that
 * misses is a bug rather than a workspace with nothing allowlisted.
 */
export const loadAnonymizationAllowlistCanonicalsByWorkspace = async ({
  organizationId,
  scopedDb,
  workspaceIds,
}: {
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
  /**
   * Plain strings at the seam, like `scopeId` above. An id that names no
   * workspace row (a chat thread id, or the organization's own id, which is
   * how the redactor spells the org-wide scope) collapses to the org-wide
   * branch, so it is kept out of the workspace predicate.
   */
  workspaceIds: readonly string[];
}): Promise<Map<string, string[]>> => {
  const requestedIds = [...new Set(workspaceIds)];
  const scopedIds = requestedIds
    .filter((scopeId) => scopeId !== organizationId)
    .map(brandPersistedWorkspaceId);
  const scopeMatch =
    scopedIds.length > 0
      ? or(
          isNull(anonymizationAllowlistEntries.workspaceId),
          inArray(anonymizationAllowlistEntries.workspaceId, scopedIds),
        )
      : isNull(anonymizationAllowlistEntries.workspaceId);

  const rows = await scopedDb(
    async (tx) =>
      await boundedAll({
        invariant: ALLOWLIST_READ_INVARIANT,
        max: allowlistReadBound(scopedIds.length),
        table: "anonymization_allowlist_entries",
        query: (limit) =>
          tx
            .select({
              canonical: anonymizationAllowlistEntries.canonical,
              workspaceId: anonymizationAllowlistEntries.workspaceId,
            })
            .from(anonymizationAllowlistEntries)
            .where(
              and(
                eq(
                  anonymizationAllowlistEntries.organizationId,
                  organizationId,
                ),
                isNull(anonymizationAllowlistEntries.entityId),
                scopeMatch,
              ),
            )
            .limit(limit),
      }),
  );

  const byWorkspace = new Map<string, string[]>(
    requestedIds.map((scopeId) => [scopeId, []]),
  );
  for (const row of rows) {
    if (row.workspaceId === null) {
      for (const canonicals of byWorkspace.values()) {
        canonicals.push(row.canonical);
      }
      continue;
    }

    const canonicals = byWorkspace.get(row.workspaceId);
    if (canonicals === undefined) {
      return panic(
        "Allowlist row outside the requested workspace set; the read predicate and the grouping disagree",
        { table: "anonymization_allowlist_entries" },
      );
    }
    canonicals.push(row.canonical);
  }

  return byWorkspace;
};
