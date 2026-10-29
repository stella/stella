import { expect, test } from "bun:test";

import {
  largePublicQuoteDecision,
  publicQuoteCases,
  publicQuoteDecisions,
} from "../../evals/lib/verify-quote-cases";
import { verifyQuote } from "./verify-quote.logic";

test("public Czech court quotes calibrate exact, altered and fabricated outcomes", () => {
  const decisions = publicQuoteDecisions();
  for (const [index, decision] of decisions.entries()) {
    const other = decisions.at((index + 1) % decisions.length);
    expect(other).toBeDefined();
    for (const scenario of publicQuoteCases(
      decision.fulltext,
      other?.fulltext ?? "",
    )) {
      const result = verifyQuote({
        text: decision.fulltext,
        quote: scenario.quote,
        located: [],
        url: null,
      });
      expect({
        court: decision.court,
        scenario: scenario.name,
        status: result.status,
      }).toEqual({
        court: decision.court,
        scenario: scenario.name,
        status: scenario.expected,
      });
      expect(result.verified).toBe(scenario.expected === "exact");
    }
  }
});

test("a 216k-character public decision returns a closest passage for fabricated text", () => {
  const text = largePublicQuoteDecision();
  expect(text.length).toBeGreaterThan(200_000);
  const started = performance.now();
  const result = verifyQuote({
    text,
    quote:
      "Žalovaný elektronicky garantoval nezvratnou správnost kvantové rekonstrukce právních následků.",
    located: [],
    url: null,
  });
  const milliseconds = performance.now() - started;
  console.info(
    "verify_quote benchmark",
    JSON.stringify({ characters: text.length, milliseconds }),
  );
  expect(milliseconds).toBeLessThan(5000);
  expect(result.status).toBe("not_found");
  expect(result.verified).toBe(false);
  if (result.status !== "exact") {
    expect(result.segments.at(0)?.closest?.text.length).toBeGreaterThan(0);
  }
});
