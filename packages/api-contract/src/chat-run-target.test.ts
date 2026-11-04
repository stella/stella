import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  chatLocalRunAnswersRefusal,
  type ChatLocalRunQuestion,
  chatLocalRunQuestionSchema,
} from "./chat-run-target";

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
});
