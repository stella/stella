import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { HarnessQuestion } from "./events";
import {
  harnessQuestionSchema,
  questionAnswersRefusal,
} from "./question-answers";

const tone: HarnessQuestion = {
  id: "tone",
  header: "Tone",
  prompt: "Formal or friendly?",
  options: [
    { label: "Formal", description: "For the court" },
    { label: "Friendly", description: "For the client" },
  ],
  allowsFreeText: false,
  secret: false,
};
const passphrase: HarnessQuestion = {
  id: "passphrase",
  header: "Passphrase",
  prompt: "The archive passphrase?",
  options: [],
  allowsFreeText: true,
  secret: true,
};
const questions = [tone, passphrase];

describe("question answers", () => {
  test("answer every question asked, options by label, free text where allowed", () => {
    expect(
      questionAnswersRefusal(questions, {
        tone: ["Formal", "Friendly"],
        passphrase: ["open sesame"],
      }),
    ).toBeNull();
  });

  test("are refused when they leave a question out, invent an option or answer one never asked", () => {
    const cases: [string, Record<string, string[]>, string][] = [
      ["left out", { tone: ["Formal"] }, "Question passphrase has no answer."],
      [
        "empty",
        { tone: [], passphrase: ["x"] },
        "Question tone has no answer.",
      ],
      [
        "invented option",
        { tone: ["Casual"], passphrase: ["x"] },
        "Question tone takes one of its options.",
      ],
      [
        "never asked",
        { tone: ["Formal"], passphrase: ["x"], venue: ["Brno"] },
        "Question venue was not asked.",
      ],
    ];
    for (const [name, answers, refusal] of cases) {
      expect({
        name,
        refusal: questionAnswersRefusal(questions, answers),
      }).toEqual({ name, refusal });
    }
  });

  test("read back the questions a chunk carries", () => {
    // As the chunk carries them: plain data, not the typed values.
    const carried: unknown = structuredClone(questions);
    const read: unknown = v.parse(v.array(harnessQuestionSchema), carried);
    expect(read).toEqual(questions);
    expect(v.is(harnessQuestionSchema, { id: "tone" })).toBe(false);
  });
});
