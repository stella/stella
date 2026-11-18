/**
 * The spellings one decision's ECLI is published under across publishers.
 *
 * The ECLI standard fixes the frame (`ECLI:<country>:<court>:<year>:<ordinal>`)
 * and leaves the ordinal to each country, and two publishers of the same
 * decision do not always spell it alike. Matching a record of one publisher
 * to a decision another holds compares every spelling this answers against
 * the held decision's normalized ECLI identifier, so the lookup stays an
 * indexed equality instead of a computed key over every stored row.
 *
 * Czech ordinals (`<senate>.<register>.<number>.<docket year>.<counter>`)
 * differ in two ways between the Supreme Court's collection and its decision
 * database, measured on the same decisions:
 * - the docket year, four digits in one (`2.CDON.1548.1997.1`) and two in the
 *   other (`2.CDON.1548.97.1`), at every court;
 * - a register with a diacritic (`29.NSČR.106.2018.1`) spelled in ASCII
 *   (`29.NSCR.106.2018.1`).
 * The counter is the decision's own and is never dropped: `.2` is another
 * decision of the same file.
 */

import { normalizeUnicode, stripDiacritics } from "@stll/text-normalize";

const CZECH_ECLI =
  /^(?<frame>ECLI:CZ:[^:]+:\d{4}:)(?<senate>[^.]+)\.(?<register>[^.]+)\.(?<number>\d+)\.(?<year>\d{2}|\d{4})\.(?<counter>\d+)$/iu;

/** The two-digit docket years of a four-digit one, and the reverse. */
const docketYearSpellings = (year: string): string[] => {
  if (year.length === 4) {
    return [year, year.slice(2)];
  }
  // A two-digit docket year is read in the century Czech courts printed
  // it in: two-digit years were left behind around the turn of the century.
  const value = Number(year);
  return [year, String(value >= 50 ? 1900 + value : 2000 + value)];
};

/**
 * A register spelled with its diacritics and without them. One way only: an
 * ASCII register does not say which letter carried the mark, and the decision
 * databases a record is matched against store the ASCII spelling.
 */
const registerSpellings = (register: string): string[] => [
  ...new Set([register, normalizeUnicode(stripDiacritics(register), "NFC")]),
];

const czechEcliSpellings = (ecli: string): string[] => {
  const groups = CZECH_ECLI.exec(normalizeUnicode(ecli, "NFC").trim())?.groups;
  const frame = groups?.["frame"];
  const senate = groups?.["senate"];
  const register = groups?.["register"];
  const number = groups?.["number"];
  const year = groups?.["year"];
  const counter = groups?.["counter"];
  if (
    frame === undefined ||
    senate === undefined ||
    register === undefined ||
    number === undefined ||
    year === undefined ||
    counter === undefined
  ) {
    return [ecli];
  }
  return [
    ...new Set([
      ecli,
      ...registerSpellings(register).flatMap((spelledRegister) =>
        docketYearSpellings(year).map(
          (spelledYear) =>
            `${frame}${senate}.${spelledRegister}.${number}.${spelledYear}.${counter}`,
        ),
      ),
    ]),
  ];
};

/**
 * Every spelling of this ECLI that names the same decision under the
 * jurisdiction's grammar, the stated one first. A jurisdiction without a
 * grammar here answers the stated spelling alone.
 */
export const ecliPublisherSpellings = (
  country: string,
  ecli: string,
): string[] => (country === "CZE" ? czechEcliSpellings(ecli) : [ecli]);
