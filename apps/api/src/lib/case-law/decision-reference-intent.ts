// parser-output-unchanged: [cz-nss] relocates the unchanged reference-intent reader; standing NSS parsing and stored replay output are unchanged.
import type { DecisionDocketGrammar } from "@stll/api-contract/decision-docket-grammar";
import {
  parseDecisionQuery,
  storedDecisionReferenceIntent,
} from "@stll/api-contract/decision-query-intent";
import type {
  DecisionIdentifierIntent,
  DecisionReporterGrammar,
} from "@stll/api-contract/decision-query-intent";

/**
 * The reference a resolve call names. A grammar's reading wins; an entry no
 * grammar claims is the stored reference a result displayed (an authority's
 * decision number has no court grammar), so every decision resolves by the
 * reference it shows. Shared by identifier resolution and targeted document recovery.
 */
export const decisionResolveIntent = (
  identifier: string,
  {
    grammar,
    reporters,
  }: {
    grammar: DecisionDocketGrammar | null;
    reporters: DecisionReporterGrammar | null;
  },
): DecisionIdentifierIntent => {
  const parsed = parseDecisionQuery(identifier, { grammar, reporters });
  return parsed.type === "identifier"
    ? parsed
    : storedDecisionReferenceIntent(identifier);
};
