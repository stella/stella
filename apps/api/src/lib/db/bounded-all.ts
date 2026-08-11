import { panic } from "better-result";

/**
 * Complete read of a set whose cardinality is capped somewhere else.
 *
 * A handful of reads genuinely need every row: the anonymization
 * gazetteer (a missing term under-masks a document), the never-mask
 * allowlist (a missing term over-masks one), the case-law source
 * catalogue. Each is bounded by an invariant that lives outside the
 * query (a write-path cap, a unique index over a code-defined key
 * domain), so the query itself carries no `LIMIT` and `require-query-
 * limit` has to be suppressed with a prose promise nobody re-checks.
 *
 * The two ways to answer that lint are both wrong for such a read.
 * Adding `.limit(cap)` truncates silently the moment the invariant
 * breaks, which for masking data means shipping an unmasked name.
 * Suppressing the rule keeps the read honest but drops the invariant
 * on the floor: nothing observes it, so its erosion is discovered by
 * the consequence rather than by the cause.
 *
 * `boundedAll` asks for `max + 1` rows instead. Up to `max` rows, the
 * set is complete and returned whole. A `max + 1`-th row proves the
 * claimed invariant no longer holds, which is a defect in the write
 * path or the bound rather than a runtime condition a caller could
 * handle, so it panics with the invariant, table, and bound attached
 * instead of returning a set the caller would treat as complete.
 *
 * The read stays bounded either way: at most `max + 1` rows ever
 * reach memory, which is what `require-query-limit` exists to
 * guarantee. Callers pass the bound into their own query, so the
 * `.limit(...)` the rule looks for is right there in the chain and no
 * disable directive is needed.
 *
 * ```ts
 * const terms = await boundedAll({
 *   invariant: "LIMITS.anonymizationBlacklistEntriesPerWorkspace",
 *   max: LIMITS.anonymizationBlacklistEntriesPerWorkspace,
 *   table: "anonymization_blacklist_entries",
 *   query: (limit) =>
 *     tx
 *       .select({ canonical: anonymizationBlacklistEntries.canonical })
 *       .from(anonymizationBlacklistEntries)
 *       .where(eq(anonymizationBlacklistEntries.workspaceId, workspaceId))
 *       .orderBy(asc(anonymizationBlacklistEntries.canonical))
 *       .limit(limit),
 * });
 * ```
 */
export type BoundedAllOptions<TRow> = {
  /**
   * What bounds the set, named the way a reader could go verify it:
   * the `LIMITS.*` cap and the write path that enforces it, or the
   * unique index and key domain that make the row count finite.
   */
  invariant: string;
  /** Largest row count the invariant admits. */
  max: number;
  /** Table being read whole, for the panic's structured context. */
  table: string;
  /**
   * Builds the read with the bound applied. The callback receives
   * `max + 1`, not `max`: the extra row is the overflow probe, and it
   * is never returned to the caller.
   */
  query: (limit: number) => PromiseLike<TRow[]>;
};

export const boundedAll = async <TRow>({
  invariant,
  max,
  table,
  query,
}: BoundedAllOptions<TRow>): Promise<TRow[]> => {
  const rows = await query(max + 1);

  if (rows.length > max) {
    return panic(
      `Bounded read of ${table} exceeded its ${max}-row bound; ${invariant} no longer holds`,
      { invariant, table, max, observed: rows.length },
    );
  }

  return rows;
};
