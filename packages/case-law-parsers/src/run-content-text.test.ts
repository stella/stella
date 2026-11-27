import { expect, test } from "bun:test";

import { runContentVisibleText } from "./run-content-text";
import { VISIBLE_RUN_CASES } from "./run-content-text.fixtures";

test.each(Object.values(VISIBLE_RUN_CASES))(
  "run kind $item.type has an explicit visible-text policy",
  ({ item, text }) => {
    expect(runContentVisibleText(item)).toBe(text);
  },
);

test.each(["page", "column", "textWrapping"] as const)(
  "%s breaks keep the reader's newline convention",
  (breakType) => {
    expect(runContentVisibleText({ type: "break", breakType })).toBe("\n");
  },
);

test("unencoded symbol text remains visible", () => {
  expect(
    runContentVisibleText({ type: "symbol", font: "Symbol", char: "Ω" }),
  ).toBe("Ω");
});
