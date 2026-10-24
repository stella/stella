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

/** An act's collection, year and number as its ELI names them. */
export type StatuteEliParts = {
  collection: string | null;
  year: string | null;
  /** The act's number without leading zeros (`89`). */
  number: string | null;
};

/** The same ELI reader feeds number labels and document identity badges. */
export const statuteEliParts = (
  eli: string | null | undefined,
): StatuteEliParts => {
  const match =
    eli === null || eli === undefined ? null : ELI_ACT_TAIL_RE.exec(eli);
  const ordinal = match?.[3];
  return {
    collection: match?.[1] ?? null,
    year: match?.[2] ?? null,
    number: ordinal === undefined ? null : String(Number(ordinal)),
  };
};

/** `89/2012 Sb.`, or null for an ELI that carries no act number. */
export const statuteActNumber = (eli: string): string | null => {
  const { collection, year, number: ordinal } = statuteEliParts(eli);
  if (collection === null || year === null || ordinal === null) {
    return null;
  }
  const number = `${ordinal}/${year}`;
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
