import { panic } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as v from "valibot";

import {
  caseLawProvisionCitations,
  caseLawSources,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { provisionAnchorSubtreeSql } from "@/api/lib/case-law/provision-anchor-lineage";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { LIMITS } from "@/api/lib/limits";

/**
 * A provision a search is narrowed to: the decisions whose recorded provision
 * links cite it or anything under it. The provision is named by its anchor,
 * as the citation resolver mints it and links store it (`par_316-odst_2`,
 * `cl_10`, `art_6-par_1`), so `par_316` matches a link to `par_316-odst_2`
 * while `par_316-odst_2` does not match `par_316-odst_1`, and `par_31` does
 * not reach `par_316`.
 *
 * The anchor is the only provision key a read compares: its subtree is one
 * byte-ordered range of the links' work-subtree index
 * ({@link provisionAnchorSubtreeSql}), so a read of a provision seeks its own
 * links. Structured path columns would leave the index only the work to seek
 * on, and a heavily cited act (a civil code) would be read whole.
 */
export const caseLawProvisionFilterSchema = v.object({
  jurisdiction: v.optional(v.literal("EU")),
  work: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  anchor: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
});

export type CaseLawProvisionFilter = v.InferOutput<
  typeof caseLawProvisionFilterSchema
>;

type ProvisionScopeOptions = {
  /** The citing decisions' country; EU targets override the link jurisdiction. */
  jurisdiction: string;
  provision: CaseLawProvisionFilter;
};

/** The jurisdiction the provision's links are stored under. */
const linkJurisdictionOf = ({
  jurisdiction,
  provision,
}: ProvisionScopeOptions): string => provision.jurisdiction ?? jurisdiction;

/**
 * The link rows that cite the provision or one under it. The jurisdiction,
 * the work and the anchor range are the work-subtree index's whole key, so
 * every read of a provision's citing decisions seeks that provision's own
 * links.
 */
const provisionLinkConditions = (scope: ProvisionScopeOptions): SQL[] => {
  const link = caseLawProvisionCitations;
  const { jurisdiction, provision } = scope;
  const linkJurisdiction = linkJurisdictionOf(scope);
  const conditions: SQL[] = [
    sql`${link.jurisdiction} = ${linkJurisdiction}`,
    sql`${link.workIdentifier} = ${provision.work}`,
    provisionAnchorSubtreeSql(link.anchor, {
      jurisdiction: linkJurisdiction,
      anchor: provision.anchor,
    }),
  ];
  if (provision.jurisdiction === "EU") {
    // EU target identity does not name the citing country. Keep an id set and
    // its broad-set warning within the requested country's published corpus.
    conditions.push(sql`EXISTS (
      SELECT 1 FROM ${publishedCaseLawDecisions}
      INNER JOIN ${caseLawSources} ON ${caseLawSources.id} = ${publishedCaseLawDecisions.sourceId}
      WHERE ${publishedCaseLawDecisions.id} = ${link.decisionId}
        AND ${publishedCaseLawDecisions.country} = ${jurisdiction}
        AND ${redistributableCaseLawSource}
    )`);
  }
  return conditions;
};

/**
 * Whether the corpus records any citation of the provision's act. A filter
 * on an act no link names answers an exact 0 that says only that the act's
 * citations were never extracted, so a caller asks this before reading one.
 * One probe of the work index's leading key.
 */
export const readProvisionWorkLinked = async (
  tx: CaseLawPublicReadTransaction,
  scope: ProvisionScopeOptions,
): Promise<boolean> => {
  const link = caseLawProvisionCitations;
  const rows = await tx
    .select({ decisionId: link.decisionId })
    .from(link)
    .where(
      and(
        eq(link.jurisdiction, linkJurisdictionOf(scope)),
        eq(link.workIdentifier, scope.provision.work),
      ),
    )
    .limit(1);
  return rows.length > 0;
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
 * filters by. It drives from the links' work-subtree index, so a
 * provision-only list reads the provision's own links rather than probing
 * every decision or every link of its act.
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
