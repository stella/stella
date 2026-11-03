import { expect, test } from "bun:test";

import { DECISION_DOCKET_FILING_YEAR_FIXTURES } from "./decision-docket-filing-year.fixtures";
import {
  DECISION_DOCKET_GRAMMARS,
  DECISION_IDENTIFIER_WHITESPACE,
  foldDecisionIdentifierInput,
} from "./decision-docket-grammar";

test("filing-year evidence survives docket formatting and input folding", () => {
  const covered = new Set<string>();
  for (const {
    jurisdiction,
    caseNumber,
    expected,
  } of DECISION_DOCKET_FILING_YEAR_FIXTURES) {
    const grammar = DECISION_DOCKET_GRAMMARS[jurisdiction];
    covered.add(jurisdiction);
    expect(
      grammar.filingYear(caseNumber),
      `${jurisdiction}: ${caseNumber}`,
    ).toEqual(expected);
    expect(grammar.filingYear(foldDecisionIdentifierInput(caseNumber))).toEqual(
      expected,
    );
    const parsed = grammar.parse(caseNumber);
    if (parsed !== null) {
      expect(parsed.filingYear).toEqual(expected);
      expect(grammar.parse(parsed.formatted)?.filingYear).toEqual(expected);
    }
  }
  expect([...covered].toSorted()).toEqual(
    Object.keys(DECISION_DOCKET_GRAMMARS).toSorted(),
  );
});

test("the shared identifier whitespace matches ECMAScript whitespace", () => {
  const whitespace = [];
  for (let codePoint = 0; codePoint <= 65_535; codePoint += 1) {
    const character = String.fromCodePoint(codePoint);
    if (/\s/u.test(character)) {
      whitespace.push(character);
    }
  }
  expect(DECISION_IDENTIFIER_WHITESPACE).toBe(whitespace.join(""));
});
