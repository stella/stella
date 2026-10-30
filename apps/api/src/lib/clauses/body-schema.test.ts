import { expect, test } from "bun:test";
import * as v from "valibot";

import { CLAUSE_NUMBERING_LEVEL_LIMITS } from "@stll/api-contract";

import { LIMITS } from "@/api/lib/limits";

import { clauseBodySchema, clauseExpectedBodySchema } from "./body-schema";
import { normalizeClauseBody } from "./types";

const acceptsExpectedBody = (value: unknown) =>
  v.is(clauseExpectedBodySchema, value);

test("preconditions accept paragraph extensions within the text bound", () => {
  const paragraph = {
    text: "x".repeat(LIMITS.clauseExpectedBodyTextChars),
    extra: { source: "import" },
  };
  expect(acceptsExpectedBody([paragraph])).toBe(true);
  // A precondition compares the stored body, so its extensions are kept.
  expect(v.parse(clauseExpectedBodySchema, [paragraph])).toEqual([paragraph]);
  expect(
    acceptsExpectedBody([{ ...paragraph, text: `${paragraph.text}x` }]),
  ).toBe(false);
});

test("preconditions enforce the paragraph count bound", () => {
  const paragraphs = Array.from(
    { length: LIMITS.clauseExpectedBodyParagraphs },
    () => ({ text: "" }),
  );
  expect(acceptsExpectedBody(paragraphs)).toBe(true);
  paragraphs.push({ text: "" });
  expect(acceptsExpectedBody(paragraphs)).toBe(false);
  expect(acceptsExpectedBody([])).toBe(false);
});

const acceptsWrittenBody = (value: unknown) => v.is(clauseBodySchema, value);

test("clause numbering accepts every supported level and rejects invalid levels", () => {
  for (let ilvl = 0; ilvl <= 8; ilvl += 1) {
    expect(
      acceptsWrittenBody([
        {
          text: "Item",
          listKind: "ordered",
          numbering: { kind: "levelOnly", ilvl },
        },
      ]),
    ).toBe(true);
  }
  for (const ilvl of [-1, 0.5, 9]) {
    const imported = [{ text: "Item", numbering: { kind: "levelOnly", ilvl } }];
    expect(acceptsWrittenBody(imported)).toBe(false);
    expect(normalizeClauseBody(imported)).toEqual([{ text: "Item" }]);
  }
});

test("clause numbering bounds come from the shared contract limits", () => {
  const item = (ilvl: number) => [
    {
      text: "Item",
      listKind: "ordered",
      numbering: { kind: "levelOnly", ilvl },
    },
  ];
  expect(LIMITS.clauseNumberingLevelMin).toBe(
    CLAUSE_NUMBERING_LEVEL_LIMITS.min,
  );
  expect(LIMITS.clauseNumberingLevelMax).toBe(
    CLAUSE_NUMBERING_LEVEL_LIMITS.max,
  );
  expect(acceptsWrittenBody(item(CLAUSE_NUMBERING_LEVEL_LIMITS.max))).toBe(
    true,
  );
  expect(acceptsWrittenBody(item(CLAUSE_NUMBERING_LEVEL_LIMITS.max + 1))).toBe(
    false,
  );
});

test("clause writes reject removed list depth fields", () => {
  for (const field of ["listLevel", "list_level"]) {
    expect(v.is(clauseBodySchema, [{ text: "Item", [field]: 1 }])).toBe(false);
  }
  expect(
    v.is(clauseBodySchema, [
      { text: "Item", numbering: { kind: "levelOnly", ilvl: 1, extra: true } },
    ]),
  ).toBe(false);
});
