import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  chatLocalRunAnswersRefusal,
  type ChatLocalRunQuestion,
  chatLocalRunQuestionSchema,
  chatLocalRunQuestionsSchema,
} from "./chat-run-target";
import {
  DESKTOP_RUNNER_ANSWER_LIMITS,
  desktopRunnerQuestionAnswersSchema,
} from "./desktop-runner";

const tone: ChatLocalRunQuestion = {
  id: "tone",
  header: "Tone",
  prompt: "Formal or friendly?",
  options: [
    { label: "Formal", description: "For the court" },
    { label: "Friendly", description: "For the client" },
  ],
  allowsFreeText: false,
  multiSelect: false,
  secret: false,
};
const parties: ChatLocalRunQuestion = {
  id: "parties",
  header: "Parties",
  prompt: "Which parties sign?",
  options: [
    { label: "Lessor", description: "" },
    { label: "Lessee", description: "" },
  ],
  allowsFreeText: false,
  multiSelect: true,
  secret: false,
};
const passphrase: ChatLocalRunQuestion = {
  id: "passphrase",
  header: "Passphrase",
  prompt: "The archive passphrase?",
  options: [],
  allowsFreeText: true,
  multiSelect: false,
  secret: true,
};
const questions = [tone, parties, passphrase];

describe("local run question answers", () => {
  test("answer every question asked, options by label, several only where allowed, free text where allowed", () => {
    expect(
      chatLocalRunAnswersRefusal(questions, {
        tone: ["Formal"],
        parties: ["Lessor", "Lessee"],
        passphrase: ["open sesame"],
      }),
    ).toBeNull();
  });

  test("are refused when they leave a question out, invent an option, pick several of a single choice or answer one never asked", () => {
    const answered = {
      tone: ["Formal"],
      parties: ["Lessor"],
      passphrase: ["x"],
    };
    const cases: [string, Record<string, string[]>, string][] = [
      [
        "left out",
        { tone: ["Formal"], parties: ["Lessor"] },
        "Question passphrase has no answer.",
      ],
      ["empty", { ...answered, tone: [] }, "Question tone has no answer."],
      [
        "invented option",
        { ...answered, tone: ["Casual"] },
        "Question tone takes one of its options.",
      ],
      [
        "several of a single choice",
        { ...answered, tone: ["Formal", "Friendly"] },
        "Question tone takes one answer.",
      ],
      [
        "never asked",
        { ...answered, venue: ["Brno"] },
        "Question venue was not asked.",
      ],
    ];
    for (const [name, answers, refusal] of cases) {
      expect({
        name,
        refusal: chatLocalRunAnswersRefusal(questions, answers),
      }).toEqual({ name, refusal });
    }
  });

  test("a question id that names an object property is still unanswered", () => {
    const inherited: ChatLocalRunQuestion = { ...passphrase, id: "toString" };
    expect(chatLocalRunAnswersRefusal([inherited], {})).toBe(
      "Question toString has no answer.",
    );
  });

  test("read back the questions a chunk carries", () => {
    // As the chunk carries them: plain data, not the typed values.
    const carried: unknown = structuredClone(questions);
    const read: unknown = v.parse(v.array(chatLocalRunQuestionSchema), carried);
    expect(read).toEqual(questions);
    expect(v.is(chatLocalRunQuestionSchema, { id: "tone" })).toBe(false);
    const withoutChoice = Object.fromEntries(
      Object.entries(tone).filter(([key]) => key !== "multiSelect"),
    );
    expect(v.is(chatLocalRunQuestionSchema, withoutChoice)).toBe(false);
  });

  test("a pause asks only what one answer can carry back", () => {
    const { maxQuestions, maxQuestionIdLength } = DESKTOP_RUNNER_ANSWER_LIMITS;
    const asking = (ids: readonly string[]) =>
      ids.map((id) => ({ ...passphrase, id }));
    const answering = (ids: readonly string[]) =>
      Object.fromEntries(ids.map((id) => [id, ["open sesame"]]));
    const numbered = (count: number) =>
      Array.from({ length: count }, (_, index) => `q${String(index)}`);
    const longest = "q".repeat(maxQuestionIdLength);
    // Every pause the schema takes is answerable within the answer's limits.
    for (const ids of [numbered(maxQuestions), [longest]]) {
      expect(v.is(chatLocalRunQuestionsSchema, asking(ids))).toBe(true);
      expect(v.is(desktopRunnerQuestionAnswersSchema, answering(ids))).toBe(
        true,
      );
      expect(chatLocalRunAnswersRefusal(asking(ids), answering(ids))).toBe(
        null,
      );
    }
    for (const ids of [
      numbered(maxQuestions + 1),
      [`${longest}q`],
      [""],
      // One answer per id: two questions under one id could not differ.
      ["tone", "law", "tone"],
    ]) {
      expect(v.is(chatLocalRunQuestionsSchema, asking(ids))).toBe(false);
    }
  });
});
