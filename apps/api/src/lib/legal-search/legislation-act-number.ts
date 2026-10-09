import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { statuteEliYearPattern } from "@stll/api-contract/statute-identity";

import { legislationDocuments } from "@/api/db/schema";
import { escapeLike } from "@/api/lib/escape-like";

/** `<number>/<year>` as a collection prints it: `89/2012`. */
export const ACT_NUMBER_PATTERN = /^([0-9]{1,5})\/([0-9]{4})$/u;

type ActNumberConditionOptions = {
  number: string;
  collection?: string | undefined;
};

/**
 * The work an act number names. ELIs end in `/<collection>/<year>/<number>`
 * (`/eli/cz/sb/2012/89`), so the number is matched on that tail: a suffix
 * match the trigram index serves, made exact by the anchored pattern so
 * `/2012/89` cannot answer for `/2012/189`. Without a collection every
 * collection of the jurisdiction qualifies; the caller shows the candidates
 * rather than picking one.
 */
export const actNumberCondition = ({
  number,
  collection,
}: ActNumberConditionOptions): SQL | null => {
  const match = ACT_NUMBER_PATTERN.exec(number);
  const ordinal = match?.[1];
  const year = match?.[2];
  if (ordinal === undefined || year === undefined) {
    return null;
  }
  const tail = `${year}/${ordinal}`;
  const anchored =
    collection === undefined ? `(^|/)${tail}$` : `/${collection}/${tail}$`;
  // sql-perf-allow: index legislation_documents_eli_trgm_idx
  return sql`(
    ${legislationDocuments.eli} LIKE ${`%${escapeLike(tail)}`}
    AND ${legislationDocuments.eli} ~ ${anchored}
  )`;
};

/** Act-number year, independent of the consolidation validity date. */
export const actYearCondition = (year: number): SQL => {
  const token = String(year);
  // sql-perf-allow: index legislation_documents_eli_trgm_idx
  return sql`(
    ${legislationDocuments.eli} LIKE ${`%/${escapeLike(token)}/%`}
    AND ${legislationDocuments.eli} ~ ${statuteEliYearPattern(token)}
  )`;
};
