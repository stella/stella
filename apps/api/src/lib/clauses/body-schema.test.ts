import { TypeCompiler } from "@sinclair/typebox/compiler";
import { expect, test } from "bun:test";

import { LIMITS } from "@/api/lib/limits";

import { clauseExpectedBodySchema } from "./body-schema";

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
