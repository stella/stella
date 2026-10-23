import { panic } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as v from "valibot";

import { SECTION_UNITS } from "@stll/legal-atlas/provision-citation-profile";

import {
  caseLawProvisionCitations,
  caseLawSources,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { LIMITS } from "@/api/lib/limits";

/**
 * A provision a search is narrowed to: the decisions whose recorded provision
 * links cite it. The section is required; each level below narrows, and a
 * level left out matches every value of it, so `§ 316` matches a link to
 * `§ 316 odst. 2` while `§ 316 odst. 2` does not match `§ 316 odst. 1`.
 *
 * The structured columns are compared rather than the anchor string: an
 * anchor prefix would need its wildcard characters escaped and would let
 * `par_31` reach `par_316`.
 */
export const caseLawProvisionFilterSchema = v.object({
  jurisdiction: v.optional(v.literal("EU")),
  work: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  unit: v.picklist(SECTION_UNITS),
  section: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(99_999)),
  sectionSuffix: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(8))),
  subsection: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(8))),
  letter: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(8))),
  point: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(8))),
});

export type CaseLawProvisionFilter = v.InferOutput<
  typeof caseLawProvisionFilterSchema
>;

type ProvisionScopeOptions = {
  /** The citing decisions' country; EU targets override the link jurisdiction. */
  jurisdiction: string;
  provision: CaseLawProvisionFilter;
};

/**
 * A path value as links store it: lowercase, no leading zeros, the form the
 * citation resolver mints. A caller spelling `G` or `02` reads the same link.
 */
const canonicalPathValue = (value: string) =>
  value.toLowerCase().replace(/^0+(?=\d)/u, "");

/**
 * The link rows that cite the provision, level by level. The leading
 * jurisdiction and work equalities are the prefix of the links' work index,
 * so a read of every decision citing a provision walks that index rather
 * than the table.
 */
const provisionLinkConditions = ({
  jurisdiction,
  provision,
}: ProvisionScopeOptions): SQL[] => {
  const link = caseLawProvisionCitations;
  const levels: SQL[] = [
    sql`${link.jurisdiction} = ${provision.jurisdiction ?? jurisdiction}`,
    sql`${link.workIdentifier} = ${provision.work}`,
    sql`${link.unit} = ${provision.unit}`,
    sql`${link.section} = ${provision.section}`,
    provision.sectionSuffix === undefined
      ? sql`${link.sectionSuffix} IS NULL`
      : sql`${link.sectionSuffix} = ${canonicalPathValue(provision.sectionSuffix)}`,
  ];
  if (provision.jurisdiction === "EU") {
    // EU target identity does not name the citing country. Keep an id set and
    // its broad-set warning within the requested country's published corpus.
    levels.push(sql`EXISTS (
      SELECT 1 FROM ${publishedCaseLawDecisions}
      INNER JOIN ${caseLawSources} ON ${caseLawSources.id} = ${publishedCaseLawDecisions.sourceId}
      WHERE ${publishedCaseLawDecisions.id} = ${link.decisionId}
        AND ${publishedCaseLawDecisions.country} = ${jurisdiction}
        AND ${redistributableCaseLawSource}
    )`);
  }
  if (provision.subsection !== undefined) {
    levels.push(
      sql`${link.subsection} = ${canonicalPathValue(provision.subsection)}`,
    );
  }
  if (provision.letter !== undefined) {
    levels.push(sql`${link.letter} = ${canonicalPathValue(provision.letter)}`);
  }
  if (provision.point !== undefined) {
    levels.push(sql`${link.point} = ${canonicalPathValue(provision.point)}`);
  }
  return levels;
};

/**
 * Whether the correlated decision cites the provision. Correlated on the
 * decision id, which leads the links' unique index, so the predicate costs a
 * short index probe per candidate rather than a scan of the work's links.
 */
export const provisionCitedSql = ({
  decisionId,
  ...scope
}: ProvisionScopeOptions & {
  /** The decision id the predicate is correlated with. */
  decisionId: SQL;
}): SQL =>
  sql`EXISTS (SELECT 1 FROM ${caseLawProvisionCitations} WHERE ${sql.join(
    [
      sql`${caseLawProvisionCitations.decisionId} = ${decisionId}`,
      ...provisionLinkConditions(scope),
    ],
    sql` AND `,
  )})`;

/**
 * Every decision citing the provision, as the engine can filter by: the
 * whole set while it fits {@link LIMITS.caseLawProvisionIdSetMax}, so the
 * engine narrows natively with its totals and facets intact. A larger set is
 * reported by its exact size instead, and the search falls back to checking
 * each candidate it ranks.
 */
export type CaseLawProvisionScope =
  | { type: "decisions"; decisionIds: readonly SafeId<"caseLawDecision">[] }
  | { type: "broad"; citingDecisions: number };

export const readCaseLawProvisionScope = async (
  tx: CaseLawPublicReadTransaction,
  {
    idSetMax = LIMITS.caseLawProvisionIdSetMax,
    ...scope
  }: ProvisionScopeOptions & { idSetMax?: number },
): Promise<CaseLawProvisionScope> => {
  const link = caseLawProvisionCitations;
  const conditions = and(
    redistributableCaseLawSource,
    ...provisionLinkConditions(scope),
  );
  // Grouped rather than DISTINCT: the public read transaction exposes only
  // `select`, and a decision citing the provision at several levels is one.
  const rows = await tx
    .select({ decisionId: link.decisionId })
    .from(link)
    .innerJoin(
      publishedCaseLawDecisions,
      eq(publishedCaseLawDecisions.id, link.decisionId),
    )
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
    )
    .where(conditions)
    .groupBy(link.decisionId)
    .limit(idSetMax + 1);
  if (rows.length <= idSetMax) {
    return {
      type: "decisions",
      decisionIds: rows.map(({ decisionId }) => decisionId),
    };
  }
  const [count] = await tx
    .select({
      citingDecisions: sql<number>`count(DISTINCT ${link.decisionId})::int`,
    })
    .from(link)
    .innerJoin(
      publishedCaseLawDecisions,
      eq(publishedCaseLawDecisions.id, link.decisionId),
    )
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
    )
    .where(conditions);
  return {
    type: "broad",
    citingDecisions:
      count?.citingDecisions ?? panic("A count query returned no row"),
  };
};

/**
 * The ids of every decision citing the provision, as a subquery a page read
 * filters by. It drives from the links' work index, so a provision-only list
 * reads the provision's own links rather than probing every decision.
 */
export const citingDecisionIdsSubquery = (
  tx: CaseLawPublicReadTransaction,
  scope: ProvisionScopeOptions,
) =>
  tx
    .select({ decisionId: caseLawProvisionCitations.decisionId })
    .from(caseLawProvisionCitations)
    .where(and(...provisionLinkConditions(scope)));

/**
 * The first sentence of each decision that cites the provision, in text
 * order: what a provision-only list shows as the reason each decision is on
 * it.
 */
export const readProvisionCitingSentences = async (
  tx: CaseLawPublicReadTransaction,
  scope: ProvisionScopeOptions,
  decisionIds: readonly SafeId<"caseLawDecision">[],
): Promise<Map<string, string>> => {
  if (decisionIds.length === 0) {
    return new Map();
  }
  const link = caseLawProvisionCitations;
  const rows = await tx
    .select({
      decisionId: link.decisionId,
      // The earliest citing sentence in text order; the public read
      // transaction exposes only `select`, so DISTINCT ON is a grouped read.
      sentence: sql<string>`(array_agg(${link.sentenceText} ORDER BY ${link.spanStart}, ${link.anchor}))[1]`,
    })
    .from(link)
    .where(
      and(
        inArray(link.decisionId, decisionIds),
        ...provisionLinkConditions(scope),
      ),
    )
    .groupBy(link.decisionId)
    // One row per decision, by the grouping.
    .limit(decisionIds.length);
  return new Map(rows.map((row) => [String(row.decisionId), row.sentence]));
};
