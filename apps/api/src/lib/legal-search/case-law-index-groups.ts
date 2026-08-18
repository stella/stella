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

import type { SQL, SQLWrapper } from "drizzle-orm";
import { sql } from "drizzle-orm";

/**
 * Group name to the countries it holds. A country absent from every group
 * forms its own group, named by its lowercase code, so an unlisted
 * jurisdiction still gets a deterministic index of its own.
 */
export const CASE_LAW_INDEX_GROUPS = {
  cs_sk: ["CZE", "SVK"],
  pl: ["POL"],
  eu: ["EU"],
  de: ["AUT", "DEU"],
} as const satisfies Record<string, readonly string[]>;

export type CaseLawIndexGroup = keyof typeof CASE_LAW_INDEX_GROUPS;

/** First case-law generation whose physical indexes are per group. */
export const CASE_LAW_INDEX_GROUPING_FROM_GENERATION = 3;

const isCaseLawIndexGroup = (value: string): value is CaseLawIndexGroup =>
  Object.hasOwn(CASE_LAW_INDEX_GROUPS, value);

/** Group names in declaration order. */
export const CASE_LAW_INDEX_GROUP_NAMES: readonly CaseLawIndexGroup[] =
  Object.keys(CASE_LAW_INDEX_GROUPS).filter(isCaseLawIndexGroup);

const GROUP_BY_COUNTRY: ReadonlyMap<string, CaseLawIndexGroup> = new Map(
  CASE_LAW_INDEX_GROUP_NAMES.flatMap((group) =>
    CASE_LAW_INDEX_GROUPS[group].map(
      (country) => [country, group] satisfies [string, CaseLawIndexGroup],
    ),
  ),
);

/** Lowercase index group of a country; its own code when unlisted. */
export const caseLawIndexGroup = (country: string): string =>
  GROUP_BY_COUNTRY.get(country.toUpperCase()) ?? country.toLowerCase();

/** Countries an index group holds; the group's own code when unlisted. */
export const caseLawIndexGroupCountries = (group: string): readonly string[] =>
  isCaseLawIndexGroup(group)
    ? CASE_LAW_INDEX_GROUPS[group]
    : [group.toUpperCase()];

/**
 * The generation-order match the backfill checkpoint's `generation_order`
 * column uses; a generation outside the canonical case-law form yields NULL,
 * and NULL never satisfies the threshold, so such a generation stays per
 * country.
 */
const CASE_LAW_GENERATION_ORDER_PATTERN = "^case_law_v([1-9][0-9]*)$";

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
    CASE_LAW_INDEX_GROUP_NAMES.flatMap((group) =>
      CASE_LAW_INDEX_GROUPS[group].map(
        (member) =>
          sql`WHEN ${sql.raw(`'${member}'`)} THEN ${sql.raw(`'${group}'`)}`,
      ),
    ),
    sql`
    `,
  );
  return sql`CASE
  WHEN substring(${generation} from ${sql.raw(`'${CASE_LAW_GENERATION_ORDER_PATTERN}'`)})::integer
       >= ${sql.raw(String(CASE_LAW_INDEX_GROUPING_FROM_GENERATION))}
  THEN ${generation} || '_' || CASE upper(${country})
    ${groupArms}
    ELSE lower(${country})
  END
  ELSE ${generation} || '_' || lower(${country})
END`;
};
