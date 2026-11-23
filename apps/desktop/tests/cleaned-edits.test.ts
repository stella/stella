import { describe, expect, test } from "bun:test";

import { cleanedSource } from "../src/transcribe/cleaned-edits";

const AI_TEXT =
  "## Memo to file\n\nI spoke with **opposing counsel** this morning.";
const EDITED = "## Memo to file\n\nI spoke with **opposing counsel** at 9:30.";

describe("the cleaned-up text copies and saves take", () => {
  test("is the AI text until the speaker edits it", () => {
    expect(cleanedSource(AI_TEXT, null)).toEqual({
      markdown: AI_TEXT,
      edited: false,
    });
  });

  test("is the speaker's text once they edit it", () => {
    expect(cleanedSource(AI_TEXT, { base: AI_TEXT, markdown: EDITED })).toEqual(
      { markdown: EDITED, edited: true },
    );
  });

  test("is no edit when the speaker types the AI text back", () => {
    expect(
      cleanedSource(AI_TEXT, { base: AI_TEXT, markdown: AI_TEXT }),
    ).toEqual({ markdown: AI_TEXT, edited: false });
  });

  test("drops edits made on AI text that has since changed", () => {
    const retried = `${AI_TEXT}\n\nThey propose a joint expert.`;
    expect(retried).not.toBe(AI_TEXT);
    expect(cleanedSource(retried, { base: AI_TEXT, markdown: EDITED })).toEqual(
      { markdown: retried, edited: false },
    );
  });
});
