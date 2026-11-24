import { panic } from "better-result";

import { directoryCourtsNamed } from "./court-citation-aliases";
import { courtCitationGrammarOf } from "./court-citation-directory";

/**
 * Which court a decision is stored under, in a jurisdiction whose publishers
 * print the court's name rather than an id.
 *
 * A printed name is not an identity: one publisher prints a regional court's
 * branch as `Krajský soud v Hradci Králové, pobočka Pardubice`, another as the
 * official `… – pobočka v Pardubicích`, and one register prints the same
 * district court in full on some decisions and abbreviated (`Bánovce n/B`) on
 * others. Stored as printed, each spelling is a separate court to every
 * facet, filter and rank. So the name is read onto the court directory
 * (`court-citation-directory.ts`) through the aliases a citation is read
 * through (`court-citation-aliases.ts`), and the decision stores the
 * directory court's id and official name, with the printed name kept beside
 * them by the adapter that read it.
 *
 * A name the directory does not answer to, or answers to with more than one
 * court, is not a court: it is refused, never stored as a new one.
 */

/** The jurisdictions whose decisions are identified by a printed court name. */
export const PRINTED_COURT_JURISDICTIONS = ["CZE", "SVK"] as const;

export type PrintedCourtJurisdiction =
  (typeof PRINTED_COURT_JURISDICTIONS)[number];

export const isPrintedCourtJurisdiction = (
  country: string,
): country is PrintedCourtJurisdiction =>
  PRINTED_COURT_JURISDICTIONS.some((code) => code === country);

/** A directory court as a decision stores it: its id and official name. */
export type DirectoryCourtIdentity = {
  readonly id: string;
  readonly name: string;
};

export type PrintedCourtReading =
  | { readonly type: "court"; readonly court: DirectoryCourtIdentity }
  /** No directory court answers to the name. */
  | { readonly type: "unknown" }
  /** The name is an alias several directory courts share. */
  | {
      readonly type: "ambiguous";
      readonly courts: readonly DirectoryCourtIdentity[];
    };

const identityOf = (court: {
  id?: string | undefined;
  name: string;
}): DirectoryCourtIdentity =>
  court.id === undefined
    ? panic(`Directory court without an id: ${court.name}`)
    : { id: court.id, name: court.name };

const courtsOf = (
  country: PrintedCourtJurisdiction,
): readonly DirectoryCourtIdentity[] =>
  (
    courtCitationGrammarOf(country) ??
    panic(`No court directory for ${country}`)
  ).courts.map(identityOf);

const DIRECTORY: Readonly<
  Record<PrintedCourtJurisdiction, ReadonlyMap<string, DirectoryCourtIdentity>>
> = {
  CZE: new Map(courtsOf("CZE").map((court) => [court.id, court])),
  SVK: new Map(courtsOf("SVK").map((court) => [court.id, court])),
};

for (const country of PRINTED_COURT_JURISDICTIONS) {
  if (DIRECTORY[country].size !== courtsOf(country).length) {
    panic(`Two ${country} directory courts share an id`);
  }
}

/** Every directory court of the jurisdiction, by id. */
export const directoryCourtIdentities = (
  country: PrintedCourtJurisdiction,
): readonly DirectoryCourtIdentity[] => [...DIRECTORY[country].values()];

/** The directory court with this id, or undefined. Exact: an id is no alias. */
export const directoryCourtById = (
  country: PrintedCourtJurisdiction,
  id: string,
): DirectoryCourtIdentity | undefined => DIRECTORY[country].get(id);

/**
 * The directory court a printed name answers to. Case, diacritics,
 * punctuation and dash style carry no meaning in a court's name; the words
 * do, so a name is read only through an alias the directory declares.
 */
export const readPrintedCourt = (
  country: PrintedCourtJurisdiction,
  printed: string,
): PrintedCourtReading => {
  const courts = directoryCourtsNamed(country, printed).map(identityOf);
  const [only, ...others] = courts;
  if (only === undefined) {
    return { type: "unknown" };
  }
  return others.length === 0
    ? { type: "court", court: only }
    : { type: "ambiguous", courts };
};
