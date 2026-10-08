import { expect, test } from "bun:test";

import { decisionSampleForPrompt } from "@/api/handlers/case-law/research/columns-suggest-prompt";
import { presentTextField } from "@/api/lib/case-law/decision-text";

test("suggestion samples retain identity and omit withheld summaries", () => {
  expect(
    decisionSampleForPrompt({
      caseNumber: "15 Cdo 45/2024",
      court: "Nejvyšší soud",
      decisionDate: "2024-05-15",
      headnote: presentTextField("Publisher summary and keywords"),
      textWithheldReason: "source_licence",
    }),
  ).toEqual({
    caseNumber: "15 Cdo 45/2024",
    court: "Nejvyšší soud",
    decisionDate: "2024-05-15",
    headnote: null,
  });
});

test("suggestion samples keep available published summaries", () => {
  expect(
    decisionSampleForPrompt({
      caseNumber: "25 Cdo 1234/2021",
      court: "Nejvyšší soud",
      decisionDate: "2021-04-02",
      headnote: presentTextField(
        "Ušlý zisk se nahrazuje jen v prokázaném rozsahu.",
      ),
      textWithheldReason: null,
    }).headnote,
  ).toBe("Ušlý zisk se nahrazuje jen v prokázaném rozsahu.");
});
