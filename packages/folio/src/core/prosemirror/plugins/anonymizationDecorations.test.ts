/**
 * Unit tests for the anonymization-decorations plugin's matching
 * logic. The plugin's job is to keep a list of match ranges in
 * sync with the doc; the visible overlay is painted from these
 * ranges by the paged editor, so getting the ranges right is the
 * whole correctness story.
 */

import { describe, expect, test } from "bun:test";
import { Mark, Schema } from "prosemirror-model";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";

import {
  anonymizationDecorationsKey,
  createAnonymizationDecorationsPlugin,
  setAnonymizationTermsMeta,
  slugAnonymizationLabel,
} from "./anonymizationDecorations";
import type {
  AnonymizationMatch,
  AnonymizationTerm,
} from "./anonymizationDecorations";

// Minimal schema with one mark so we can model DOCX-style
// formatting boundaries (bold split mid-paragraph) — the
// situation that originally caused the cross-node-match bug.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
    text: { group: "inline" },
  },
  marks: {
    bold: { toDOM: () => ["strong", 0] },
  },
});

type ParagraphSpec = string | (string | { text: string; bold: true })[];

const para = (...spec: ParagraphSpec[]): PMNode[] =>
  spec.map((entry) => {
    if (typeof entry === "string") {
      return schema.node("paragraph", null, [schema.text(entry)]);
    }
    const bold = schema.marks.bold!.create();
    return schema.node(
      "paragraph",
      null,
      entry.map((part) =>
        typeof part === "string"
          ? schema.text(part)
          : schema.text(part.text, [bold] as Mark[]),
      ),
    );
  });

const makeState = (
  doc: PMNode,
  terms: readonly AnonymizationTerm[] = [],
): EditorState => {
  const plugin = createAnonymizationDecorationsPlugin();
  let state = EditorState.create({ doc, plugins: [plugin] });
  if (terms.length > 0) {
    const { key, payload } = setAnonymizationTermsMeta(terms);
    state = state.apply(state.tr.setMeta(key, payload));
  }
  return state;
};

const getMatches = (state: EditorState): readonly AnonymizationMatch[] =>
  anonymizationDecorationsKey.getState(state)?.matches ?? [];

const sliceFromTo = (doc: PMNode, from: number, to: number): string =>
  doc.textBetween(from, to, "");

describe("anonymizationDecorations: literal matching", () => {
  test("matches a contiguous term within a single text node", () => {
    const doc = schema.node("doc", null, para("Hello Pavel Novák there"));
    const state = makeState(doc, [
      { canonical: "Pavel Novák", label: "person" },
    ]);
    const matches = getMatches(state);
    expect(matches).toHaveLength(1);
    expect(sliceFromTo(doc, matches[0]!.from, matches[0]!.to)).toBe(
      "Pavel Novák",
    );
    expect(matches[0]!.label).toBe("person");
    expect(matches[0]!.canonical).toBe("Pavel Novák");
  });

  test("is case-insensitive", () => {
    const doc = schema.node("doc", null, para("hello PAVEL NOVÁK there"));
    const matches = getMatches(
      makeState(doc, [{ canonical: "Pavel Novák", label: "person" }]),
    );
    expect(matches).toHaveLength(1);
    expect(sliceFromTo(doc, matches[0]!.from, matches[0]!.to)).toBe(
      "PAVEL NOVÁK",
    );
  });

  test("respects word boundaries — no partial-word hits", () => {
    const doc = schema.node("doc", null, para("Johnsonville and John ate"));
    const matches = getMatches(
      makeState(doc, [{ canonical: "John", label: "person" }]),
    );
    expect(matches).toHaveLength(1);
    expect(sliceFromTo(doc, matches[0]!.from, matches[0]!.to)).toBe("John");
  });

  test("treats punctuation and whitespace as boundaries", () => {
    const doc = schema.node(
      "doc",
      null,
      para("Names: Pavel Novák, Karel Dvořák."),
    );
    const matches = getMatches(
      makeState(doc, [
        { canonical: "Pavel Novák", label: "person" },
        { canonical: "Karel Dvořák", label: "person" },
      ]),
    );
    expect(matches).toHaveLength(2);
    const surfaces = matches.map((m) => sliceFromTo(doc, m.from, m.to));
    expect(surfaces).toContain("Pavel Novák");
    expect(surfaces).toContain("Karel Dvořák");
  });

  test("normalises whitespace runs (NBSP, narrow no-break, multi-space)", () => {
    // U+00A0 NBSP between first/last name; matching pattern uses
    // a regular space — the matcher should treat any whitespace
    // run as equivalent.
    const doc = schema.node("doc", null, para("Pavel Novák"));
    const matches = getMatches(
      makeState(doc, [{ canonical: "Pavel Novák", label: "person" }]),
    );
    expect(matches).toHaveLength(1);
    expect(sliceFromTo(doc, matches[0]!.from, matches[0]!.to)).toBe(
      "Pavel Novák",
    );
  });

  test("escapes regex metacharacters in canonical terms", () => {
    const doc = schema.node(
      "doc",
      null,
      para("ENCAP s.r.o. and friends s_r_o text"),
    );
    const matches = getMatches(
      makeState(doc, [{ canonical: "ENCAP s.r.o.", label: "organization" }]),
    );
    expect(matches).toHaveLength(1);
    expect(sliceFromTo(doc, matches[0]!.from, matches[0]!.to)).toBe(
      "ENCAP s.r.o.",
    );
  });
});

describe("anonymizationDecorations: cross-node matching (regression)", () => {
  // DOCX often emits separate runs at every formatting boundary
  // (bold/italic/spacing change). The PM doc mirrors this — a
  // single visible phrase may live in two adjacent text nodes.
  // The matcher must join text within a textblock before running
  // regex so these phrases still match.
  test("matches a term spanning a bold/non-bold boundary", () => {
    const doc = schema.node(
      "doc",
      null,
      para([{ text: "Ing. ", bold: true }, "Pavel Novák, dat. nar."]),
    );
    const matches = getMatches(
      makeState(doc, [{ canonical: "Ing. Pavel Novák", label: "person" }]),
    );
    expect(matches).toHaveLength(1);
    expect(sliceFromTo(doc, matches[0]!.from, matches[0]!.to)).toBe(
      "Ing. Pavel Novák",
    );
  });

  test("does NOT join text across paragraph boundaries", () => {
    // Two separate paragraphs whose concatenation would form
    // the term; the matcher must not bridge across paragraph
    // boundaries even when the next paragraph starts mid-name.
    const doc = schema.node("doc", null, [...para("Pavel"), ...para(" Novák")]);
    const matches = getMatches(
      makeState(doc, [{ canonical: "Pavel Novák", label: "person" }]),
    );
    expect(matches).toHaveLength(0);
  });

  test("yields PM positions that map back to the original text", () => {
    // Two cross-node occurrences in separate paragraphs; both
    // ranges should round-trip through doc.textBetween to the
    // expected surface form.
    const doc = schema.node("doc", null, [
      ...para([{ text: "Ing. ", bold: true }, "Pavel Novák"]),
      ...para([{ text: "Ing. ", bold: true }, "Pavel Novák again"]),
    ]);
    const matches = getMatches(
      makeState(doc, [{ canonical: "Ing. Pavel Novák", label: "person" }]),
    );
    expect(matches).toHaveLength(2);
    for (const match of matches) {
      expect(sliceFromTo(doc, match.from, match.to)).toBe("Ing. Pavel Novák");
    }
  });
});

describe("anonymizationDecorations: variants and dedup", () => {
  test("matches any provided variant alongside the canonical", () => {
    const doc = schema.node(
      "doc",
      null,
      para("Acme Corp. and ACME CORPORATION are the same"),
    );
    const matches = getMatches(
      makeState(doc, [
        {
          canonical: "Acme Corporation",
          label: "organization",
          variants: ["Acme Corp.", "ACME CORPORATION"],
        },
      ]),
    );
    expect(matches).toHaveLength(2);
    const surfaces = matches.map((m) => sliceFromTo(doc, m.from, m.to));
    expect(surfaces).toContain("Acme Corp.");
    expect(surfaces).toContain("ACME CORPORATION");
    for (const m of matches) {
      expect(m.canonical).toBe("Acme Corporation");
    }
  });

  test("prefers the longer surface when a shorter variant is nested", () => {
    // Both "Pavel Novák" and the longer "Ing. Pavel
    // Novák" can match at the same locus — dedup keeps the
    // longer span so we never paint twice over the same letters.
    const doc = schema.node("doc", null, para("see Ing. Pavel Novák below"));
    const matches = getMatches(
      makeState(doc, [
        { canonical: "Ing. Pavel Novák", label: "person" },
        { canonical: "Pavel Novák", label: "person" },
      ]),
    );
    expect(matches).toHaveLength(1);
    expect(sliceFromTo(doc, matches[0]!.from, matches[0]!.to)).toBe(
      "Ing. Pavel Novák",
    );
  });

  test("skips empty canonicals and empty variants without crashing", () => {
    const doc = schema.node("doc", null, para("the real deal here"));
    const matches = getMatches(
      makeState(doc, [
        { canonical: "", label: "person" },
        { canonical: "real", label: "person", variants: ["", "fake"] },
      ]),
    );
    expect(matches).toHaveLength(1);
    expect(sliceFromTo(doc, matches[0]!.from, matches[0]!.to)).toBe("real");
  });
});

describe("anonymizationDecorations: plugin lifecycle", () => {
  test("initialises with empty terms and no matches", () => {
    const doc = schema.node("doc", null, para("anything"));
    const state = EditorState.create({
      doc,
      plugins: [createAnonymizationDecorationsPlugin()],
    });
    const pluginState = anonymizationDecorationsKey.getState(state);
    expect(pluginState?.terms).toEqual([]);
    expect(pluginState?.matches).toEqual([]);
  });

  test("set-terms meta replaces the term list and recomputes matches", () => {
    const doc = schema.node(
      "doc",
      null,
      para("Pavel Novák and Karel Dvořák here"),
    );
    let state = makeState(doc, [{ canonical: "Pavel Novák", label: "person" }]);
    expect(getMatches(state)).toHaveLength(1);

    const { key, payload } = setAnonymizationTermsMeta([
      { canonical: "Karel Dvořák", label: "person" },
    ]);
    state = state.apply(state.tr.setMeta(key, payload));
    const matches = getMatches(state);
    expect(matches).toHaveLength(1);
    expect(sliceFromTo(doc, matches[0]!.from, matches[0]!.to)).toBe(
      "Karel Dvořák",
    );
  });

  test("rebuilds matches when the doc changes", () => {
    let state = makeState(schema.node("doc", null, para("nothing here")), [
      { canonical: "Pavel Novák", label: "person" },
    ]);
    expect(getMatches(state)).toHaveLength(0);

    // Insert "Pavel Novák " at the very start of the
    // first paragraph (PM position 1, just after the
    // paragraph's opening token).
    state = state.apply(state.tr.insertText("Pavel Novák ", 1));
    const matches = getMatches(state);
    expect(matches).toHaveLength(1);
    expect(sliceFromTo(state.doc, matches[0]!.from, matches[0]!.to)).toBe(
      "Pavel Novák",
    );
  });
});

describe("slugAnonymizationLabel", () => {
  test("lowercases and replaces non-alphanumeric runs with a single dash", () => {
    expect(slugAnonymizationLabel("Phone Number")).toBe("phone-number");
    expect(slugAnonymizationLabel("EMAIL_ADDRESS")).toBe("email-address");
    expect(slugAnonymizationLabel("organization")).toBe("organization");
  });
});
