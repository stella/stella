/** Deterministic local contract calibration; does not measure model tool choice. */
import * as v from "valibot";

import {
  verifyQuoteArgsSchema,
  verifyQuoteOutputSchema,
} from "../src/mcp/verify-quote-tools";
import { verifyQuote } from "../src/mcp/verify-quote.logic";
import {
  largePublicQuoteDecision,
  publicQuoteCases,
  publicQuoteDecisions,
} from "./lib/verify-quote-cases";

const decisions = publicQuoteDecisions();
const rows = decisions.flatMap((decision, index) =>
  publicQuoteCases(
    decision.fulltext,
    decisions.at((index + 1) % decisions.length)?.fulltext ?? "",
  ).map((scenario) => {
    const request = v.parse(verifyQuoteArgsSchema, {
      decision_id: "01990000-00a4-7000-8000-000000000001",
      text: scenario.quote,
    });
    const result = verifyQuote({
      text: decision.fulltext,
      quote: request.text,
      located: [],
      url: null,
    });
    v.parse(verifyQuoteOutputSchema, {
      decisionId: request.decision_id,
      textSource: "fulltext",
      ...result,
    });
    const score =
      result.status === "exact"
        ? 1
        : Math.min(
            ...result.segments.map(({ closest }) => closest?.similarity ?? 0),
          );
    return {
      court: decision.court,
      caseNumber: decision.case_number,
      scenario: scenario.name,
      expected: scenario.expected,
      actual: result.status,
      verified: result.verified,
      score,
      pass:
        result.status === scenario.expected &&
        result.verified === (scenario.expected === "exact"),
    };
  }),
);
const text = largePublicQuoteDecision();
const start = performance.now();
const result = verifyQuote({
  text,
  quote:
    "Soud jednomyslně dovodil, že automatizovaná analýza všech digitálních podkladů zakládá nevyvratitelnou domněnku oprávněnosti žalobního nároku bez dalšího dokazování.",
  located: [],
  url: null,
});
process.stdout.write(
  `${JSON.stringify({ kind: "local-deterministic-contract-eval", modelChoice: "NOT COVERED", rows, benchmark: { caseNumber: "Pl. ÚS 19/08", characters: text.length, milliseconds: performance.now() - start, result: result.status } }, null, 2)}\n`,
);
if (rows.some(({ pass }) => !pass)) {
  process.exitCode = 1;
}
