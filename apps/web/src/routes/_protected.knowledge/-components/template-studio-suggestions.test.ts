import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";

import { resolveSuggestionAnchor } from "@stll/folio";

import {
  buildReplacementSuggestions,
  extractFieldMarkerPath,
} from "./template-studio-suggestions";
import type { ReplacementSpec } from "./template-studio-suggestions";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block" },
    text: {},
  },
});

const makeDoc = (paragraphs: string[]) =>
  schema.node(
    "doc",
    null,
    paragraphs.map((p) =>
      schema.node("paragraph", null, p.length === 0 ? [] : [schema.text(p)]),
    ),
  );

const spec = (partial: Partial<ReplacementSpec>): ReplacementSpec => ({
  id: partial.id ?? "op-1",
  literalText: partial.literalText ?? "",
  suggestedText: partial.suggestedText ?? "",
  topic: partial.topic ?? "t",
  rationale: partial.rationale ?? "",
  ...(partial.scopeText === undefined ? {} : { scopeText: partial.scopeText }),
  ...(partial.display === undefined ? {} : { display: partial.display }),
  ...(partial.registerMeta === undefined
    ? {}
    : { registerMeta: partial.registerMeta }),
});

describe("buildReplacementSuggestions", () => {
  test("contexts come from positional text so anchors re-resolve", () => {
    const doc = makeDoc(["Seller: Acme Inc.", "Buyer: Beta s.r.o."]);
    const { suggestions } = buildReplacementSuggestions(doc, [
      spec({ literalText: "Beta s.r.o.", suggestedText: "{{buyer.name}}" }),
    ]);

    expect(suggestions).toHaveLength(1);
    const suggestion = suggestions[0];
    if (!suggestion) {
      throw new Error("expected a suggestion");
    }
    // The context window crosses the block boundary — positional text
    // joins blocks with "\n"; any other separator breaks re-anchoring.
    expect(suggestion.contextBefore).toContain("\n");
    expect(suggestion.contextBefore.endsWith("Buyer: ")).toBe(true);
    const anchor = resolveSuggestionAnchor(doc, suggestion);
    expect(anchor).toEqual(suggestion.range);
    expect(
      doc.textBetween(suggestion.range.from, suggestion.range.to, "\n"),
    ).toBe("Beta s.r.o.");
  });

  test("scopeText confines the search to the operation's block", () => {
    const doc = makeDoc([
      "Acme Inc. delivers the goods.",
      "Acme Inc. signs below.",
    ]);
    const { suggestions, placedSpecIds } = buildReplacementSuggestions(doc, [
      spec({
        id: "op-second-block",
        literalText: "Acme Inc.",
        suggestedText: "{{company.name}}",
        scopeText: "Acme Inc. signs below.",
      }),
    ]);

    expect(placedSpecIds.has("op-second-block")).toBe(true);
    expect(suggestions).toHaveLength(1);
    expect(
      doc.textBetween(
        suggestions[0]?.range.from ?? 0,
        suggestions[0]?.range.to ?? 0,
        "\n",
      ),
    ).toBe("Acme Inc.");
    // Anchored in the second paragraph, not the first occurrence.
    expect(suggestions[0]?.contextBefore ?? "").toContain("goods.");
  });

  test("unmatched literals report as not placed; matched specs map every occurrence without overlap", () => {
    const doc = makeDoc(["Jan Novak and Jan Novak agree."]);
    const { suggestions, placedSpecIds } = buildReplacementSuggestions(doc, [
      spec({
        id: "op-name",
        literalText: "Jan Novak",
        suggestedText: "{{party.name}}",
      }),
      // Overlaps the first spec's spans — first spec wins per range.
      spec({ id: "op-overlap", literalText: "Novak and Jan" }),
      spec({ id: "op-missing", literalText: "Not in the document" }),
    ]);

    expect(suggestions).toHaveLength(2);
    expect(placedSpecIds.has("op-name")).toBe(true);
    expect(placedSpecIds.has("op-overlap")).toBe(false);
    expect(placedSpecIds.has("op-missing")).toBe(false);
  });
});

describe("extractFieldMarkerPath", () => {
  test("accepts exactly one {{path}} marker (whitespace tolerated)", () => {
    expect(extractFieldMarkerPath("{{company.name}}")).toBe("company.name");
    expect(extractFieldMarkerPath("  {{ signing_date }}  ")).toBe(
      "signing_date",
    );
  });

  test("rejects non-marker replacements and invalid paths", () => {
    expect(extractFieldMarkerPath("Example Ltd.")).toBeNull();
    expect(extractFieldMarkerPath("{{a}} and {{b}}")).toBeNull();
    expect(extractFieldMarkerPath("{{attorneys[0].name}}")).toBeNull();
    expect(extractFieldMarkerPath("{{#if condition}}")).toBeNull();
  });
});
