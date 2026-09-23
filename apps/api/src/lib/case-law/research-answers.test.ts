import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { CASE_LAW_RESEARCH_ANSWER_TYPES } from "@stll/api-contract";
import type { CaseLawResearchAnswerType } from "@stll/api-contract";
import { propertyConfig } from "@stll/property-testing";

import type { FieldContent } from "@/api/db/schema-validators";
import {
  type CaseLawResearchColumnContent,
  type ResearchQuestion,
  buildAnswerJustification,
  buildResearchAnswersSchema,
  buildResearchUserMessage,
  parseResearchAnswers,
  parseStoredAnswerContent,
  selectPassagesWithinBudget,
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

const yesNo = {
  version: 1,
  type: "single-select",
  options: [
    { color: "green", value: "yes" },
    { color: "red", value: "no" },
  ],
  fallback: null,
} satisfies CaseLawResearchColumnContent;

const topics = {
  version: 1,
  type: "multi-select",
  options: [
    { color: "blue", value: "lease" },
    { color: "amber", value: "damages" },
  ],
  fallback: null,
} satisfies CaseLawResearchColumnContent;

const question = (
  columnId: string,
  content: CaseLawResearchColumnContent,
): ResearchQuestion => ({ columnId, question: `About ${columnId}?`, content });

/**
 * Every value kind, from the model's schema through to the stored cell. The
 * model output is parsed by the schema the runner actually sends, so a kind
 * whose schema and parser disagree fails here rather than in production.
 */
type AnswerRoundTrip = {
  name: string;
  content: CaseLawResearchColumnContent;
  /** Exactly what the model returns for this kind. */
  answer: unknown;
  stored: FieldContent;
};

const roundTrips = [
  {
    name: "text",
    content: { version: 1, type: "text" },
    answer: "The appeal was dismissed.",
    stored: { version: 1, type: "text", value: "The appeal was dismissed." },
  },
  {
    name: "single-select",
    content: yesNo,
    answer: "yes",
    stored: { version: 1, type: "single-select", value: "yes" },
  },
  {
    name: "multi-select",
    content: topics,
    answer: ["lease", "damages"],
    stored: {
      version: 1,
      type: "multi-select",
      value: ["lease", "damages"],
    },
  },
  {
    name: "date",
    content: { version: 1, type: "date" },
    answer: "2026-03-15",
    stored: { version: 1, type: "date", value: "2026-03-15" },
  },
  {
    name: "int",
    content: { version: 1, type: "int" },
    answer: { amount: 1500, currency: "CZK" },
    stored: { version: 1, type: "int", value: 1500, currency: "CZK" },
  },
] satisfies readonly AnswerRoundTrip[];

describe("a question column of every value kind", () => {
  for (const { answer, content, name, stored } of roundTrips) {
    test(`${name} survives the model schema and lands as field content`, () => {
      const asked = [question("c1", content)];
      const schema = buildResearchAnswersSchema(asked);
      const parsedOutput = v.parse(schema, {
        c1: { answer, rationale: "see [p-1]", anchorIds: ["p-1"] },
      });

      const [entry] = parseResearchAnswers({
        output: parsedOutput,
        questions: asked,
        knownAnchorIds: new Set(["p-1", "p-2"]),
      });

      expect(entry?.outcome).toEqual({
        state: "answered",
        answer: stored,
        rationale: "see [p-1]",
        anchorIds: ["p-1"],
      });
      // The stored cell is field content the read path accepts unchanged.
      expect(parseStoredAnswerContent(stored)).toEqual(stored);
    });
  }

  test("an option the column does not offer is refused by the parser, not stored", () => {
    const asked = [question("c1", yesNo)];
    const [entry] = parseResearchAnswers({
      output: { c1: { answer: "maybe", rationale: "", anchorIds: [] } },
      questions: asked,
      knownAnchorIds: new Set(),
    });
    expect(entry?.outcome).toEqual({
      state: "failed",
      failureReason: "wrong_type",
    });
  });

  test("a kind whose schema cannot express the answer rejects it before the parser", () => {
    const schema = buildResearchAnswersSchema([
      question("c1", { version: 1, type: "date" }),
    ]);
    expect(
      v.safeParse(schema, {
        c1: { answer: "last Tuesday", rationale: "", anchorIds: [] },
      }).success,
    ).toBe(false);
  });
});

/** One column of each kind; total, so a new kind has to be listed. */
const CONTENT_BY_KIND = {
  text: { version: 1, type: "text" },
  "single-select": yesNo,
  "multi-select": topics,
  date: { version: 1, type: "date" },
  int: { version: 1, type: "int" },
} as const satisfies Record<
  CaseLawResearchAnswerType,
  CaseLawResearchColumnContent
>;

describe("a decision that does not state the answer", () => {
  test("is not_stated for every kind, with the run's reasoning kept", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CASE_LAW_RESEARCH_ANSWER_TYPES),
        fc.string({ maxLength: 40 }),
        fc.subarray(["p-1", "p-2"]),
        (kind, rationale, anchorIds) => {
          const asked = [question("c1", CONTENT_BY_KIND[kind])];
          // Through the schema the runner sends: null has to be a legal answer
          // of every kind, or the model cannot say it.
          const output = v.parse(buildResearchAnswersSchema(asked), {
            c1: { answer: null, rationale, anchorIds },
          });

          const [parsed] = parseResearchAnswers({
            output,
            questions: asked,
            knownAnchorIds: new Set(["p-1", "p-2"]),
          });

          expect(parsed?.outcome).toEqual({
            state: "not_stated",
            rationale: rationale.trim(),
            anchorIds,
          });
        },
      ),
      propertyConfig(),
    );
  });
});

describe("parsing the model's answers", () => {
  test("a skipped question fails as missing", () => {
    const [parsed] = parseResearchAnswers({
      output: {},
      questions: [question("c1", { version: 1, type: "text" })],
      knownAnchorIds: new Set(),
    });
    expect(parsed?.outcome).toEqual({
      state: "failed",
      failureReason: "missing_answer",
    });
  });

  test("blank text is the decision not stating the answer", () => {
    const [parsed] = parseResearchAnswers({
      output: { c1: { answer: "   ", rationale: "Silent.", anchorIds: [] } },
      questions: [question("c1", { version: 1, type: "text" })],
      knownAnchorIds: new Set(),
    });
    expect(parsed?.outcome).toEqual({
      state: "not_stated",
      rationale: "Silent.",
      anchorIds: [],
    });
  });

  test("only anchors that were sent are kept, in prompt order", () => {
    const asked = [question("c1", { version: 1, type: "text" })];
    const [parsed] = parseResearchAnswers({
      output: {
        c1: {
          answer: "Dismissed.",
          rationale: "x".repeat(1000),
          anchorIds: ["p-3", "p-1", "invented"],
        },
      },
      questions: asked,
      knownAnchorIds: new Set(["p-1", "p-2", "p-3"]),
    });
    if (parsed?.outcome.state !== "answered") {
      throw new Error("expected an answered outcome");
    }
    expect(parsed.outcome.anchorIds).toEqual(["p-1", "p-3"]);
    expect(parsed.outcome.rationale.length).toBeLessThanOrEqual(600);
  });

  test("every question ends answered, not stated or failed, whatever the model returns", () => {
    const scenario = fc
      .uniqueArray(fc.uuid(), { minLength: 1, maxLength: 6 })
      .chain((columnIds) =>
        fc.tuple(
          fc.constant(columnIds),
          fc.dictionary(
            fc.oneof(fc.constantFrom(...columnIds), fc.uuid()),
            fc.record({
              answer: fc.option(fc.string({ maxLength: 20 }), { nil: null }),
              rationale: fc.string({ maxLength: 40 }),
              anchorIds: fc.array(fc.string({ maxLength: 8 }), {
                maxLength: 4,
              }),
            }),
            { maxKeys: 8 },
          ),
        ),
      );

    fc.assert(
      fc.property(scenario, ([columnIds, output]) => {
        const asked = columnIds.map((columnId) => question(columnId, yesNo));
        const parsed = parseResearchAnswers({
          output,
          questions: asked,
          knownAnchorIds: new Set(),
        });

        expect(parsed.map((entry) => entry.columnId)).toEqual(columnIds);
        for (const entry of parsed) {
          const returned = output[entry.columnId]?.answer;
          if (returned === null || returned?.trim() === "") {
            expect(entry.outcome.state).toBe("not_stated");
          }
          if (entry.outcome.state !== "answered") {
            continue;
          }
          // The only content a yes/no column can hold, whatever was returned.
          expect(entry.outcome.answer.type).toBe("single-select");
        }
      }),
      propertyConfig(),
    );
  });
});

describe("reading a stored cell", () => {
  test("a value that is not field content reads as the error arm", () => {
    expect(parseStoredAnswerContent({ type: "yes_no", value: "yes" })).toEqual({
      version: 1,
      type: "error",
    });
    expect(parseStoredAnswerContent(null)).toEqual({
      version: 1,
      type: "error",
    });
    // A text cell may not be empty: the schema, not a convention, says so.
    expect(
      parseStoredAnswerContent({ version: 1, type: "text", value: "" }),
    ).toEqual({ version: 1, type: "error" });
  });
});

describe("the cited passages", () => {
  test("become one justification block per anchor, in the order sent", () => {
    const justification = buildAnswerJustification(
      ["p-2", "p-1"],
      new Map([
        ["p-1", "first"],
        ["p-2", "second"],
      ]),
    );
    expect(justification).toEqual({
      version: 1,
      blocks: [
        { kind: "decision-passage", anchorId: "p-2", excerpt: "second" },
        { kind: "decision-passage", anchorId: "p-1", excerpt: "first" },
      ],
    });
  });
});

describe("the prompt", () => {
  test("states each question's expected shape, options included", () => {
    const message = buildResearchUserMessage({
      decision: {
        caseNumber: "1 As 2/2026",
        court: "NSS",
        country: "CZ",
        language: "cs",
        decisionType: null,
      },
      questions: [question("c1", yesNo), question("c2", topics)],
      passages: [{ anchorId: "p-1", excerpt: "text" }],
      retrieved: false,
    });
    expect(message).toContain("Valid options: yes, no.");
    expect(message).toContain("Valid options: lease, damages.");
  });
});
