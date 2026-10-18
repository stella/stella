import { expect, test } from "bun:test";

import { resolveAmendmentHref } from "./pending-statute-changes.logic";

test("bare ELI identifiers resolve to statute routes", () => {
  expect(resolveAmendmentHref("eli/cz/sb/2026/159")).toBe(
    "/law/cze/statutes/159-2026-sb",
  );
});

test("root-relative ELI identifiers resolve to statute routes", () => {
  expect(resolveAmendmentHref("/eli/cz/sb/2026/159")).toBe(
    "/law/cze/statutes/159-2026-sb",
  );
});

test("inert identifiers have no link destination", () => {
  expect(resolveAmendmentHref("publisher-record-159")).toBeUndefined();
});

test.each(["eli/at/bgbl/2026/159", "/eli/at/bgbl/2026/159", "/publisher/159"])(
  "an unresolved relative identifier %s remains plain text",
  (identifier) => {
    expect(resolveAmendmentHref(identifier)).toBeUndefined();
  },
);

test("an absolute publisher URL stays a link", () => {
  expect(resolveAmendmentHref("https://example.test/2026/159")).toBe(
    "https://example.test/2026/159",
  );
});
