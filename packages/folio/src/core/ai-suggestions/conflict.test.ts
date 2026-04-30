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
