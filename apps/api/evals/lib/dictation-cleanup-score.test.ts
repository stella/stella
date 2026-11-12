import { describe, expect, test } from "bun:test";

import type { DictationCleanupModelOutput } from "../../src/handlers/dictation/cleanup-model";
import { dictationCleanupCases } from "./dictation-cleanup-cases";
import {
  renderDictationSegments,
  scoreDictationCleanup,
} from "./dictation-cleanup-score";

/** The expected text as segments, the answer a perfect model would give. */
const perfect = (expected: string): DictationCleanupModelOutput => ({
  segments: expected
    .split(/(\n\n|\n|\*\*[^*]+\*\*)/u)
    .filter((part) => part !== "")
    .map((part) => {
      if (part === "\n") {
        return { type: "lineBreak", text: "", bold: false };
      }
      if (part === "\n\n") {
        return { type: "paragraphBreak", text: "", bold: false };
      }
      const bold = part.startsWith("**");
      return { type: "text", text: bold ? part.slice(2, -2) : part, bold };
    }),
});

const results = (answer: (expected: string) => DictationCleanupModelOutput) =>
  dictationCleanupCases.map(({ id, expected }) => ({
    caseId: id,
    harness: "synthetic-scorer-test",
    output: answer(expected),
  }));

describe("local dictation cleanup scoring", () => {
  test("accepts the expected segments for every fixture", () => {
    const scores = scoreDictationCleanup(results(perfect));
    expect(scores.every(({ pass, accepted }) => pass && accepted)).toBe(true);
  });

  test("fails an answer that keeps the spoken commands as words", () => {
    const scores = scoreDictationCleanup(
      dictationCleanupCases.map(({ id, transcript }) => ({
        caseId: id,
        harness: "synthetic-scorer-test",
        output: { segments: [{ type: "text", text: transcript, bold: false }] },
      })),
    );
    expect(scores.some(({ pass }) => pass)).toBe(false);
  });

  test("refuses an answer that responds to the dictation instead of typing it", () => {
    const scores = scoreDictationCleanup(
      results((expected) =>
        expected.startsWith("What is the limitation period")
          ? perfect(
              `${expected} The general limitation period is three years from when the claim could first be exercised.`,
            )
          : perfect(expected),
      ),
    );
    const answered = scores.find(
      ({ caseId }) => caseId === "en-question-not-answered",
    );
    expect(answered).toMatchObject({ accepted: false, pass: false });
  });

  test("renders breaks and bold the way the expectations are written", () => {
    expect(
      renderDictationSegments([
        { type: "text", text: "Lhůta je ", bold: false },
        { type: "text", text: "42", bold: true },
        { type: "text", text: " dní. ", bold: false },
        { type: "paragraphBreak" },
        { type: "text", text: "Konec", bold: false },
      ]),
    ).toBe("Lhůta je **42** dní.\n\nKonec");
  });

  test("requires exactly one result for every fixture", () => {
    const all = results(perfect);
    expect(() => scoreDictationCleanup(all.slice(1))).toThrow(
      "Results must cover each dictation cleanup case exactly once",
    );
    expect(() => scoreDictationCleanup([...all, ...all])).toThrow(
      "Results must cover each dictation cleanup case exactly once",
    );
  });
});
