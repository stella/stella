/**
 * How much of the morphological query expansion is live.
 *
 * - `off`    Queries are built exactly as they were before expansion
 *            existed. No dictionary is fetched and no query byte changes.
 * - `shadow` The expanded query is built and compared against the query that
 *            actually runs, which is still the unexpanded one. Only the
 *            comparison is recorded — leaf counts and a reach disposition,
 *            never the query text. This is how the rewrite is judged against
 *            real traffic before it serves any.
 * - `on`     The expanded query is what runs. Which dictionary a replica has
 *            loaded is part of the ranking, so a corpus cursor names the
 *            dictionary its page was built against and a continuation
 *            resolved against another one is refused as a stale cursor rather
 *            than served from a different result set.
 *
 * Resolved once in `env-base`; every consumer reads that single value.
 *
 * A leaf module with no imports, for the same reason `corpus-storage-mode`
 * is one: `env-base` imports it, and every project that typechecks `env-base`
 * would otherwise pull in the search graph behind it.
 */
export const QUERY_EXPANSION_MODES = ["off", "shadow", "on"] as const;

export type QueryExpansionMode = (typeof QUERY_EXPANSION_MODES)[number];
