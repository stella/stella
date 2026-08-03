import { describe, expect, test } from "bun:test";

import getSuggestedPrompts, {
  cleanSuggestionsText,
  latestAssistantTurnAwaitsUser,
  SUGGESTIONS_SYSTEM_PROMPT,
} from "./get-suggested-prompts";

describe("suggested prompts usage metering", () => {
  test("does not run static usage preflight before no-op fallbacks", () => {
    expect("requiresUsage" in getSuggestedPrompts.config).toBe(false);
  });
});

describe("suggested prompts perspective", () => {
  test("defines suggestions as verbatim user messages, not questions to the user", () => {
    expect(SUGGESTIONS_SYSTEM_PROMPT).toContain(
      "inserted verbatim into the USER'S message composer",
    );
    expect(SUGGESTIONS_SYSTEM_PROMPT).toContain(
      "Never write a question that the AI would ask the user",
    );
    expect(SUGGESTIONS_SYSTEM_PROMPT).toContain("Chceš doplnit...?");
  });
});

describe("suggested prompts turn ownership", () => {
  test("blocks follow-ups while the latest ask-user call awaits an answer", () => {
    expect(
      latestAssistantTurnAwaitsUser([
        {
          parts: [
            {
              arguments: '{"question":"Which jurisdiction?"}',
              id: "ask-1",
              name: "ask-user",
              state: "input-complete",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
      ]),
    ).toBe(true);
  });

  test("allows follow-ups after the clarification has been answered", () => {
    expect(
      latestAssistantTurnAwaitsUser([
        {
          parts: [
            {
              arguments: '{"question":"Which jurisdiction?"}',
              id: "ask-1",
              name: "ask-user",
              state: "complete",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
      ]),
    ).toBe(false);
  });

  test("blocks follow-ups while any tool awaits approval", () => {
    expect(
      latestAssistantTurnAwaitsUser([
        {
          parts: [
            {
              arguments: "{}",
              id: "approval-1",
              name: "save_matter",
              state: "approval-requested",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
      ]),
    ).toBe(true);
  });
});

describe("cleanSuggestionsText", () => {
  test("extracts clean prompts from plain lines", () => {
    const text =
      "What are the key risks?\nCan you draft a response?\nExplain the governing law section.";

    expect(cleanSuggestionsText(text)).toEqual([
      "What are the key risks?",
      "Can you draft a response?",
      "Explain the governing law section.",
    ]);
  });

  test("strips list markers and numbers", () => {
    const text =
      "1. What are the key risks?\n2. Can you draft a response?\n- Explain the governing law.";

    expect(cleanSuggestionsText(text)).toEqual([
      "What are the key risks?",
      "Can you draft a response?",
      "Explain the governing law.",
    ]);
  });

  test("strips surrounding quotes and bullet points", () => {
    const text = `"What are the key risks?"\n- Can you draft a response?\n(Explain the governing law.)`;

    expect(cleanSuggestionsText(text)).toEqual([
      "What are the key risks?",
      "Can you draft a response?",
      "Explain the governing law.",
    ]);
  });

  test("trims whitespace and filters empty lines", () => {
    const text =
      "  What are the key risks?  \n\n   \n  Can you draft a response?  ";

    expect(cleanSuggestionsText(text)).toEqual([
      "What are the key risks?",
      "Can you draft a response?",
    ]);
  });

  test("limits to 4 prompts", () => {
    const text =
      "First prompt?\nSecond prompt?\nThird prompt?\nFourth prompt?\nFifth prompt?";

    expect(cleanSuggestionsText(text)).toEqual([
      "First prompt?",
      "Second prompt?",
      "Third prompt?",
      "Fourth prompt?",
    ]);
  });

  test("returns empty array for empty input", () => {
    expect(cleanSuggestionsText("")).toEqual([]);
  });

  test("handles lines with only whitespace or markers", () => {
    const text = "-   \n1.   \n   ";

    expect(cleanSuggestionsText(text)).toEqual([]);
  });

  test("preserves prompts that start with digits", () => {
    const text = "3D print analysis?\n2nd amendment summary?";

    expect(cleanSuggestionsText(text)).toEqual([
      "3D print analysis?",
      "2nd amendment summary?",
    ]);
  });
});
