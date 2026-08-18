/**
 * Which case-law jurisdictions share one physical corpus index.
 *
 * From generation `CASE_LAW_INDEX_GROUPING_FROM_GENERATION` on, a case-law
 * index id is `<generation>_<group>` rather than `<generation>_<country>`:
 * every country of a group projects into, and is queried from, the same
 * index. Earlier generations keep one index per country.
 *
 * The mapping is declared once here and rendered into SQL by
 * `caseLawIndexIdSql`, so the TypeScript id and the id Postgres derives in
 * queries and in the projection trigger come from the same declaration.
 * `case-law-index-groups.db.test.ts` proves the three renderings (TypeScript,
 * this fragment, and the migration's `case_law_corpus_index_id` function)
 * agree executably.
 */

import { panic } from "better-result";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { CaseLawJurisdiction } from "@/api/lib/legal-search/ingestion-constants";

/**
 * Index group of every declared jurisdiction. Total over
 * `CaseLawJurisdiction`: a new jurisdiction does not compile until it is
 * placed here.
 *
 * A group name is either the jurisdiction's own lowercase code (an index of
 * its own) or contains an underscore (an index shared by several
 * jurisdictions). A country outside this map falls back to its own lowercase
 * code, and a country code holds letters only, so a fallback can never name
 * a declared group: the two kinds of id share one namespace by construction.
 */
export const CASE_LAW_INDEX_GROUP_OF = {
  AUT: "aut",
  CZE: "cs_sk",
  EU: "eu",
  POL: "pol",
  SVK: "cs_sk",
} as const satisfies {
  [J in CaseLawJurisdiction]: Lowercase<J> | `${string}_${string}`;
};

export type CaseLawIndexGroup =
  (typeof CASE_LAW_INDEX_GROUP_OF)[CaseLawJurisdiction];

/** First case-law generation whose physical indexes are per group. */
export const CASE_LAW_INDEX_GROUPING_FROM_GENERATION = 3;

const isCaseLawJurisdictionKey = (
  value: string,
): value is CaseLawJurisdiction =>
  Object.hasOwn(CASE_LAW_INDEX_GROUP_OF, value);

const DECLARED_JURISDICTIONS: readonly CaseLawJurisdiction[] = Object.keys(
  CASE_LAW_INDEX_GROUP_OF,
).filter(isCaseLawJurisdictionKey);

/** Group names in declaration order, each once. */
export const CASE_LAW_INDEX_GROUP_NAMES: readonly CaseLawIndexGroup[] = [
  ...new Set(
    DECLARED_JURISDICTIONS.map(
      (jurisdiction) => CASE_LAW_INDEX_GROUP_OF[jurisdiction],
    ),
  ),
];

export const isCaseLawIndexGroup = (
  value: string,
): value is CaseLawIndexGroup =>
  CASE_LAW_INDEX_GROUP_NAMES.some((group) => group === value);

/** Group name to the jurisdictions it holds, in declaration order. */
export const CASE_LAW_INDEX_GROUPS: ReadonlyMap<
  CaseLawIndexGroup,
  readonly CaseLawJurisdiction[]
> = new Map(
  CASE_LAW_INDEX_GROUP_NAMES.map((group) => [
    group,
    DECLARED_JURISDICTIONS.filter(
      (jurisdiction) => CASE_LAW_INDEX_GROUP_OF[jurisdiction] === group,
    ),
  ]),
);

/** Lowercase index group of a country; its own code when unlisted. */
export const caseLawIndexGroup = (country: string): string => {
  const upper = country.toUpperCase();
  return isCaseLawJurisdictionKey(upper)
    ? CASE_LAW_INDEX_GROUP_OF[upper]
    : country.toLowerCase();
};

/** Countries an index group holds; the group's own code when unlisted. */
export const caseLawIndexGroupCountries = (
  group: string,
): readonly string[] => {
  if (!isCaseLawIndexGroup(group)) {
    return [group.toUpperCase()];
  }
  return (
    CASE_LAW_INDEX_GROUPS.get(group) ??
    panic(`Index group without members: ${group}`)
  );
};

/**
 * The generation-order match the backfill checkpoint's `generation_order`
 * column uses; a generation outside the canonical case-law form yields NULL,
 * and NULL never satisfies the range, so such a generation stays per
 * country.
 */
const CASE_LAW_GENERATION_ORDER_PATTERN = "^case_law_v([1-9][0-9]*)$";

/**
 * Largest generation order the checkpoint's integer column can hold. Past
 * it a digit run is not a case-law generation, for
 * `caseLawCorpusGenerationOrder` and for the fragment below alike; the
 * fragment compares in `numeric`, so a longer run is out of range rather
 * than a cast error.
 */
export const POSTGRES_INTEGER_MAX = 2_147_483_647;

/**
 * The index id as a SQL expression over a generation and a country, the same
 * mapping `corpusIndexId` applies. Constants are inlined with `sql.raw` (they
 * come from the declaration above, never from input) so the same text serves
 * as a function body in DDL, where bind parameters do not exist.
 */
export const caseLawIndexIdSql = (
  generation: SQLWrapper,
  country: SQLWrapper,
): SQL => {
  const groupArms = sql.join(
    DECLARED_JURISDICTIONS.map(
      (jurisdiction) =>
        sql`WHEN ${sql.raw(`'${jurisdiction}'`)} THEN ${sql.raw(`'${CASE_LAW_INDEX_GROUP_OF[jurisdiction]}'`)}`,
    ),
    sql`
    `,
  );
  return sql`CASE
  WHEN substring(${generation} from ${sql.raw(`'${CASE_LAW_GENERATION_ORDER_PATTERN}'`)})::numeric
       BETWEEN ${sql.raw(String(CASE_LAW_INDEX_GROUPING_FROM_GENERATION))}
       AND ${sql.raw(String(POSTGRES_INTEGER_MAX))}
  THEN ${generation} || '_' || CASE upper(${country})
    ${groupArms}
    ELSE lower(${country})
  END
  ELSE ${generation} || '_' || lower(${country})
END`;
};
