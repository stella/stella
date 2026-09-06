import { expect, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { toSafeId } from "@/api/lib/branded-types";
import { UNDATED_DECISION_TIMESTAMP } from "@/api/lib/legal-search/corpus-index-config";
import { CORPUS_INDEX_MANIFESTS } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  buildCaseLawProjectionDocuments,
  buildCorpusProjectionDocuments,
  buildLegislationV2ProjectionDocuments,
} from "@/api/lib/legal-search/corpus-index-projection-builder";
import type {
  CaseLawProjectionInput,
  LegislationV2ProjectionInput,
} from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { corpusTokens } from "@/api/lib/legal-search/corpus-tokens";

const REVISION = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000001",
);
const CASE_LAW_INPUT = {
  family: "case_law",
  documentId: "0198e331-e578-7000-8000-000000000002",
  sourceId: "0198e331-e578-7000-8000-000000000003",
  jurisdiction: "cze",
  language: "cs",
  documentType: "judgment",
  contentHash: "a".repeat(64),
  redistributionEligible: true,
  redacted: false,
  caseNumber: "4 As 3/2008",
  identifiers: [
    { type: "source", value: "NSS-4-AS-3-2008" },
    { type: "docket", value: "4 As 3/2008" },
  ],
  court: "Nejvyšší správní soud",
  decisionDate: null,
  ecli: null,
  metadata: null,
} as const satisfies CaseLawProjectionInput;
const LEGISLATION_INPUT = {
  family: "legislation",
  documentId: "0198e331-e578-7000-8000-000000000004",
  sourceId: "0198e331-e578-7000-8000-000000000005",
  jurisdiction: "CZE",
  language: "cs",
  documentType: "act",
  contentHash: "b".repeat(64),
  redistributionEligible: true,
  title: "Občanský zákoník",
  status: "current",
  effectiveDate: "2014-01-01",
  versionValidFrom: "2014-01-01",
  versionValidTo: null,
  eli: "eli/cz/sb/2012/89",
} as const satisfies LegislationV2ProjectionInput;
const DATED_CASE_LAW_INPUT = {
  ...CASE_LAW_INPUT,
  decisionDate: "2008-01-30",
} as const satisfies CaseLawProjectionInput;

const manifestFields = (
  generation: keyof typeof CORPUS_INDEX_MANIFESTS,
): Set<string> =>
  new Set(
    CORPUS_INDEX_MANIFESTS[
      generation
    ].engine.indexConfig.doc_mapping.field_mappings.map(({ name }) => name),
  );

test("case-law v5 emits exact attempt identity and one opening passage", () => {
  const documents = buildCaseLawProjectionDocuments({
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v5,
    input: DATED_CASE_LAW_INPUT,
    payload: {
      text: `${"první ".repeat(400)}\n\n${"druhý ".repeat(400)}`,
      ast: null,
    },
    revision: REVISION,
  });

  expect(documents.length).toBeGreaterThan(1);
  expect(documents.filter(({ is_opening }) => is_opening)).toHaveLength(1);
  expect(documents.at(0)).toMatchObject({
    document_id: CASE_LAW_INPUT.documentId,
    projection_revision: REVISION,
    jurisdiction: "CZE",
    is_opening: true,
    title: "4 As 3/2008 · NSS-4-AS-3-2008 — Nejvyšší správní soud",
    decision_date_ts: DATED_CASE_LAW_INPUT.decisionDate,
    decision_year: 2008,
  });
  for (const [index, document] of documents.entries()) {
    expect(document.projection_revision).toBe(REVISION);
    expect("title" in document).toBe(index === 0);
    expect("decision_year" in document).toBe(index === 0);
    expect(
      Object.keys(document).every((key) =>
        manifestFields("case_law_v5").has(key),
      ),
    ).toBe(true);
  }
});

test("case-law v5 omits a year for an undated decision", () => {
  const [document] = buildCaseLawProjectionDocuments({
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v5,
    input: CASE_LAW_INPUT,
    payload: { text: "Usnesení", ast: null },
    revision: REVISION,
  });

  expect(document).toMatchObject({
    decision_date_ts: UNDATED_DECISION_TIMESTAMP,
  });
  expect(document).not.toHaveProperty("decision_year");
});

test("legislation v2 emits one strict pointer-free document", () => {
  const documents = buildLegislationV2ProjectionDocuments({
    input: LEGISLATION_INPUT,
    payload: { text: "§ 1 Předmět úpravy", ast: null },
    revision: REVISION,
  });

  expect(documents).toEqual([
    {
      document_id: LEGISLATION_INPUT.documentId,
      projection_revision: REVISION,
      jurisdiction: "CZE",
      source: LEGISLATION_INPUT.sourceId,
      language: "cs",
      document_type: "act",
      title: "Občanský zákoník",
      text: "§ 1 Předmět úpravy",
      is_opening: true,
      status: "current",
      effective_date: "2014-01-01",
      version_valid_from: "2014-01-01",
      eli: "eli/cz/sb/2012/89",
    },
  ]);
  expect(
    Object.keys(documents[0]).every((key) =>
      manifestFields("legislation_v2").has(key),
    ),
  ).toBe(true);
});

test("builder dispatch is exhaustive over manifest-owned versions", () => {
  expect(
    buildCorpusProjectionDocuments({
      family: "case_law",
      manifest: CORPUS_INDEX_MANIFESTS.case_law_v5,
      input: CASE_LAW_INPUT,
      payload: { text: "Rozsudek", ast: null },
      revision: REVISION,
    }),
  ).toHaveLength(1);
  expect(
    buildCorpusProjectionDocuments({
      family: "legislation",
      manifest: CORPUS_INDEX_MANIFESTS.legislation_v2,
      input: LEGISLATION_INPUT,
      payload: { text: "Zákon", ast: null },
      revision: REVISION,
    }),
  ).toHaveLength(1);
});

const SUMMARY_AST = {
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
  blocks: [
    {
      id: "b1",
      anchorId: "b1",
      type: "paragraph",
      role: "headnotes",
      inlines: [{ type: "text", text: "Právní věta" }],
      plainText: "Právní věta",
    },
    {
      id: "b2",
      anchorId: "b2",
      type: "paragraph",
      role: "argumentation",
      inlines: [{ type: "text", text: "Odůvodnění" }],
      plainText: "Odůvodnění",
    },
  ],
} as const satisfies DocumentAst;

test("v6 writes the publisher summary on the opening passage only", () => {
  const documents = buildCaseLawProjectionDocuments({
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v6,
    input: { ...CASE_LAW_INPUT, metadata: { legalArea: "Daně" } },
    payload: {
      text: `${"první ".repeat(400)}\n\n${"druhý ".repeat(400)}`,
      ast: null,
    },
    revision: REVISION,
  });

  expect(documents.length).toBeGreaterThan(1);
  // Metadata only, because this payload carries no AST.
  expect(documents.at(0)).toMatchObject({ headnote: "Daně" });
  for (const [index, document] of documents.entries()) {
    expect("headnote" in document).toBe(index === 0);
    expect(
      Object.keys(document).every((key) =>
        manifestFields("case_law_v6").has(key),
      ),
    ).toBe(true);
  }
});

test("v6 prefers a marked apparatus paragraph to a metadata key", () => {
  const [document] = buildCaseLawProjectionDocuments({
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v6,
    input: { ...CASE_LAW_INPUT, metadata: { legalArea: "Daně" } },
    payload: { text: "Právní věta\n\nOdůvodnění", ast: SUMMARY_AST },
    revision: REVISION,
  });

  expect(document).toMatchObject({ headnote: "Právní věta" });
});

test("v5 never emits a field its strict mapping does not declare", () => {
  const documents = buildCaseLawProjectionDocuments({
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v5,
    input: { ...CASE_LAW_INPUT, metadata: { legalArea: "Daně" } },
    payload: { text: "Právní věta", ast: SUMMARY_AST },
    revision: REVISION,
  });

  for (const document of documents) {
    expect("headnote" in document).toBe(false);
    expect(
      Object.keys(document).every((key) =>
        manifestFields("case_law_v5").has(key),
      ),
    ).toBe(true);
  }
});

test("v6 writes a stem beside each field a reader's words reach", () => {
  const [document] = buildCaseLawProjectionDocuments({
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v6,
    input: {
      ...CASE_LAW_INPUT,
      language: "cs",
      metadata: { legalSentence: "Nájemního bytu se to netýká." },
    },
    payload: { text: "Nájemního bytu se to netýká.", ast: null },
    revision: REVISION,
  });

  expect(document).toMatchObject({
    text: "Nájemního bytu se to netýká.",
    headnote: "Nájemního bytu se to netýká.",
  });
  // One stem per token, so the stem stream lines up with the surface stream
  // and a stemmed phrase matches adjacently. Counted rather than compared to a
  // pinned string: the assertion is the alignment, not this stemmer's output.
  const tokenCount = (value: string | undefined): number =>
    corpusTokens(value ?? "").length;

  expect(tokenCount(document?.text_stem)).toBeGreaterThan(0);
  expect(tokenCount(document?.text_stem)).toBe(tokenCount(document?.text));
  expect(tokenCount(document?.headnote_stem)).toBe(
    tokenCount(document?.headnote),
  );
  expect(
    Object.keys(document ?? {}).every((key) =>
      manifestFields("case_law_v6").has(key),
    ),
  ).toBe(true);
});

test("a language with no stemmer writes no stem field at all", () => {
  const documents = buildCaseLawProjectionDocuments({
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v6,
    input: {
      ...CASE_LAW_INPUT,
      // Snowball ships no Bulgarian algorithm, so its text goes unstemmed.
      language: "bg",
      metadata: { legalSentence: "Договорът за наем." },
    },
    payload: { text: "Договорът за наем беше прекратен.", ast: null },
    revision: REVISION,
  });

  for (const document of documents) {
    // Not an empty string under a stem name: a field the writer cannot fill
    // is a field it does not emit.
    expect("text_stem" in document).toBe(false);
    expect("headnote_stem" in document).toBe(false);
    expect("headnote" in document).toBe(true);
  }
});

const openingTextStem = (
  jurisdiction: string,
  language: string,
  text: string,
): string | undefined => {
  const [document] = buildCaseLawProjectionDocuments({
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v6,
    input: { ...CASE_LAW_INPUT, jurisdiction, language },
    payload: { text, ast: null },
    revision: REVISION,
  });
  return document?.text_stem;
};

test("a German decision stems with the German algorithm", () => {
  // Pinned rather than compared to a call on the same helper: the point is
  // which algorithm ran, and German umlauts survive it where a neighbouring
  // Germanic algorithm folds them.
  expect(
    openingTextStem("aut", "de", "Die Verträge der Gerichte wurden gekündigt."),
  ).toBe("die vertrag der gericht wurd gekundigt");
});

test("a European decision stems with the language it is written in", () => {
  // The European index carries 24 languages under one jurisdiction, so the
  // jurisdiction names none of them: only the decision's own language can
  // pick the algorithm.
  expect(
    openingTextStem(
      "eu",
      "fr",
      "Les jugements des tribunaux sur les requêtes.",
    ),
  ).toBe("le jug de tribunal sur le requêt");
  expect(
    openingTextStem("eu", "de", "Die Verträge der Gerichte wurden gekündigt."),
  ).toBe("die vertrag der gericht wurd gekundigt");
});

test("the summary stem is written to the opening passage only", () => {
  const documents = buildCaseLawProjectionDocuments({
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v6,
    input: {
      ...CASE_LAW_INPUT,
      language: "cs",
      metadata: { legalSentence: "Právní věta." },
    },
    payload: {
      text: `${"první ".repeat(400)}\n\n${"druhý ".repeat(400)}`,
      ast: null,
    },
    revision: REVISION,
  });

  expect(documents.length).toBeGreaterThan(1);
  for (const [index, document] of documents.entries()) {
    expect("headnote_stem" in document).toBe(index === 0);
    // The passage stem is per passage, beside that passage's own text.
    expect("text_stem" in document).toBe(true);
  }
});

test("v5 emits neither stem field", () => {
  const documents = buildCaseLawProjectionDocuments({
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v5,
    input: {
      ...CASE_LAW_INPUT,
      language: "cs",
      metadata: { legalSentence: "Právní věta." },
    },
    payload: { text: "Nájemního bytu se to netýká.", ast: null },
    revision: REVISION,
  });

  for (const document of documents) {
    expect(
      Object.keys(document).every((key) =>
        manifestFields("case_law_v5").has(key),
      ),
    ).toBe(true);
  }
});

/**
 * Stems are remembered between calls (see the memo in morphology/stem.ts), so
 * what a revision projects to must not depend on what was projected before
 * it: not on the other revisions in the batch, not on their order, and not on
 * whether this one has been built already.
 */
test("a revision projects to the same documents whatever preceded it", () => {
  const revisions = [
    "Nájemního bytu se to netýká, uvedl Nejvyšší správní soud.",
    "Soud rozhodl o nájemním vztahu a o náhradě nákladů řízení.",
    "Nejvyšší soud zrušil rozsudek krajského soudu a věc mu vrátil.",
  ].map((text, index) => ({
    text,
    input: {
      ...CASE_LAW_INPUT,
      language: "cs",
      metadata: { legalSentence: text },
    },
    revision: toSafeId<"corpusIndexProjectionIntent">(
      `0198e331-e578-7000-8000-00000000001${index}`,
    ),
  }));

  const project = ({
    text,
    input,
    revision,
  }: (typeof revisions)[number]): string =>
    JSON.stringify(
      buildCaseLawProjectionDocuments({
        manifest: CORPUS_INDEX_MANIFESTS.case_law_v6,
        input,
        payload: { text, ast: null },
        revision,
      }),
    );

  const first = revisions.map(project);
  // Again in reverse, so every revision is now built with the memo carrying
  // the terms of the ones that followed it the first time round.
  const reversed = revisions.toReversed().map(project);

  expect<string[]>(reversed.toReversed()).toEqual(first);
  expect<string[]>(revisions.map(project)).toEqual(first);
});
