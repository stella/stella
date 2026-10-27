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
 * A path value as links store it: lowercase, no leading zeros, the form the
 * citation resolver mints. A caller spelling `G` or `02` reads the same link.
 */
const canonicalPathValue = (value: string) =>
  value.toLowerCase().replace(/^0+(?=\d)/u, "");

const canonicalLevel = (value: string | null) =>
  value === null ? null : canonicalPathValue(value);

/** A cited provision path, outermost level first. */
export type CitedProvisionPath = {
  unit: "article" | "section";
  section: number;
  sectionSuffix: string | null;
  subsection: string | null;
  letter: string | null;
  point: string | null;
};

/**
 * The filter for a resolved citation. The path is canonicalised here, once,
 * before anything is derived from it, so the seek anchor and the compared
 * levels always spell a value the way links store it (`(01)` reads as `1`);
 * no caller can hand over an anchor minted from another spelling.
 *
 * The seek anchor is minted, by the citation grammar's own `anchorOf`, from
 * the levels named from the section down without a gap; a level after the
 * first one the citation leaves out is compared by column instead, so a gap
 * never narrows the range past the links stored with the level filled in.
 */
export const caseLawProvisionFilterOf = ({
  jurisdiction,
  work,
  path,
  anchorOf,
}: {
  jurisdiction?: "EU";
  work: string;
  path: CitedProvisionPath;
  /** The citation grammar's anchor for a canonical path. */
  anchorOf: (path: CitedProvisionPath) => string;
}): CaseLawProvisionFilter => {
  const canonical: CitedProvisionPath = {
    unit: path.unit,
    section: path.section,
    sectionSuffix: canonicalLevel(path.sectionSuffix),
    subsection: canonicalLevel(path.subsection),
    letter: canonicalLevel(path.letter),
    point: canonicalLevel(path.point),
  };
  const { subsection, letter, point } = canonical;
  const seek: CitedProvisionPath = {
    ...canonical,
    letter: subsection === null ? null : letter,
    point: subsection === null || letter === null ? null : point,
  };
  return {
    ...(jurisdiction === undefined ? {} : { jurisdiction }),
    work,
    anchor: anchorOf(seek),
    ...(subsection === null ? {} : { subsection }),
    ...(letter === null ? {} : { letter }),
    ...(point === null ? {} : { point }),
  };
};

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
 * OFFSET 0 prevents decorrelation into every citing decision before the
 * ranked page can apply its LIMIT.
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
  )} LIMIT 1 OFFSET 0)`;

/** A complete small set, or a scope that needs candidate-by-candidate probes. */
export type CaseLawProvisionScope =
  | { type: "decisions"; decisionIds: readonly SafeId<"caseLawDecision">[] }
  | { type: "broad" };

/**
 * Bound physical links before deduplication or publication joins. Grouping
 * before LIMIT still reads every citation of a popular provision. Anchor
 * order lets the subtree index stop as soon as the row budget is reached.
 */
export const provisionScopeLinksQuery = (
  tx: CaseLawPublicReadTransaction,
  scope: ProvisionScopeOptions & { idSetMax?: number },
) =>
  tx
    .select({ decisionId: caseLawProvisionCitations.decisionId })
    .from(caseLawProvisionCitations)
    .where(and(...provisionLinkConditions(scope)))
    .orderBy(sql`${caseLawProvisionCitations.anchor} COLLATE "C"`)
    .limit((scope.idSetMax ?? LIMITS.caseLawProvisionIdSetMax) + 1);

export const readCaseLawProvisionScope = async (
  tx: CaseLawPublicReadTransaction,
  scope: ProvisionScopeOptions & { idSetMax?: number },
): Promise<CaseLawProvisionScope> => {
  const links = await provisionScopeLinksQuery(tx, scope);
  if (links.length > (scope.idSetMax ?? LIMITS.caseLawProvisionIdSetMax)) {
    return { type: "broad" };
  }
  if (links.length === 0) {
    return { type: "decisions", decisionIds: [] };
  }
  const rows = await tx
    .select({ decisionId: publishedCaseLawDecisions.id })
    .from(publishedCaseLawDecisions)
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
    )
    .where(
      and(
        inArray(
          publishedCaseLawDecisions.id,
          links.map(({ decisionId }) => decisionId),
        ),
        eq(publishedCaseLawDecisions.country, scope.jurisdiction),
        redistributableCaseLawSource,
      ),
    )
    .limit(scope.idSetMax ?? LIMITS.caseLawProvisionIdSetMax);
  return {
    type: "decisions",
    decisionIds: rows.map(({ decisionId }) => decisionId),
  };
};

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
