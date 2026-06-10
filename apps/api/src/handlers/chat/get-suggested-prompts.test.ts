import { describe, expect, test } from "bun:test";

import { cleanSuggestionsText } from "./get-suggested-prompts";

describe("cleanSuggestionsText", () => {
  test("extracts clean prompts from plain lines", () => {
    const text = "What are the key risks?\nCan you draft a response?\nExplain the governing law section.";

    expect(cleanSuggestionsText(text)).toEqual([
      "What are the key risks?",
      "Can you draft a response?",
      "Explain the governing law section.",
    ]);
  });

  test("strips list markers and numbers", () => {
    const text = "1. What are the key risks?\n2. Can you draft a response?\n- Explain the governing law.";

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
    const text = "  What are the key risks?  \n\n   \n  Can you draft a response?  ";

    expect(cleanSuggestionsText(text)).toEqual([
      "What are the key risks?",
      "Can you draft a response?",
    ]);
  });

  test("limits to 3 prompts", () => {
    const text = "First prompt?\nSecond prompt?\nThird prompt?\nFourth prompt?";

    expect(cleanSuggestionsText(text)).toEqual([
      "First prompt?",
      "Second prompt?",
      "Third prompt?",
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