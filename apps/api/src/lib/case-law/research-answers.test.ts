import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  parseResearchAnswers,
  selectPassagesWithinBudget,
} from "@/api/lib/case-law/research-answers";
import type {
  ResearchAnswersOutput,
  ResearchQuestion,
} from "@/api/lib/case-law/research-answers";

const passage = fc.record({
  anchorId: fc.stringMatching(/^[a-z0-9-]{0,12}$/u),
  excerpt: fc.string({ maxLength: 400 }),
});

describe("selecting passages within a budget", () => {
  test("stays within budget, keeps order, and cites each anchor once", () => {
    fc.assert(
      fc.property(
        fc.array(passage, { maxLength: 40 }),
        fc.integer({ min: 0, max: 3000 }),
        fc.integer({ min: 1, max: 500 }),
        (passages, budgetChars, passageChars) => {
          const selected = selectPassagesWithinBudget(passages, {
            budgetChars,
            passageChars,
          });

          const used = selected.reduce(
            (sum, entry) => sum + entry.excerpt.length,
            0,
          );
          expect(used).toBeLessThanOrEqual(budgetChars);
          expect(new Set(selected.map((entry) => entry.anchorId)).size).toBe(
            selected.length,
          );
          for (const entry of selected) {
            expect(entry.excerpt.length).toBeLessThanOrEqual(passageChars);
            expect(entry.excerpt.length).toBeGreaterThan(0);
            expect(entry.anchorId.length).toBeGreaterThan(0);
          }
          // A subsequence of the input by anchor: ranking order survives.
          const inputOrder = passages.map((entry) => entry.anchorId);
          let cursor = 0;
          for (const entry of selected) {
            const index = inputOrder.indexOf(entry.anchorId, cursor);
            expect(index).toBeGreaterThanOrEqual(cursor);
            cursor = index + 1;
          }
        },
      ),
      propertyConfig(),
    );
  });

  test("the best passages survive a short budget", () => {
    const selected = selectPassagesWithinBudget(
      [
        { anchorId: "p-1", excerpt: "first ".repeat(20) },
        { anchorId: "p-2", excerpt: "second ".repeat(20) },
        { anchorId: "p-3", excerpt: "third" },
      ],
      { budgetChars: 130, passageChars: 100 },
    );
    expect(selected.map((entry) => entry.anchorId)).toEqual(["p-1"]);
  });
});

const question = fc.record({
  columnId: fc.uuid(),
  question: fc.string({ minLength: 1, maxLength: 80 }),
  answerType: fc.constantFrom("yes_no", "text"),
}) satisfies fc.Arbitrary<ResearchQuestion>;

const questions = fc.uniqueArray(question, {
  minLength: 1,
  maxLength: 8,
  selector: (entry) => entry.columnId,
});

const modelAnswer = (columnIds: readonly string[], anchorIds: string[]) =>
  fc.record({
    columnId: fc.oneof(fc.constantFrom(...columnIds), fc.uuid()),
    yesNo: fc.option(fc.constantFrom("yes", "no", "unclear"), {
      nil: undefined,
    }),
    text: fc.option(fc.string({ maxLength: 60 }), { nil: undefined }),
    confidence: fc.double({ min: 0, max: 1, noNaN: true }),
    rationale: fc.string({ maxLength: 800 }),
    anchorIds: fc.array(
      fc.oneof(
        fc.constantFrom(...(anchorIds.length > 0 ? anchorIds : ["p-none"])),
        fc.string({ maxLength: 8 }),
      ),
      { maxLength: 6 },
    ),
  }) satisfies fc.Arbitrary<ResearchAnswersOutput["answers"][number]>;

describe("parsing the model's answers", () => {
  test("every question ends answered or failed, with only prompt anchors kept", () => {
    const scenario = questions.chain((asked) =>
      fc
        .uniqueArray(fc.stringMatching(/^p-[0-9]{1,3}$/u), { maxLength: 6 })
        .chain((knownAnchors) =>
          fc.tuple(
            fc.constant(asked),
            fc.constant(knownAnchors),
            fc.array(
              modelAnswer(
                asked.map((entry) => entry.columnId),
                knownAnchors,
              ),
              { maxLength: 12 },
            ),
          ),
        ),
    );

    fc.assert(
      fc.property(scenario, ([asked, knownAnchors, answers]) => {
        const parsed = parseResearchAnswers({
          output: { answers },
          questions: asked,
          knownAnchorIds: new Set(knownAnchors),
        });

        expect(parsed.map((entry) => entry.columnId)).toEqual(
          asked.map((entry) => entry.columnId),
        );
        for (const [index, entry] of parsed.entries()) {
          const expected = asked[index];
          if (entry.outcome.state === "failed") {
            continue;
          }
          expect(entry.outcome.answer.type).toBe(expected?.answerType);
          expect(entry.outcome.rationale.length).toBeLessThanOrEqual(600);
          // Cited anchors are a subsequence of the prompt's anchors: nothing
          // invented, and prompt order kept.
          let cursor = 0;
          for (const anchorId of entry.outcome.anchorIds) {
            const position = knownAnchors.indexOf(anchorId, cursor);
            expect(position).toBeGreaterThanOrEqual(cursor);
            cursor = position + 1;
          }
        }
      }),
      propertyConfig(),
    );
  });

  test("a yes/no question answered as text fails by type, not silently", () => {
    const [parsed] = parseResearchAnswers({
      output: {
        answers: [
          {
            columnId: "c1",
            text: "The court allowed it.",
            confidence: 0.9,
            rationale: "see §12",
            anchorIds: [],
          },
        ],
      },
      questions: [
        { columnId: "c1", question: "Allowed?", answerType: "yes_no" },
      ],
      knownAnchorIds: new Set(),
    });
    expect(parsed?.outcome).toEqual({
      state: "failed",
      failureReason: "wrong_type",
    });
  });

  test("a skipped question fails as missing", () => {
    const [parsed] = parseResearchAnswers({
      output: { answers: [] },
      questions: [{ columnId: "c1", question: "Outcome?", answerType: "text" }],
      knownAnchorIds: new Set(),
    });
    expect(parsed?.outcome).toEqual({
      state: "failed",
      failureReason: "missing_answer",
    });
  });
});
