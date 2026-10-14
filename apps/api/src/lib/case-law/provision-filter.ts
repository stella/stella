import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { type Static, t } from "elysia";

import { SECTION_UNITS } from "@stll/legal-atlas/provision-citation-profile";

import { caseLawProvisionCitations } from "@/api/db/schema";

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

type ProvisionCitedOptions = {
  /** The decision id the predicate is correlated with. */
  decisionId: SQL;
  /** The citing decisions' jurisdiction, which is the links' own. */
  jurisdiction: string;
  provision: CaseLawProvisionFilter;
};

/**
 * Whether the correlated decision cites the provision. Correlated on the
 * decision id, which leads the links' unique index, so the predicate costs a
 * short index probe per candidate rather than a scan of the work's links.
 */
export const provisionCitedSql = ({
  decisionId,
  jurisdiction,
  provision,
}: ProvisionCitedOptions): SQL => {
  const link = caseLawProvisionCitations;
  const levels: SQL[] = [
    sql`${link.decisionId} = ${decisionId}`,
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
  return sql`EXISTS (SELECT 1 FROM ${link} WHERE ${sql.join(levels, sql` AND `)})`;
};
