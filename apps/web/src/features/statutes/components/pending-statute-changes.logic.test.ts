import { expect, test } from "bun:test";

import { resolveAmendmentHref } from "./pending-statute-changes.logic";

test("bare ELI identifiers resolve to statute routes", () => {
  expect(resolveAmendmentHref("eli/cz/sb/2026/159")).toBe(
    "/law/cze/statutes/159-2026-sb",
  );
});

test("inert identifiers have no link destination", () => {
  expect(resolveAmendmentHref("publisher-record-159")).toBeUndefined();
});
