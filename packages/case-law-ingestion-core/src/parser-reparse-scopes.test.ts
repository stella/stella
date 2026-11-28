import { expect, test } from "bun:test";

import {
  matchesParserReparseScope,
  type ParserReparseFeature,
  type ParserReparseScope,
} from "./parser-reparse-scopes";

const features = {
  citations: {
    table: "case_law_decisions",
    column: "citations",
    stored: true,
    backfilled: true,
  },
} as const satisfies Record<string, ParserReparseFeature>;

const featureScope = {
  type: "features",
  features: ["citations"],
} as const satisfies ParserReparseScope<typeof features>;

test("all parser scope enqueues every decision", () => {
  const scope = { type: "all", reason: "test all rows" } as const;
  expect(matchesParserReparseScope(scope, () => false, features)).toBe(true);
});

test("feature parser scope enqueues only decisions matching a stored selector", () => {
  expect(matchesParserReparseScope(featureScope, () => true, features)).toBe(
    true,
  );
  expect(matchesParserReparseScope(featureScope, () => false, features)).toBe(
    false,
  );
});
