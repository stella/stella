import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";

import { resolveSuggestionAnchor } from "./conflict";
import type { AISuggestion } from "./types";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block" },
    text: {},
  },
});

function makeDoc(paragraphs: string[]) {
  return schema.node(
    "doc",
    null,
    paragraphs.map((p) =>
      schema.node("paragraph", null, p.length === 0 ? [] : [schema.text(p)]),
    ),
  );
}

function makeSuggestion(
  partial: Partial<AISuggestion> & {
    originalText: string;
    contextBefore: string;
    contextAfter: string;
  },
): AISuggestion {
  return {
    id: partial.id ?? "test",
    topic: partial.topic ?? "Test",
    severity: partial.severity ?? "style",
    range: partial.range ?? { from: 0, to: 0 },
    originalText: partial.originalText,
    suggestedText: partial.suggestedText ?? "",
    contextBefore: partial.contextBefore,
    contextAfter: partial.contextAfter,
    rationale: partial.rationale ?? "",
    status: partial.status ?? "pending",
  };
}

describe("resolveSuggestionAnchor", () => {
  test("finds text inside the first paragraph", () => {
    const doc = makeDoc(["The agreement shall apply."]);
    const suggestion = makeSuggestion({
      originalText: "shall",
      contextBefore: "agreement ",
      contextAfter: " apply",
    });
    const anchor = resolveSuggestionAnchor(doc, suggestion);
    if (!anchor) {
      throw new Error("expected anchor to be resolved");
    }
    expect(doc.textBetween(anchor.from, anchor.to)).toBe("shall");
  });

  test("finds text in a later paragraph (PM positions skip block tokens)", () => {
    const doc = makeDoc(["First paragraph.", "The agreement shall apply."]);
    const suggestion = makeSuggestion({
      originalText: "shall",
      contextBefore: "agreement ",
      contextAfter: " apply",
    });
    const anchor = resolveSuggestionAnchor(doc, suggestion);
    if (!anchor) {
      throw new Error("expected anchor to be resolved");
    }
    expect(doc.textBetween(anchor.from, anchor.to)).toBe("shall");
  });

  test("returns null when the original text is no longer present", () => {
    const doc = makeDoc(["Completely different content."]);
    const suggestion = makeSuggestion({
      originalText: "shall",
      contextBefore: "agreement ",
      contextAfter: " apply",
    });
    expect(resolveSuggestionAnchor(doc, suggestion)).toBeNull();
  });

  test("returns null on ambiguous (non-unique) match", () => {
    const doc = makeDoc(["foo bar baz", "foo bar baz"]);
    const suggestion = makeSuggestion({
      originalText: "bar",
      contextBefore: "foo ",
      contextAfter: " baz",
    });
    expect(resolveSuggestionAnchor(doc, suggestion)).toBeNull();
  });

  test("uses the recorded range fast-path when text still matches", () => {
    const doc = makeDoc(["The agreement shall apply."]);
    // Walk to find "shall" — its PM position is 1 + index in paragraph.
    const paragraphText = "The agreement shall apply.";
    const start = paragraphText.indexOf("shall") + 1;
    const directRange = { from: start, to: start + "shall".length };
    expect(doc.textBetween(directRange.from, directRange.to)).toBe("shall");
    const suggestion = makeSuggestion({
      originalText: "shall",
      contextBefore: "agreement ",
      contextAfter: " apply",
      range: directRange,
    });
    const anchor = resolveSuggestionAnchor(doc, suggestion);
    expect(anchor).toEqual(directRange);
  });
});

describe("resolveSuggestionAnchor fallbacks", () => {
  test("falls back to one-sided context when a neighbouring edit broke the other side", () => {
    // The suggestion was generated when the text read
    // "Company Ltd with offices at 10 Main St" — then accepting the adjacent
    // company-name suggestion replaced "Company Ltd" with "{{name}}", so
    // contextBefore no longer matches; contextAfter + text still do.
    const doc = makeDoc(["{{name}} with offices at 10 Main St, registered"]);
    const suggestion = makeSuggestion({
      originalText: "10 Main St",
      contextBefore: "Company Ltd with offices at ",
      contextAfter: ", registered",
    });
    const anchor = resolveSuggestionAnchor(doc, suggestion);
    if (!anchor) {
      throw new Error("expected anchor to be resolved via fallback");
    }
    expect(doc.textBetween(anchor.from, anchor.to)).toBe("10 Main St");
  });

  test("fallback stays null when the bare text is ambiguous", () => {
    // Both contexts are gone and the text appears twice — no safe anchor.
    const doc = makeDoc(["10 Main St then 10 Main St"]);
    const suggestion = makeSuggestion({
      originalText: "10 Main St",
      contextBefore: "vanished before ",
      contextAfter: " vanished after",
    });
    expect(resolveSuggestionAnchor(doc, suggestion)).toBeNull();
  });
});
