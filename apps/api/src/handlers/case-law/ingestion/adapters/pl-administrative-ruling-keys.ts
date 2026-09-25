/**
 * The keys under which a Polish administrative court's ruling stored by one
 * source meets the same ruling stored by another.
 *
 * `pl-nsa` (the administrative courts' decisions, keyed by the courts' portal
 * id) and `pl-uodo` (the data protection authority's portal, which files the
 * administrative courts' rulings on its decisions as records) store the same
 * rulings under their own ids. Rows are related by what both state: the
 * courts' portal document id where the row states it, and the court, docket,
 * decision date and kind. Both rows are kept.
 */

import { foldDecisionIdentifierInput } from "@stll/api-contract/decision-docket-grammar";

import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";

/** The courts' portal id: `orzeczenia.nsa.gov.pl/doc/0A9A601038`. */
const PORTAL_DOCUMENT_ID = /^[0-9A-F]{10}$/u;

const SUPREME_ADMINISTRATIVE = "naczelny sąd administracyjny";
const REGIONAL_ADMINISTRATIVE = "wojewódzki sąd administracyjny ";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

const collapse = (text: string): string =>
  text.replace(/\s+/gu, " ").trim().toLocaleLowerCase("pl-PL");

type AdministrativeCourtRulingKeyInput = Pick<
  IngestionResult,
  "caseNumber" | "court" | "decisionDate" | "decisionType"
> & {
  /** The courts' portal id of the ruling, where the row states one. */
  portalDocumentId: string | undefined;
};

/**
 * The portal id key where the row states the id, and the court, docket,
 * date and kind key where it states all four; none for a row of another
 * court. Either key alone pairs two rows: the id is the portal's identity,
 * and the court, docket, date and kind name one ruling.
 */
export const plAdministrativeCourtRulingKeys = ({
  caseNumber,
  court,
  decisionDate,
  decisionType,
  portalDocumentId,
}: AdministrativeCourtRulingKeyInput): string[] => {
  const courtKey = collapse(court);
  if (
    courtKey !== SUPREME_ADMINISTRATIVE &&
    !courtKey.startsWith(REGIONAL_ADMINISTRATIVE)
  ) {
    return [];
  }
  const keys: string[] = [];
  if (
    portalDocumentId !== undefined &&
    PORTAL_DOCUMENT_ID.test(portalDocumentId)
  ) {
    keys.push(`sa-doc|${portalDocumentId}`);
  }
  if (
    decisionDate !== undefined &&
    ISO_DATE.test(decisionDate) &&
    decisionType !== undefined
  ) {
    const docket = foldDecisionIdentifierInput(caseNumber)
      .toLocaleUpperCase("pl-PL")
      .replace(/\s+/gu, "");
    keys.push(
      `sa|${courtKey}|${docket}|${decisionDate}|${decisionType.toLocaleLowerCase("pl-PL")}`,
    );
  }
  return keys;
};
