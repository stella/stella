/**
 * Which provisions a stored provision anchor sits under.
 *
 * An anchor names its enclosing provisions in its own prefixes, cut on the
 * citing grammar's separator: `par_51-odst_3-pism_a` sits under
 * `par_51-odst_3`, which sits under `par_51`. A decision citing the letter
 * therefore cites the subsection and the section too, and every read that
 * answers "which decisions cite this provision" or counts them asks for the
 * provision's whole subtree, never only the rows stored at its exact anchor.
 *
 * The separator is part of the test, or `par_5` would reach `par_51`. A
 * jurisdiction without a supported grammar mints no anchors, so its stored
 * anchors are read as opaque: each sits under nothing but itself.
 *
 * The stored projection repeats this rule in SQL
 * (`case_law_provision_anchor_lineage` in the
 * `20261022230000_provision_citation_anchor_lineage` migration and the later
 * ones that redefine it);
 * `provision-anchor-lineage.db.test.ts` holds the two to the same answers.
 */

import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import { PROVISION_CITATION_GRAMMARS } from "@stll/legal-atlas/provision-citation-grammars";

const ANCHOR_SEPARATORS = new Map<string, string>();
for (const grammar of Object.values(PROVISION_CITATION_GRAMMARS)) {
  if (grammar.status !== "supported") {
    continue;
  }
  // The subtree read bounds its range by the code point after the separator.
  const codePoint = grammar.anchorSeparator.codePointAt(0);
  if (
    codePoint === undefined ||
    String.fromCodePoint(codePoint) !== grammar.anchorSeparator
  ) {
    panic(
      `The ${grammar.jurisdiction} anchor separator must be one code point`,
    );
  }
  ANCHOR_SEPARATORS.set(grammar.jurisdiction, grammar.anchorSeparator);
}

/**
 * The separator between the levels of an anchor, or null when none is minted.
 * A reader that cuts an anchor into levels uses this one, so the cut and the
 * subtree range below agree.
 */
export const provisionAnchorSeparator = (jurisdiction: string): string | null =>
  ANCHOR_SEPARATORS.get(jurisdiction) ?? null;

type ProvisionAnchorTarget = {
  jurisdiction: string;
  anchor: string;
};

/**
 * The anchor and every provision it sits under, outermost first. Empty for
 * the empty anchor, which names the whole work rather than a provision.
 */
export const provisionAnchorLineage = ({
  jurisdiction,
  anchor,
}: ProvisionAnchorTarget): string[] => {
  if (anchor === "") {
    return [];
  }
  const separator = provisionAnchorSeparator(jurisdiction);
  if (separator === null) {
    return [anchor];
  }
  const parts = anchor.split(separator);
  return parts.map((_part, index) => parts.slice(0, index + 1).join(separator));
};

/**
 * Whether the anchor column holds the provision or one under it.
 *
 * Compared under the "C" collation, where a subtree is one contiguous range:
 * the provision itself, then exactly the anchors in `[A + separator, A +
 * next code point)`. The database collation sorts `par_510` between `par_51`
 * and `par_51-odst_1`, so only the byte-ordered anchor indexes can seek the
 * range; the leading bounds are their index condition and the last clause
 * drops what lies between the provision and its first subdivision.
 */
export const provisionAnchorSubtreeSql = (
  column: SQLWrapper,
  { jurisdiction, anchor }: ProvisionAnchorTarget,
): SQL => {
  const bytes = sql`(${column} COLLATE "C")`;
  const separator = provisionAnchorSeparator(jurisdiction);
  if (separator === null) {
    return sql`${bytes} = ${anchor}`;
  }
  const next = String.fromCodePoint(
    (separator.codePointAt(0) ?? panic("The separator is one code point")) + 1,
  );
  return sql`(${bytes} >= ${anchor} AND ${bytes} < ${`${anchor}${next}`} AND (${bytes} = ${anchor} OR ${bytes} >= ${`${anchor}${separator}`}))`;
};

/**
 * The provisions a stored citation row counts toward, as a SQL array. The
 * function is the stored projection's own rule, so a read-time aggregate and
 * the maintained counts cannot disagree on it.
 */
export const provisionAnchorLineageSql = (
  jurisdiction: SQLWrapper,
  anchor: SQLWrapper,
): SQL<string[]> =>
  sql<
    string[]
  >`case_law_provision_anchor_lineage(${jurisdiction}::text, ${anchor}::text)`;
