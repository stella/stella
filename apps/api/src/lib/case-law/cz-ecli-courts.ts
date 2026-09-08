/**
 * Czech ECLI court codes, and the court a Czech decision is stored under.
 *
 * A Czech publisher is not the same thing as a deciding court. Every Czech
 * portal this codebase reads carries decisions of courts other than its own:
 * the Supreme Court's database publishes selected judgments of the high,
 * regional, city and district courts, and the Supreme Administrative Court's
 * carries the regional administrative judgments it reviews. An adapter that
 * labels everything it fetched with the publisher's name states, of hundreds
 * of rows, a court that did not decide them — and the court name is what the
 * authority tier is read off (`lib/case-law/court-weights.ts`), so a regional
 * judgment stored as the Supreme Court also ranks like one.
 *
 * The signal is in the decision's own ECLI. Its third segment is the court's
 * Ministry of Justice abbreviation, so `ECLI:CZ:KSOS:2011:75.CO.19.2011.1` is
 * a Krajský soud v Ostravě decision whichever portal serves it. This module
 * owns the code list, the names those codes resolve to, and what happens to a
 * code the list does not know; every Czech adapter resolves its court through
 * {@link czDecisionCourt} rather than deciding any of that for itself.
 */

import { panic } from "better-result";

import { logger } from "@/api/lib/observability/logger";

/**
 * Every ECLI court code the Czech portals this codebase reads have been seen
 * to publish under, plus the three national courts.
 *
 * A court sitting at its seat is its own abbreviation (`KSOS`); a court
 * sitting at a branch appends the branch's (`KSOSOL`, the Ostrava regional
 * court in Olomouc). That second shape is why this list is not the ARES one:
 * `packages/business-registries/src/ares/court-names.ts` answers which court
 * keeps a company's file, keyed on the register's own abbreviations, where
 * the same branch is `KSOL` and the Supreme Court is `NSCR`. Overlapping
 * spellings, different key sets, different questions.
 *
 * The list is what the map below is checked total against. It is not a closed
 * world: a code outside it resolves through {@link czDecisionCourt}'s fallback
 * rather than being mapped to anything.
 */
const CZ_ECLI_COURT_CODES = [
  "KSBR",
  "KSBRZL",
  "KSCB",
  "KSCBTA",
  "KSHK",
  "KSHKPA",
  "KSOS",
  "KSOSOL",
  "KSPH",
  "KSPL",
  "KSUL",
  "KSULLI",
  "MSBR",
  "MSPH",
  "NS",
  "NSS",
  "OSCK",
  "OSOV",
  "OSZR",
  "US",
  "VSOL",
  "VSPH",
] as const;

export type CzEcliCourtCode = (typeof CZ_ECLI_COURT_CODES)[number];

/**
 * The name a code is stored under, which is the corpus's canonical spelling
 * of that court and not the publisher's.
 *
 * The publishers' own spellings drift: the Supreme Court's database prints
 * both `Krajský soud v Hradci Králové - pobočka Pardubice` and `Krajský soud
 * v Hradci Králové - pobočka v Pardubicích` for the one court. `court` is a
 * browse and facet key (`case_law_decisions_country_court_date_idx`), so two
 * spellings are two shelves for one court. Resolving the code to a name here
 * gives every Czech source the same one.
 *
 * Total by type: a code on the list without a name does not compile.
 */
export const CZ_ECLI_COURTS = {
  KSBR: "Krajský soud v Brně",
  KSBRZL: "Krajský soud v Brně – pobočka ve Zlíně",
  KSCB: "Krajský soud v Českých Budějovicích",
  KSCBTA: "Krajský soud v Českých Budějovicích – pobočka v Táboře",
  KSHK: "Krajský soud v Hradci Králové",
  KSHKPA: "Krajský soud v Hradci Králové – pobočka v Pardubicích",
  KSOS: "Krajský soud v Ostravě",
  KSOSOL: "Krajský soud v Ostravě – pobočka v Olomouci",
  KSPH: "Krajský soud v Praze",
  KSPL: "Krajský soud v Plzni",
  KSUL: "Krajský soud v Ústí nad Labem",
  KSULLI: "Krajský soud v Ústí nad Labem – pobočka v Liberci",
  MSBR: "Městský soud v Brně",
  MSPH: "Městský soud v Praze",
  NS: "Nejvyšší soud",
  NSS: "Nejvyšší správní soud",
  OSCK: "Okresní soud v Českém Krumlově",
  OSOV: "Okresní soud v Ostravě",
  OSZR: "Okresní soud ve Žďáru nad Sázavou",
  US: "Ústavní soud",
  VSOL: "Vrchní soud v Olomouci",
  VSPH: "Vrchní soud v Praze",
} as const satisfies Record<CzEcliCourtCode, string>;

/**
 * The court segment of a Czech ECLI. Bounded so a malformed identifier is a
 * miss rather than an unbounded string in a log line.
 */
const CZ_ECLI_COURT_SEGMENT = /^ECLI:CZ:(?<code>[A-Z0-9]{1,8}):/u;

const isCzEcliCourtCode = (code: string): code is CzEcliCourtCode =>
  Object.hasOwn(CZ_ECLI_COURTS, code);

/** What a decision's ECLI says about the court that decided it. */
export type CzEcliCourt =
  /** The ECLI names a court this module knows. */
  | { type: "named"; code: CzEcliCourtCode; court: string }
  /** The ECLI names a court code that is not on the list. */
  | { type: "unknown-code"; code: string }
  /** No ECLI, or not a Czech one: the identifier says nothing about a court. */
  | { type: "unstated" };

/** Read the deciding court out of a Czech ECLI. */
export const czCourtFromEcli = (ecli: string | undefined): CzEcliCourt => {
  const code =
    ecli === undefined
      ? undefined
      : CZ_ECLI_COURT_SEGMENT.exec(ecli)?.groups?.["code"];
  if (code === undefined) {
    return { type: "unstated" };
  }
  return isCzEcliCourtCode(code)
    ? { type: "named", code, court: CZ_ECLI_COURTS[code] }
    : { type: "unknown-code", code };
};

type CzDecisionCourtOptions = {
  /** The adapter resolving the court; telemetry context only. */
  adapterKey: string;
  /** The decision's identifier as the publisher states it. */
  ecli: string | undefined;
  /** The publisher's document id, so a reported row can be looked up. */
  sourceDocumentId: string | undefined;
  /**
   * The court a decision carries when nothing about it names one: the
   * publisher's own court, which is what a portal serving a single court's
   * decisions with no ECLI at all is stating implicitly.
   */
  publisherCourt: string;
  /**
   * The court the source's own court field states, where the source has one.
   * Used when the ECLI names no court, and as the reading of a code this
   * module does not know.
   */
  statedCourt?: string | undefined;
};

/**
 * The court one Czech decision is stored under.
 *
 * The ECLI decides where it names a court, because it is the one signal that
 * is machine-readable, stable and spelled the same way by every publisher.
 * The source's own court field is the fallback, and the publisher's court is
 * the last resort — reached only by a document that carries neither.
 *
 * A code the list does not know never resolves to the publisher's court. It
 * is reported, and the row takes the source's own field or, failing that, the
 * abbreviation itself: the ECLI has stated that this decision is not the
 * publisher's, and silently overruling it with the publisher's name is the
 * misattribution this function exists to prevent.
 */
export const czDecisionCourt = ({
  adapterKey,
  ecli,
  sourceDocumentId,
  publisherCourt,
  statedCourt,
}: CzDecisionCourtOptions): string => {
  const fromEcli = czCourtFromEcli(ecli);
  switch (fromEcli.type) {
    case "named":
      return fromEcli.court;
    case "unknown-code":
      logger.error("case_law.ingestion.cz_ecli_court_code_unknown", {
        adapterKey,
        code: fromEcli.code,
        sourceDocumentId: sourceDocumentId ?? "",
      });
      return statedCourt ?? fromEcli.code;
    case "unstated":
      return statedCourt ?? publisherCourt;
    default: {
      fromEcli satisfies never;
      return panic(`Unhandled Czech ECLI court: ${JSON.stringify(fromEcli)}`);
    }
  }
};
