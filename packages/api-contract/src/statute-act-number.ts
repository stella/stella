/**
 * An act's number as its gazette prints it (`89/2012 Sb.`, `40/1964 Zb.`),
 * read off the ELI, and its name without that number.
 *
 * Czech titles open with the number (`89/2012 Sb., občanský zákoník`); Slovak
 * titles carry the name alone. Reading the number from the ELI gives every
 * row the same two parts whichever way the publisher wrote the title.
 */

import { statuteGazetteAbbreviation } from "./statute-gazette";

/** `…/eli/<country>/<collection>/<year>/<number>`, optionally with a tail. */
const ELI_ACT_TAIL_RE =
  /\/eli\/[a-z]{2}\/([a-z0-9]+)\/(\d{4})\/(\d{1,5})(?:\/|$)/u;

/** The same prefix the API strips for name matching (`legislationTitleName`). */
const TITLE_NUMBER_PREFIX_RE = /^\d+\/\d{4} [^,]*, /u;

/** `89/2012 Sb.`, or null for an ELI that carries no act number. */
const statuteActNumber = (eli: string): string | null => {
  const match = ELI_ACT_TAIL_RE.exec(eli);
  const collection = match?.[1];
  const year = match?.[2];
  const ordinal = match?.[3];
  if (collection === undefined || year === undefined || ordinal === undefined) {
    return null;
  }
  const number = `${String(Number(ordinal))}/${year}`;
  const abbreviation = statuteGazetteAbbreviation(collection, Number(year));
  return abbreviation === null ? number : `${number} ${abbreviation}`;
};

/** How a listed act names itself: its number, then its name. */
export type StatuteActLabel = {
  /** `89/2012 Sb.`, or null for an ELI that carries no act number. */
  number: string | null;
  /**
   * The title without the number a Czech title opens with; null where the
   * title is only the number (`89/2012 Sb. m. s.`) and would say it twice.
   */
  name: string | null;
};

export const statuteActLabel = ({
  eli,
  title,
}: {
  eli: string;
  title: string;
}): StatuteActLabel => {
  const number = statuteActNumber(eli);
  const name = title.replace(TITLE_NUMBER_PREFIX_RE, "").trim();
  return {
    number,
    name: name.length === 0 || name === number ? null : name,
  };
};
