import { expect, test } from "bun:test";

import type {
  Block,
  DocumentAst,
  ParagraphRole,
} from "@stll/legal-ast/document-ast";

import {
  publisherHeadnoteOf,
  publisherKeywordsOf,
  publisherSummaryOf,
} from "@/api/lib/case-law/publisher-summary";

const documentAst = (blocks: Block[]): DocumentAst => ({
  version: 1,
  source: {
    system: "test",
    documentId: "1",
    webUrl: "https://example.test/1",
    printUrl: "https://example.test/1.pdf",
  },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks,
});

const paragraph = (
  id: string,
  plainText: string,
  role?: ParagraphRole,
): Block => ({
  id,
  anchorId: id,
  type: "paragraph",
  ...(role === undefined ? {} : { role }),
  inlines: [{ type: "text", text: plainText }],
  plainText,
});

test("marked apparatus paragraphs win over every metadata key, in document order", () => {
  const summary = publisherSummaryOf({
    documentAst: documentAst([
      paragraph("b1", "Nadpis"),
      paragraph("b2", "Věta druhá", "summary"),
      paragraph("b3", "Odůvodnění", "argumentation"),
      paragraph("b4", "Věta první", "headnotes"),
    ]),
    metadata: { legalSentence: "z metadat" },
  });

  // Document order, not the order the roles are declared in: the publisher
  // decided which paragraph comes first.
  expect(summary).toBe("Věta druhá\n\nVěta první");
});

test("an AST without apparatus paragraphs falls through to metadata", () => {
  expect(
    publisherSummaryOf({
      documentAst: documentAst([
        paragraph("b1", "Odůvodnění", "argumentation"),
      ]),
      metadata: { legalSentence: "z metadat" },
    }),
  ).toBe("z metadat");
});

test("a source that publishes only an abstract under `summary` is read", () => {
  // The PL adapter records the publisher's `summary`; before the sources were
  // declared in one list the display chain never looked at that key.
  expect(
    publisherSummaryOf({
      documentAst: null,
      metadata: { summary: "Teza orzeczenia" },
    }),
  ).toBe("Teza orzeczenia");
});

test("a source that publishes plural `legalAreas` is read", () => {
  // The AT adapter records `legalAreas`; the display chain read the singular
  // `legalArea` only, so those decisions showed nothing.
  expect(
    publisherSummaryOf({
      documentAst: null,
      metadata: { legalAreas: ["Zivilrecht", "Mietrecht"] },
    }),
  ).toBe("Zivilrecht · Mietrecht");
});

test("nothing publisher-authored is no summary", () => {
  expect(publisherSummaryOf({ documentAst: null, metadata: null })).toBeNull();
  expect(
    publisherSummaryOf({
      documentAst: documentAst([]),
      metadata: { legalSentence: "   ", keywords: [], legalAreas: ["  "] },
    }),
  ).toBeNull();
});

test("a key an adapter left absent falls through to the next source", () => {
  // What an adapter writes for a field its source published nothing in: no
  // key at all. The reading must pass it over, so a decision the publisher
  // wrote no legal sentence for is read from whatever it did publish, and one
  // it published nothing for shows no line rather than an empty one.
  expect(
    publisherHeadnoteOf({
      documentAst: null,
      metadata: { abstract: "Abstrakt rozhodnutí" },
    }),
  ).toBe("Abstrakt rozhodnutí");
  expect(
    publisherHeadnoteOf({
      documentAst: null,
      metadata: { keywords: ["Daně"] },
    }),
  ).toBeNull();
});

test("a value of the wrong JSON shape is skipped, not coerced", () => {
  expect(
    publisherSummaryOf({
      documentAst: null,
      metadata: {
        legalSentence: 42,
        keywords: "not a list",
        legalArea: "Daně",
      },
    }),
  ).toBe("Daně");
});

test("a summary opening with a one-letter word keeps it", () => {
  // "v" is a preposition in the corpus languages and opens summaries often,
  // which makes it the first casualty of a trim set that acquires a letter.
  // Pinned on both readings; the SQL side is in the database binding test.
  expect(
    publisherSummaryOf({
      documentAst: null,
      metadata: { legalSentence: "v řízení o dovolání" },
    }),
  ).toBe("v řízení o dovolání");
  expect(
    publisherSummaryOf({
      documentAst: null,
      metadata: { legalArea: "  v likvidaci  " },
    }),
  ).toBe("v likvidaci");
});

test("a headnote is a sentence somebody wrote, never a classification", () => {
  // The reading the corpus index writes into its headnote field. Every
  // classification key at once, so the answer cannot be an accident of order:
  // no source of this list holds one, so none can come back from it.
  const classified = {
    documentAst: null,
    metadata: {
      keywords: ["nájem", "výpověď"],
      legalAreas: ["Občanské právo"],
      legalArea: "Daně",
    },
  };

  expect(publisherHeadnoteOf(classified)).toBeNull();
  expect(publisherKeywordsOf(classified)).toBe("nájem · výpověď");
  expect(
    publisherHeadnoteOf({
      documentAst: documentAst([paragraph("b1", "Právní věta", "headnotes")]),
      metadata: { legalArea: "Daně" },
    }),
  ).toBe("Právní věta");
});

test("the line a reader sees falls back to the classification", () => {
  // Display behaviour, unchanged: a decision whose publisher wrote no sentence
  // reads better with the terms it was filed under than with an empty line.
  // What the index must not do is score that fallback as a headnote.
  const tagged = { documentAst: null, metadata: { legalArea: "Daně" } };

  expect(publisherSummaryOf(tagged)).toBe("Daně");
  expect(publisherSummaryOf(tagged)).toBe(publisherKeywordsOf(tagged));
  const written = {
    documentAst: null,
    metadata: { legalSentence: "Právní věta", legalArea: "Daně" },
  };
  expect(publisherSummaryOf(written)).toBe(publisherHeadnoteOf(written));
});
