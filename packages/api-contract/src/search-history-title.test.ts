import { expect, test } from "bun:test";

import { SEARCH_HISTORY_TITLE_MAX_LENGTH } from "./limits";
import { buildSearchHistoryTitle } from "./search-history-title";

test("a maximum-length court name leaves the complete case number in history", () => {
  const caseNumber = "23 Cdo 1001/2021";
  const title = buildSearchHistoryTitle({
    identifier: caseNumber,
    description: "N".repeat(SEARCH_HISTORY_TITLE_MAX_LENGTH),
  });
  expect(title.length).toBe(SEARCH_HISTORY_TITLE_MAX_LENGTH);
  expect(title.startsWith(`${caseNumber} · `)).toBe(true);
  expect(title.endsWith("…")).toBe(true);
});

test("history title boundaries preserve fitting descriptions and identifiers", () => {
  const identifier = "89/2012";
  const description = "a".repeat(
    SEARCH_HISTORY_TITLE_MAX_LENGTH - `${identifier} · `.length,
  );
  expect(buildSearchHistoryTitle({ identifier, description })).toBe(
    `${identifier} · ${description}`,
  );
  expect(
    buildSearchHistoryTitle({ identifier, description: `${description}b` }),
  ).toBe(`${identifier} · ${description.slice(0, -1)}…`);
  const fullIdentifier = "x".repeat(SEARCH_HISTORY_TITLE_MAX_LENGTH);
  expect(
    buildSearchHistoryTitle({
      identifier: fullIdentifier,
      description: "Court",
    }),
  ).toBe(fullIdentifier);
  expect(buildSearchHistoryTitle({ identifier, description: "" })).toBe(
    identifier,
  );
});

test("truncated history descriptions do not split a surrogate pair", () => {
  const title = buildSearchHistoryTitle({
    identifier: "",
    description: `${"a".repeat(SEARCH_HISTORY_TITLE_MAX_LENGTH - 2)}😀tail`,
  });
  expect(title.length).toBeLessThanOrEqual(SEARCH_HISTORY_TITLE_MAX_LENGTH);
  expect(title.isWellFormed()).toBe(true);
  expect(title.endsWith("…")).toBe(true);
});
