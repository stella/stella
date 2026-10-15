import { TypeCompiler } from "@sinclair/typebox/compiler";
import { expect, test } from "bun:test";

import { LIMITS } from "@/api/lib/limits";

import { clauseBodySchema, clauseExpectedBodySchema } from "./body-schema";
import { normalizeClauseBody } from "./types";

const expectedBody = TypeCompiler.Compile(clauseExpectedBodySchema);

test("preconditions accept paragraph extensions within the text bound", () => {
  const paragraph = {
    text: "x".repeat(LIMITS.clauseExpectedBodyTextChars),
    extra: { source: "import" },
  };
  expect(expectedBody.Check([paragraph])).toBe(true);
  expect(
    expectedBody.Check([{ ...paragraph, text: `${paragraph.text}x` }]),
  ).toBe(false);
});

test("preconditions enforce the paragraph count bound", () => {
  const paragraphs = Array.from(
    { length: LIMITS.clauseExpectedBodyParagraphs },
    () => ({ text: "" }),
  );
  expect(expectedBody.Check(paragraphs)).toBe(true);
  paragraphs.push({ text: "" });
  expect(expectedBody.Check(paragraphs)).toBe(false);
  expect(expectedBody.Check([])).toBe(false);
});

const writtenBody = TypeCompiler.Compile(clauseBodySchema);

test("clause numbering accepts every supported level and rejects invalid levels", () => {
  for (let ilvl = 0; ilvl <= 8; ilvl += 1) {
    expect(
      writtenBody.Check([
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
    expect(writtenBody.Check(imported)).toBe(false);
    expect(normalizeClauseBody(imported)).toEqual([{ text: "Item" }]);
  }
});

test("clause writes reject removed list depth fields", () => {
  for (const field of ["listLevel", "list_level"]) {
    expect(writtenBody.Check([{ text: "Item", [field]: 1 }])).toBe(false);
  }
  expect(
    writtenBody.Check([
      { text: "Item", numbering: { kind: "levelOnly", ilvl: 1, extra: true } },
    ]),
  ).toBe(false);
});
