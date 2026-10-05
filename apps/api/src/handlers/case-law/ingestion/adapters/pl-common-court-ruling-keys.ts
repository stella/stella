// parser-output-unchanged: [pl-ncourt] Treat nullable decision type as absent; publisher output remains strings or undefined.
// parser-output-unchanged: [pl-uodo] Treat nullable decision type as absent; publisher output remains strings or undefined.
// parser-output-unchanged: [pl-uokik] Treat nullable decision type as absent; publisher output remains strings or undefined.
// parser-output-unchanged: The common-court ruling-key implementation is moved without changing its output.
import type { RawIngestionResult } from "@/api/lib/legal-search/ingestion-types";

const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim();

/** Where a signature's parts differ only in spacing, one spelling. */
const normalizeSignature = (signature: string): string =>
  collapse(signature).toLocaleUpperCase("pl-PL");

/** What a ruling key is read from: stored columns only. */
export type CommonCourtRulingKeyInput = Pick<
  RawIngestionResult,
  "caseNumber" | "court" | "decisionDate" | "decisionType"
>;

/**
 * The key under which a stored common-court judgment meets its copy in the
 * other source: court, signature, judgment date and decision type.
 *
 * Both this adapter and `pl-courts` store the same judgment under their own
 * ids; the one here is also the `source.judgmentId` SAOS keeps. Two rows
 * sharing a key are one judgment, and this API is the one SAOS imports from.
 * Empty for a row missing the date or the type: a signature alone does not
 * name a judgment, since a ruling and a later order share it.
 */
export const plCommonCourtRulingKeys = ({
  caseNumber,
  court,
  decisionDate,
  decisionType,
}: CommonCourtRulingKeyInput): string[] =>
  decisionDate === undefined ||
  decisionType === undefined ||
  decisionType === null
    ? []
    : [
        [
          collapse(court).toLocaleLowerCase("pl-PL"),
          normalizeSignature(caseNumber),
          decisionDate,
          decisionType.toLocaleLowerCase("pl-PL"),
        ].join("|"),
      ];
