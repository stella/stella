import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import {
  MAGYAR_KOZLONY_COLLECTION_SOURCE,
  MAGYAR_KOZLONY_WORK_URN_PREFIX,
  magyarKozlonyWorkPattern,
  magyarKozlonyYearPattern,
} from "@stll/api-contract/magyar-kozlony-designation";
import { statuteEliYearPattern } from "@stll/api-contract/statute-identity";
import { statuteWorkIdentifierForm } from "@stll/api-contract/statute-work-identifier";

import { legislationDocuments } from "@/api/db/schema";
import { escapeLike } from "@/api/lib/escape-like";

/** `<number>/<year>` as a collection prints it: `89/2012`. */
export const ACT_NUMBER_PATTERN = /^([0-9]{1,5})\/([0-9]{4})$/u;

/** An ELI collection segment: `sb`, `zz`, `sm`. */
const ELI_COLLECTION_RE = /^[a-z0-9]{1,8}$/u;

/** What a list may filter an act number by: an ELI collection or a Magyar Közlöny series. */
export const ACT_COLLECTION_PATTERN = new RegExp(
  `^(?:[a-z0-9]{1,8}|${MAGYAR_KOZLONY_COLLECTION_SOURCE})$`,
  "u",
);

type ActNumberConditionOptions = {
  number: string;
  collection?: string | undefined;
  /** The jurisdiction searched: its publisher decides how a Work is named. */
  country: string;
};

const MAGYAR_KOZLONY_PREFIX_LIKE = `${escapeLike(MAGYAR_KOZLONY_WORK_URN_PREFIX)}%`;

/**
 * The work an act number names, read in the form the jurisdiction's
 * publisher names its Works (`statuteWorkIdentifierForm`).
 *
 * - An ELI ends in `/<collection>/<year>/<number>` (`/eli/cz/sb/2012/89`),
 *   so the number is matched on that tail: a suffix match the trigram index
 *   serves, made exact by the anchored pattern so `/2012/89` cannot answer
 *   for `/2012/189`. Without a collection every collection qualifies.
 * - A Magyar Közlöny Work is its designation
 *   (`urn:hu:magyar-kozlony:123-2020-iv-30-korm-rendelet`), matched with the
 *   pattern its owner states for a number in a series; without a series the
 *   law of that number and every numbered act qualify.
 *
 * The caller shows several candidates rather than picking one. Null for a
 * number or collection the form cannot carry.
 */
export const actNumberCondition = ({
  number,
  collection,
  country,
}: ActNumberConditionOptions): SQL | null => {
  const match = ACT_NUMBER_PATTERN.exec(number);
  const ordinal = match?.[1];
  const year = match?.[2];
  if (ordinal === undefined || year === undefined) {
    return null;
  }
  const form = statuteWorkIdentifierForm(country);
  switch (form.type) {
    case "magyar_kozlony": {
      const actNumber = parseIntegerToken(ordinal, {
        sign: "unsigned",
      }).unwrapOr(null);
      const actYear = parseIntegerToken(year, { sign: "unsigned" }).unwrapOr(
        null,
      );
      const pattern =
        actNumber === null || actYear === null
          ? null
          : magyarKozlonyWorkPattern({
              number: actNumber,
              year: actYear,
              collection,
            });
      return pattern === null
        ? null
        : sql`(
    ${legislationDocuments.eli} LIKE ${MAGYAR_KOZLONY_PREFIX_LIKE}
    AND ${legislationDocuments.eli} ~ ${pattern}
  )`;
    }
    case "eli":
    case "undeclared": {
      if (collection !== undefined && !ELI_COLLECTION_RE.test(collection)) {
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
    }
    default:
      form satisfies never;
      return panic("Unknown statute work identifier form");
  }
};

/**
 * Act-number year, independent of the consolidation validity date, read in
 * the form the jurisdiction's publisher names its Works.
 */
export const actYearCondition = (year: number, country: string): SQL => {
  const form = statuteWorkIdentifierForm(country);
  switch (form.type) {
    case "magyar_kozlony":
      return sql`(
    ${legislationDocuments.eli} LIKE ${MAGYAR_KOZLONY_PREFIX_LIKE}
    AND ${legislationDocuments.eli} ~ ${magyarKozlonyYearPattern(year)}
  )`;
    case "eli":
    case "undeclared": {
      const token = String(year);
      // sql-perf-allow: index legislation_documents_eli_trgm_idx
      return sql`(
    ${legislationDocuments.eli} LIKE ${`%/${escapeLike(token)}/%`}
    AND ${legislationDocuments.eli} ~ ${statuteEliYearPattern(token)}
  )`;
    }
    default:
      form satisfies never;
      return panic("Unknown statute work identifier form");
  }
};
