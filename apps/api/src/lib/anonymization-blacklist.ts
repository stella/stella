import { panic, Result } from "better-result";
import type { SQL } from "drizzle-orm";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";

import type { GazetteerEntry } from "@stll/anonymize";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { anonymizationBlacklistEntries } from "@/api/db/schema";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { boundedAll } from "@/api/lib/db/bounded-all";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

export type AnonymizationBlacklistEntryInput = {
  canonical: string;
  enabled?: boolean | undefined;
  label: string;
  variants?: string[] | undefined;
};

const normalizeTerm = (value: string): string => value.trim();

const normalizeVariants = (variants: readonly string[]): string[] => {
  const normalized = new Set<string>();

  for (const variant of variants) {
    const value = normalizeTerm(variant);
    if (value.length > 0) {
      normalized.add(value);
    }
  }

  return [...normalized];
};

export const normalizeAnonymizationBlacklistEntry = ({
  canonical,
  enabled,
  label,
  variants,
}: AnonymizationBlacklistEntryInput) => ({
  canonical: normalizeTerm(canonical),
  enabled: enabled ?? true,
  label: normalizeTerm(label),
  variants: normalizeVariants(arrayOrEmpty(variants)),
});

export const normalizeAnonymizationBlacklistEntries = (
  entries: AnonymizationBlacklistEntryInput[],
) => {
  const seenCanonical = new Set<string>();
  const normalized = [];

  for (const entry of entries) {
    const next = normalizeAnonymizationBlacklistEntry(entry);
    if (next.canonical.length === 0 || next.label.length === 0) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Anonymization blacklist terms cannot be blank",
        }),
      );
    }

    const canonicalKey = next.canonical.toLocaleLowerCase();

    if (seenCanonical.has(canonicalKey)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Duplicate anonymization blacklist term",
        }),
      );
    }

    seenCanonical.add(canonicalKey);
    normalized.push(next);
  }

  return Result.ok(normalized);
};

/**
 * The gazetteer is the union of the firm-wide catalog and the terms of every
 * workspace the read names, each capped on its own write path, so the caps
 * add up. A workspace-less load reads only the org-wide half and stays well
 * under the single-workspace bound.
 */
const gazetteerEntryBound = (workspaceCount: number): number =>
  LIMITS.anonymizationBlacklistEntriesPerOrganization +
  LIMITS.anonymizationBlacklistEntriesPerWorkspace * workspaceCount;

const GAZETTEER_ENTRY_INVARIANT =
  "LIMITS.anonymizationBlacklistEntriesPerOrganization + LIMITS.anonymizationBlacklistEntriesPerWorkspace per workspace the read names, enforced by the anonymization write-cap helpers";

/**
 * Which tier of the catalog a load reads:
 *   - `workspace`: the union of org-wide entries (workspace_id IS
 *     NULL — the firm default catalog) and that workspace's own terms.
 *   - `organization`: the org-wide half alone.
 *
 * A required discriminated field rather than an optional
 * `workspaceId`, so reading only the firm-wide half is always a stated
 * choice: a caller holding a workspace that omitted it would otherwise
 * redact against the narrower term set without saying so.
 */
export type AnonymizationGazetteerScope =
  | { type: "organization" }
  | { type: "workspace"; workspaceId: SafeId<"workspace"> };

type GazetteerRow = {
  canonical: string;
  createdAt: Date;
  id: SafeId<"anonymizationBlacklistEntry">;
  label: string;
  variants: string[];
  workspaceId: SafeId<"workspace"> | null;
};

const selectGazetteerRows = async ({
  max,
  organizationId,
  tx,
  workspaceMatch,
}: {
  max: number;
  organizationId: SafeId<"organization">;
  tx: Transaction;
  workspaceMatch: SQL | undefined;
}): Promise<GazetteerRow[]> =>
  await boundedAll({
    invariant: GAZETTEER_ENTRY_INVARIANT,
    max,
    table: "anonymization_blacklist_entries",
    query: (limit) =>
      tx
        .select({
          canonical: anonymizationBlacklistEntries.canonical,
          id: anonymizationBlacklistEntries.id,
          label: anonymizationBlacklistEntries.label,
          variants: anonymizationBlacklistEntries.variants,
          createdAt: anonymizationBlacklistEntries.createdAt,
          workspaceId: anonymizationBlacklistEntries.workspaceId,
        })
        .from(anonymizationBlacklistEntries)
        .where(
          and(
            eq(anonymizationBlacklistEntries.organizationId, organizationId),
            eq(anonymizationBlacklistEntries.enabled, true),
            workspaceMatch,
          ),
        )
        .orderBy(asc(anonymizationBlacklistEntries.canonical))
        .limit(limit),
  });

const toGazetteerEntry = (
  row: GazetteerRow,
  organizationId: SafeId<"organization">,
): GazetteerEntry => ({
  id: row.id,
  canonical: row.canonical,
  label: row.label,
  variants: row.variants,
  workspaceId: row.workspaceId ?? organizationId,
  createdAt: row.createdAt.getTime(),
  source: "manual",
});

export const loadAnonymizationGazetteerEntries = async ({
  organizationId,
  scope,
  scopedDb,
}: {
  organizationId: SafeId<"organization">;
  scope: AnonymizationGazetteerScope;
  scopedDb: ScopedDb;
}) => {
  const workspaceMatch =
    scope.type === "workspace"
      ? or(
          isNull(anonymizationBlacklistEntries.workspaceId),
          eq(anonymizationBlacklistEntries.workspaceId, scope.workspaceId),
        )
      : isNull(anonymizationBlacklistEntries.workspaceId);

  const rows = await scopedDb(
    async (tx) =>
      await selectGazetteerRows({
        max: gazetteerEntryBound(1),
        organizationId,
        tx,
        workspaceMatch,
      }),
  );

  return rows.map((row) => toGazetteerEntry(row, organizationId));
};

/**
 * The same catalog as {@link loadAnonymizationGazetteerEntries}, resolved for
 * a whole set of workspaces in one read: the org-wide half plus each named
 * workspace's own terms, grouped back per workspace.
 *
 * A caller anonymizing several workspaces in one payload would otherwise
 * issue this read once per workspace. The returned map has an entry for every
 * requested id, so a lookup that misses is a bug rather than a workspace with
 * no terms.
 */
export const loadAnonymizationGazetteerEntriesByWorkspace = async ({
  organizationId,
  scopedDb,
  workspaceIds,
}: {
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
  /**
   * Plain strings at the seam, like the allowlist loader's `scopeId`: the MCP
   * egress pipeline groups by the `workspaceId` its handlers attributed to
   * each field. An id equal to `organizationId` is the org-wide scope
   * (`AnonymizationGazetteerScope`'s "organization" branch) and matches no
   * workspace row, so it is served the firm-wide half alone.
   */
  workspaceIds: readonly string[];
}): Promise<Map<string, GazetteerEntry[]>> => {
  const requestedIds = [...new Set(workspaceIds)];
  const scopedIds = requestedIds
    .filter((scopeId) => scopeId !== organizationId)
    .map(brandPersistedWorkspaceId);
  const workspaceMatch =
    scopedIds.length > 0
      ? or(
          isNull(anonymizationBlacklistEntries.workspaceId),
          inArray(anonymizationBlacklistEntries.workspaceId, scopedIds),
        )
      : isNull(anonymizationBlacklistEntries.workspaceId);

  const rows = await scopedDb(
    async (tx) =>
      await selectGazetteerRows({
        max: gazetteerEntryBound(scopedIds.length),
        organizationId,
        tx,
        workspaceMatch,
      }),
  );

  const byWorkspace = new Map<string, GazetteerEntry[]>(
    requestedIds.map((scopeId) => [scopeId, []]),
  );
  // Rows arrive in canonical order; appending them in that order to every
  // workspace they belong to reproduces each single-scope read exactly,
  // org-wide terms interleaved with the workspace's own.
  for (const row of rows) {
    const entry = toGazetteerEntry(row, organizationId);
    if (row.workspaceId === null) {
      for (const entries of byWorkspace.values()) {
        entries.push(entry);
      }
      continue;
    }

    const entries = byWorkspace.get(row.workspaceId);
    if (entries === undefined) {
      return panic(
        "Gazetteer row outside the requested workspace set; the read predicate and the grouping disagree",
        { table: "anonymization_blacklist_entries" },
      );
    }
    entries.push(entry);
  }

  return byWorkspace;
};

// Org-wide custom regex rules belong here once @stll/anonymize exposes a
// safe first-class custom regex detector API.
