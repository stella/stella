import { panic } from "better-result";
import { and, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { type Static, t } from "elysia";

import { SECTION_UNITS } from "@stll/legal-atlas/provision-citation-profile";

import { caseLawProvisionCitations } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
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
export const caseLawProvisionFilterSchema = t.Object({
  /** The work's display identity as links record it: `262/2006 Sb.`. */
  work: t.String({ minLength: 1, maxLength: 64 }),
  unit: t.UnionEnum(SECTION_UNITS),
  section: t.Integer({ minimum: 1, maximum: 99_999 }),
  sectionSuffix: t.Optional(t.String({ minLength: 1, maxLength: 8 })),
  subsection: t.Optional(t.String({ minLength: 1, maxLength: 8 })),
  letter: t.Optional(t.String({ minLength: 1, maxLength: 8 })),
  point: t.Optional(t.String({ minLength: 1, maxLength: 8 })),
});

export type CaseLawProvisionFilter = Static<
  typeof caseLawProvisionFilterSchema
>;

type ProvisionScopeOptions = {
  /** The citing decisions' jurisdiction, which is the links' own. */
  jurisdiction: string;
  provision: CaseLawProvisionFilter;
};

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
    sql`${link.jurisdiction} = ${jurisdiction}`,
    sql`${link.workIdentifier} = ${provision.work}`,
    sql`${link.unit} = ${provision.unit}`,
    sql`${link.section} = ${provision.section}`,
    provision.sectionSuffix === undefined
      ? sql`${link.sectionSuffix} IS NULL`
      : sql`${link.sectionSuffix} = ${provision.sectionSuffix}`,
  ];
  if (provision.subsection !== undefined) {
    levels.push(sql`${link.subsection} = ${provision.subsection}`);
  }
  if (provision.letter !== undefined) {
    levels.push(sql`${link.letter} = ${provision.letter}`);
  }
  if (provision.point !== undefined) {
    levels.push(sql`${link.point} = ${provision.point}`);
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
  const conditions = and(...provisionLinkConditions(scope));
  const rows = await tx
    .selectDistinct({ decisionId: link.decisionId })
    .from(link)
    .where(conditions)
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
    .where(conditions);
  return {
    type: "broad",
    citingDecisions:
      count?.citingDecisions ?? panic("A count query returned no row"),
  };
};
