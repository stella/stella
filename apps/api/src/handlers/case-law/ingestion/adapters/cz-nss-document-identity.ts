import {
  isWholeEntryIdentifier,
  parseDecisionQuery,
  resolveDecisionIdentity,
} from "@stll/api-contract/decision-query-intent";
// parser-output-unchanged: [cz-nss] validates the optional stored-document constructor; standing parsing and replay output are unchanged.
import { decisionDocketGrammarForCountry } from "@stll/case-law-ingestion-core/adapter-manifest";

/** The first docket in the publisher header must name the selected sheet. */
export const nssDocumentReferenceMatches = (
  reference: string,
  header: string,
) => {
  const context = {
    grammar: decisionDocketGrammarForCountry("CZE"),
    reporters: null,
  };
  const selected = parseDecisionQuery(reference, context);
  if (
    selected.type !== "identifier" ||
    selected.kind !== "docket" ||
    selected.selector.kind !== "sheet"
  ) {
    return false;
  }
  for (const line of header.split("\n").slice(0, 16)) {
    const body = parseDecisionQuery(line, context);
    if (
      body.type !== "identifier" ||
      !isWholeEntryIdentifier(body) ||
      body.kind !== "docket"
    ) {
      continue;
    }
    return (
      resolveDecisionIdentity(selected, [
        { caseNumber: body.value, ecli: null },
      ]).status === "unique"
    );
  }
  return false;
};
