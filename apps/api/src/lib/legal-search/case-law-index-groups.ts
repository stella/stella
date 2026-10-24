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
 *
 * The mapping is per generation. `CASE_LAW_INDEX_GROUP_OF` is the one every
 * generation is created with; `CASE_LAW_INDEX_GROUP_REHOMES` moves a
 * jurisdiction to another group from a later generation on. A generation that
 * exists keeps the group it was created with, so its index ids, fingerprints
 * and digests never move; the new group is built beside it and served only
 * through the gated flip (`case-law-serving-flip.ts`).
 */

import type { SQL, SQLWrapper } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";

type GroupName<J extends CaseLawJurisdiction> =
  Lowercase<J> | `${string}_${string}`;

/**
 * Index group of every declared jurisdiction in the generations that were
 * created with it. Total over `CaseLawJurisdiction`: a new jurisdiction does
 * not compile until it is placed here.
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
  HUN: "hun",
  POL: "pol",
  SVK: "cs_sk",
  USA: "usa",
} as const satisfies {
  [J in CaseLawJurisdiction]: GroupName<J>;
};

/**
 * Jurisdictions that move to a group of their own from a later generation on.
 * The generations before keep `CASE_LAW_INDEX_GROUP_OF`, which is what lets
 * the new group be built beside the serving one and switched to by a gated
 * flip instead of by a deploy.
 */
export const CASE_LAW_INDEX_GROUP_REHOMES = {
  CZE: { group: "cze", fromGeneration: 9 },
} as const satisfies {
  [J in CaseLawJurisdiction]?: {
    group: GroupName<J>;
    fromGeneration: number;
  };
};

type RehomedJurisdiction = keyof typeof CASE_LAW_INDEX_GROUP_REHOMES;

export type CaseLawIndexGroup =
  | (typeof CASE_LAW_INDEX_GROUP_OF)[CaseLawJurisdiction]
  | (typeof CASE_LAW_INDEX_GROUP_REHOMES)[RehomedJurisdiction]["group"];

/**
 * Group contracts beyond the generation's own manifest. A group under one of
 * these is created with an effective index configuration derived from, but
 * not equal to, the manifest's, and is enrolled and attested per group
 * (`corpus-index-group-contract.ts`).
 */
const CORPUS_INDEX_GROUP_CONTRACT_VERSIONS = [
  "court_partition_v1",
  "provision_keys_v1",
] as const;

export type CorpusIndexGroupContractVersion =
  (typeof CORPUS_INDEX_GROUP_CONTRACT_VERSIONS)[number];

/**
 * The contracts a group enrollment row may record: a group contract, or
 * `base` for a group under its manifest's contract that was declared after
 * the generation was created and is enrolled once its index exists.
 */
export const CORPUS_INDEX_ENROLLMENT_CONTRACTS = [
  "base",
  ...CORPUS_INDEX_GROUP_CONTRACT_VERSIONS,
] as const;

/**
 * The contract each case-law index group is created under. Total, so a new
 * group answers explicitly: `base` keeps the manifest's configuration exactly,
 * which is what every group that existed before a group contract did.
 */
export const CASE_LAW_INDEX_GROUP_CONTRACT_OF = {
  aut: "base",
  cs_sk: "base",
  cze: "provision_keys_v1",
  eu: "base",
  hun: "base",
  pol: "base",
  usa: "court_partition_v1",
} as const satisfies Record<
  CaseLawIndexGroup,
  "base" | CorpusIndexGroupContractVersion
>;

/** First case-law generation whose physical indexes are per group. */
export const CASE_LAW_INDEX_GROUPING_FROM_GENERATION = 3;

const isCaseLawJurisdictionKey = (
  value: string,
): value is CaseLawJurisdiction =>
  Object.hasOwn(CASE_LAW_INDEX_GROUP_OF, value);

const isRehomedJurisdiction = (
  value: CaseLawJurisdiction,
): value is RehomedJurisdiction =>
  Object.hasOwn(CASE_LAW_INDEX_GROUP_REHOMES, value);

const DECLARED_JURISDICTIONS: readonly CaseLawJurisdiction[] = Object.keys(
  CASE_LAW_INDEX_GROUP_OF,
).filter(isCaseLawJurisdictionKey);

/**
 * The group of a jurisdiction in the grouped case-law generation of this
 * order. An order below the rehome's keeps the group the generation was
 * created with.
 */
const groupOfJurisdictionAt = (
  order: number,
  jurisdiction: CaseLawJurisdiction,
): CaseLawIndexGroup => {
  if (isRehomedJurisdiction(jurisdiction)) {
    const rehome = CASE_LAW_INDEX_GROUP_REHOMES[jurisdiction];
    if (order >= rehome.fromGeneration) {
      return rehome.group;
    }
  }
  return CASE_LAW_INDEX_GROUP_OF[jurisdiction];
};

/**
 * Group names in declaration order, each once, across every generation: the
 * groups a generation was created with, then the groups jurisdictions were
 * rehomed to.
 */
export const CASE_LAW_INDEX_GROUP_NAMES: readonly CaseLawIndexGroup[] = [
  ...new Set<CaseLawIndexGroup>([
    ...DECLARED_JURISDICTIONS.map(
      (jurisdiction) => CASE_LAW_INDEX_GROUP_OF[jurisdiction],
    ),
    ...DECLARED_JURISDICTIONS.filter(isRehomedJurisdiction).map(
      (jurisdiction) => CASE_LAW_INDEX_GROUP_REHOMES[jurisdiction].group,
    ),
  ]),
];

export const isCaseLawIndexGroup = (
  value: string,
): value is CaseLawIndexGroup =>
  CASE_LAW_INDEX_GROUP_NAMES.some((group) => group === value);

/**
 * Group name to every jurisdiction that is ever in it, in declaration order.
 * Which of them a given generation holds is `caseLawIndexGroupCountriesAt`.
 */
export const CASE_LAW_INDEX_GROUPS: ReadonlyMap<
  CaseLawIndexGroup,
  readonly CaseLawJurisdiction[]
> = new Map(
  CASE_LAW_INDEX_GROUP_NAMES.map((group) => [
    group,
    DECLARED_JURISDICTIONS.filter(
      (jurisdiction) =>
        CASE_LAW_INDEX_GROUP_OF[jurisdiction] === group ||
        (isRehomedJurisdiction(jurisdiction) &&
          CASE_LAW_INDEX_GROUP_REHOMES[jurisdiction].group === group),
    ),
  ]),
);

/**
 * Lowercase index group of a country in the grouped generation of this order;
 * its own code when unlisted.
 */
export const caseLawIndexGroupAt = (order: number, country: string): string => {
  const canonical = country.toUpperCase();
  return isCaseLawJurisdictionKey(canonical)
    ? groupOfJurisdictionAt(order, canonical)
    : country.toLowerCase();
};

/** The groups the grouped generation of this order has, in declaration order. */
export const caseLawIndexGroupNamesAt = (
  order: number,
): readonly CaseLawIndexGroup[] => [
  ...new Set(
    DECLARED_JURISDICTIONS.map((jurisdiction) =>
      groupOfJurisdictionAt(order, jurisdiction),
    ),
  ),
];

/**
 * Countries an index group holds in the grouped generation of this order; the
 * group's own code when unlisted.
 */
export const caseLawIndexGroupCountriesAt = (
  order: number,
  group: string,
): readonly string[] => {
  if (!isCaseLawIndexGroup(group)) {
    return [group.toUpperCase()];
  }
  return DECLARED_JURISDICTIONS.filter(
    (jurisdiction) => groupOfJurisdictionAt(order, jurisdiction) === group,
  );
};

/** Whether documents of an index group carry the `provision_keys` field. */
const caseLawIndexGroupHasProvisionKeys = (group: string): boolean =>
  isCaseLawIndexGroup(group) &&
  CASE_LAW_INDEX_GROUP_CONTRACT_OF[group] === "provision_keys_v1";

/**
 * Whether a jurisdiction's documents carry the `provision_keys` field in any
 * generation. A generation that was created before the rehome writes none, so
 * the decision input carries the keys and each group's contract decides
 * whether they are written and fingerprinted.
 */
export const caseLawJurisdictionHasProvisionKeys = (
  jurisdiction: string,
): boolean =>
  isCaseLawJurisdictionKey(jurisdiction) &&
  isRehomedJurisdiction(jurisdiction) &&
  caseLawIndexGroupHasProvisionKeys(
    CASE_LAW_INDEX_GROUP_REHOMES[jurisdiction].group,
  );

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
  const order = sql`substring(${generation} from ${sql.raw(`'${CASE_LAW_GENERATION_ORDER_PATTERN}'`)})::numeric`;
  const groupArms = sql.join(
    DECLARED_JURISDICTIONS.map((jurisdiction) => {
      const base = sql.raw(`'${CASE_LAW_INDEX_GROUP_OF[jurisdiction]}'`);
      if (!isRehomedJurisdiction(jurisdiction)) {
        return sql`WHEN ${sql.raw(`'${jurisdiction}'`)} THEN ${base}`;
      }
      const rehome = CASE_LAW_INDEX_GROUP_REHOMES[jurisdiction];
      return sql`WHEN ${sql.raw(`'${jurisdiction}'`)} THEN CASE WHEN ${order} >= ${sql.raw(String(rehome.fromGeneration))} THEN ${sql.raw(`'${rehome.group}'`)} ELSE ${base} END`;
    }),
    sql`
    `,
  );
  return sql`CASE
  WHEN ${order}
       BETWEEN ${sql.raw(String(CASE_LAW_INDEX_GROUPING_FROM_GENERATION))}
       AND ${sql.raw(String(POSTGRES_INTEGER_MAX))}
  THEN ${generation} || '_' || CASE upper(${country})
    ${groupArms}
    ELSE lower(${country})
  END
  ELSE ${generation} || '_' || lower(${country})
END`;
};
