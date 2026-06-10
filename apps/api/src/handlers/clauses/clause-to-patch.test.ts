import { describe, expect, test } from "bun:test";

import {
  clauseBodyToPlainText,
  clauseBodyToRichPatch,
} from "./clause-to-patch";
import type { ClauseBody } from "./types";

describe("clauseBodyToRichPatch", () => {
  test("maps each paragraph to its runs", () => {
    const body: ClauseBody = [
      { text: "Alpha", runs: [{ text: "Alpha", bold: true }] },
      { text: "Beta", runs: [{ text: "Beta", italic: true }] },
    ];

    expect(clauseBodyToRichPatch(body)).toEqual({
      paragraphs: [
        { runs: [{ text: "Alpha", bold: true }] },
        { runs: [{ text: "Beta", italic: true }] },
      ],
    });
  });

  test("falls back to a single text run when a paragraph has no runs", () => {
    const body: ClauseBody = [{ text: "Plain" }];

    expect(clauseBodyToRichPatch(body)).toEqual({
      paragraphs: [{ runs: [{ text: "Plain" }] }],
    });
  });

  test("drops block-directive paragraphs from the fill value", () => {
    const body: ClauseBody = [
      { text: "{{#if x}}", isDirective: true, directiveKind: "if" },
      { text: "Conditional" },
      { text: "{{/if}}", isDirective: true, directiveKind: "endif" },
    ];

    expect(clauseBodyToRichPatch(body)).toEqual({
      paragraphs: [{ runs: [{ text: "Conditional" }] }],
    });
  });

  test("keeps an intentional blank paragraph as an empty run", () => {
    // A blank line maps to one empty-text run, so the rich-patch engine keeps
    // the paragraph (it has a w:r) rather than dropping it as a stray fragment.
    const body: ClauseBody = [{ text: "" }];

    expect(clauseBodyToRichPatch(body)).toEqual({
      paragraphs: [{ runs: [{ text: "" }] }],
    });
  });
});

describe("clauseBodyToPlainText", () => {
  test("keeps directive paragraphs so condition changes show up in diffs", () => {
    const body: ClauseBody = [
      { text: "{{#if x}}", isDirective: true, directiveKind: "if" },
      { text: "Body" },
      { text: "{{/if}}", isDirective: true, directiveKind: "endif" },
    ];

    expect(clauseBodyToPlainText(body)).toBe("{{#if x}}\nBody\n{{/if}}");
  });
});
