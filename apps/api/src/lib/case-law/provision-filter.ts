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
import {
  provisionAnchorSeparator,
  provisionAnchorSubtreeSql,
} from "@/api/lib/case-law/provision-anchor-lineage";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { LIMITS } from "@/api/lib/limits";

const pathValueSchema = v.optional(
  v.pipe(v.string(), v.minLength(1), v.maxLength(8)),
);

/**
 * A provision a search is narrowed to: the decisions whose recorded provision
 * links cite it or anything under it. Each level the caller names narrows,
 * and a level left out matches every value of it: `§ 316` matches a link to
 * `§ 316 odst. 2`, `§ 316 odst. 2` does not match `§ 316 odst. 1`, and
 * `§ 265b písm. g)` matches `§ 265b odst. 1 písm. g)` as well as
 * `§ 265b písm. g)`.
 *
 * Two parts, one per job. `anchor` is the seek: the anchor of the levels
 * named from the section down without a gap (`par_265b` for
 * `§ 265b písm. g)`, `par_316-odst_2` for `§ 316 odst. 2`). Its subtree is one
 * byte-ordered range of the links' work-subtree index
 * ({@link provisionAnchorSubtreeSql}), so every read seeks the provision's
 * own links, never every link of its act; a civil code has millions. The
 * named levels below the section are then compared by column within that
 * range, which is what lets an omitted level stay a wildcard.
 *
 * Built by {@link caseLawProvisionFilterOf} from a resolved citation.
 */
export const caseLawProvisionFilterSchema = v.object({
  jurisdiction: v.optional(v.literal("EU")),
  work: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  anchor: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  subsection: pathValueSchema,
  letter: pathValueSchema,
  point: pathValueSchema,
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
 * The filter for a resolved citation. `anchor` is the anchor the citation
 * grammar minted for the whole path, one segment per named level from the
 * section down; the seek keeps the segments up to the first level the
 * citation leaves out, so a gap never narrows the range past the links
 * stored with the level filled in.
 */
export const caseLawProvisionFilterOf = ({
  citingJurisdiction,
  jurisdiction,
  work,
  anchor,
  subsection,
  letter,
  point,
}: {
  /** The citing decisions' country. */
  citingJurisdiction: string;
  jurisdiction?: "EU";
  work: string;
  anchor: string;
  subsection: string | null;
  letter: string | null;
  point: string | null;
}): CaseLawProvisionFilter => {
  // The subtree read's own separator, so the cut and the range agree.
  const separator = provisionAnchorSeparator(
    jurisdiction ?? citingJurisdiction,
  );
  const levels = [subsection, letter, point];
  const contiguous = levels.indexOf(null);
  const named = contiguous === -1 ? levels.length : contiguous;
  return {
    ...(jurisdiction === undefined ? {} : { jurisdiction }),
    work,
    // A jurisdiction without a separator mints whole anchors: no level can
    // be cut off, and its anchors are compared whole.
    anchor:
      separator === null
        ? anchor
        : anchor
            .split(separator)
            .slice(0, 1 + named)
            .join(separator),
    ...(subsection === null ? {} : { subsection }),
    ...(letter === null ? {} : { letter }),
    ...(point === null ? {} : { point }),
  };
};

/**
 * A path value as links store it: lowercase, no leading zeros, the form the
 * citation resolver mints. A caller spelling `G` or `02` reads the same link.
 */
const canonicalPathValue = (value: string) =>
  value.toLowerCase().replace(/^0+(?=\d)/u, "");

/**
 * The link rows that cite the provision or one under it. The jurisdiction,
 * the work and the anchor range are the work-subtree index's whole key, so
 * every read of a provision's citing decisions seeks that provision's own
 * links; the named levels are compared within them.
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
  if (provision.subsection !== undefined) {
    conditions.push(
      sql`${link.subsection} = ${canonicalPathValue(provision.subsection)}`,
    );
  }
  if (provision.letter !== undefined) {
    conditions.push(
      sql`${link.letter} = ${canonicalPathValue(provision.letter)}`,
    );
  }
  if (provision.point !== undefined) {
    conditions.push(
      sql`${link.point} = ${canonicalPathValue(provision.point)}`,
    );
  }
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
