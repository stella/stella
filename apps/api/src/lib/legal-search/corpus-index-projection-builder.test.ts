import { expect, test } from "bun:test";

import { resolveUsCourt } from "@stll/api-contract/us-courts";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { toSafeId } from "@/api/lib/branded-types";
import { UNDATED_DECISION_TIMESTAMP } from "@/api/lib/legal-search/corpus-index-config";
import {
  corpusIndexGroupConfig,
  corpusIndexGroupContractForJurisdiction,
} from "@/api/lib/legal-search/corpus-index-group-contract";
import { CORPUS_INDEX_MANIFESTS } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  buildCaseLawProjectionDocuments,
  buildCorpusProjectionDocuments,
  buildLegislationV2ProjectionDocuments,
  LEGISLATION_SINGLE_DOCUMENT_MAX_BYTES,
} from "@/api/lib/legal-search/corpus-index-projection-builder";
import type {
  CaseLawProjectionInput,
  LegislationV2ProjectionInput,
} from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES } from "@/api/lib/legal-search/corpus-index-projection-engine";
import { corpusTokens } from "@/api/lib/legal-search/corpus-tokens";
import { EFFECTIVE_CONSOLIDATION } from "@/api/lib/legal-search/legislation-expression-classification";
import { LIMITS } from "@/api/lib/limits";

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
  listingOnly: false,
  caseNumber: "4 As 3/2008",
  identifiers: [
    { type: "source", value: "NSS-4-AS-3-2008" },
    { type: "docket", value: "4 As 3/2008" },
  ],
  court: "Nejvyšší správní soud",
  courtId: null,
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
  ...EFFECTIVE_CONSOLIDATION,
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
    expect(
      Buffer.byteLength(JSON.stringify(document), "utf-8") + 1,
    ).toBeLessThanOrEqual(LIMITS.corpusIndexIngestMaxBytes);
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
  const built = buildLegislationV2ProjectionDocuments({
    input: LEGISLATION_INPUT,
    payload: { text: "§ 1 Předmět úpravy", ast: null },
    revision: REVISION,
  });
  expect(built.isOk()).toBe(true);
  if (built.isErr()) {
    return;
  }
  const documents = built.value;

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
    Object.keys(documents.at(0) ?? {}).every((key) =>
      manifestFields("legislation_v2").has(key),
    ),
  ).toBe(true);
});

test("under-cap legislation keeps the v2 wire documents from main", () => {
  const fixtures = [
    { input: LEGISLATION_INPUT, text: "§ 1 Předmět úpravy" },
    {
      input: {
        ...LEGISLATION_INPUT,
        documentId: "0198e331-e578-7000-8000-000000000006",
        title: "Act / Zákon / قانون",
        effectiveDate: null,
        versionValidFrom: null,
        versionValidTo: "2025-01-01",
      } satisfies LegislationV2ProjectionInput,
      text: "Článek 1, § 2, القانون",
    },
  ];
  const built = fixtures.map(({ input, text }) =>
    buildLegislationV2ProjectionDocuments({
      input,
      payload: { text, ast: null },
      revision: REVISION,
    }),
  );
  expect(built.every((result) => result.isOk())).toBe(true);
  expect(
    built.map((result) => JSON.stringify(result.isOk() ? result.value : [])),
  ).toEqual(
    [
      [
        {
          document_id: "0198e331-e578-7000-8000-000000000004",
          projection_revision: REVISION,
          jurisdiction: "CZE",
          source: LEGISLATION_INPUT.sourceId,
          language: "cs",
          document_type: "act",
          title: "Občanský zákoník",
          text: "§ 1 Předmět úpravy",
          is_opening: true,
          status: "current",
          eli: "eli/cz/sb/2012/89",
          effective_date: "2014-01-01",
          version_valid_from: "2014-01-01",
        },
      ],
      [
        {
          document_id: "0198e331-e578-7000-8000-000000000006",
          projection_revision: REVISION,
          jurisdiction: "CZE",
          source: LEGISLATION_INPUT.sourceId,
          language: "cs",
          document_type: "act",
          title: "Act / Zákon / قانون",
          text: "Článek 1, § 2, القانون",
          is_opening: true,
          status: "current",
          eli: "eli/cz/sb/2012/89",
          version_valid_to: "2025-01-01",
        },
      ],
    ].map((documents) => JSON.stringify(documents)),
  );
});

test("a version's classification writes nothing into the v2 wire documents", () => {
  // v2 has no field for it: a generation that indexes it is a new generation.
  const build = (input: LegislationV2ProjectionInput) =>
    buildLegislationV2ProjectionDocuments({
      input,
      payload: { text: "§ 1 Předmět úpravy", ast: null },
      revision: REVISION,
    });
  const untyped = build(LEGISLATION_INPUT);
  expect(untyped.isOk()).toBe(true);
  for (const input of [
    { ...LEGISLATION_INPUT, expressionKind: "promulgated" },
    {
      ...LEGISLATION_INPUT,
      windowDisposition: "invalid-window",
      windowDispositionBasis: "reversed",
    },
  ] as const satisfies readonly LegislationV2ProjectionInput[]) {
    expect(build(input)).toEqual(untyped);
  }
});

test("oversized legislation becomes exact consecutive v2 passages", () => {
  const text = Array.from(
    { length: 12 },
    (_, index) => `§ ${index + 1}\n${"ustanovení řádu ".repeat(55_000)}`,
  ).join("\n\n");
  const built = buildLegislationV2ProjectionDocuments({
    input: LEGISLATION_INPUT,
    payload: { text, ast: null },
    revision: REVISION,
  });
  expect(built.isOk()).toBe(true);
  if (built.isErr()) {
    return;
  }
  const documents = built.value;
  expect(documents.length).toBeGreaterThan(1);
  expect(documents.map(({ text: passage }) => passage).join("")).toBe(text);
  expect(documents.filter(({ is_opening }) => is_opening)).toHaveLength(1);
  for (const [index, document] of documents.entries()) {
    expect("title" in document).toBe(index === 0);
    expect(document.document_id).toBe(LEGISLATION_INPUT.documentId);
    expect(document.projection_revision).toBe(REVISION);
    expect(
      Object.keys(document).every((key) =>
        manifestFields("legislation_v2").has(key),
      ),
    ).toBe(true);
  }
});

test("one legislation document above 8 MiB stays whole below the engine cap", () => {
  const text = "x".repeat(LIMITS.corpusIndexIngestMaxBytes + 1024);
  const built = buildLegislationV2ProjectionDocuments({
    input: LEGISLATION_INPUT,
    payload: { text, ast: null },
    revision: REVISION,
  });
  expect(built.isOk()).toBe(true);
  if (built.isErr()) {
    return;
  }
  const documents = built.value;

  expect(documents).toHaveLength(1);
  expect(documents.at(0)?.text).toBe(text);
  expect(
    Buffer.byteLength(JSON.stringify(documents.at(0)), "utf-8"),
  ).toBeGreaterThan(LIMITS.corpusIndexIngestMaxBytes);
});

test("serialized single-document cap is inclusive and cap plus one splits", () => {
  const empty = buildLegislationV2ProjectionDocuments({
    input: LEGISLATION_INPUT,
    payload: { text: "", ast: null },
    revision: REVISION,
  });
  expect(empty.isOk()).toBe(true);
  if (empty.isErr()) {
    return;
  }
  expect(empty.value).toHaveLength(1);
  const overhead = Buffer.byteLength(JSON.stringify(empty.value[0]), "utf-8");
  const exactText = "x".repeat(
    LEGISLATION_SINGLE_DOCUMENT_MAX_BYTES - overhead,
  );
  const exact = buildLegislationV2ProjectionDocuments({
    input: LEGISLATION_INPUT,
    payload: { text: exactText, ast: null },
    revision: REVISION,
  });
  expect(exact.isOk()).toBe(true);
  if (exact.isOk()) {
    expect(exact.value).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(exact.value[0]), "utf-8")).toBe(
      LEGISLATION_SINGLE_DOCUMENT_MAX_BYTES,
    );
  }
  const over = buildLegislationV2ProjectionDocuments({
    input: LEGISLATION_INPUT,
    payload: { text: `${exactText}x`, ast: null },
    revision: REVISION,
  });
  expect(over.isOk()).toBe(true);
  if (over.isOk()) {
    expect(over.value.length).toBeGreaterThan(1);
    expect(over.value.map(({ text }) => text).join("")).toBe(`${exactText}x`);
  }
});

test("serialized revision budget rejects escaped text under the raw byte ceiling", () => {
  const text = "\u0000".repeat(
    Math.ceil(CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES / 6),
  );
  expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(
    CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES,
  );
  const built = buildLegislationV2ProjectionDocuments({
    input: LEGISLATION_INPUT,
    payload: { text, ast: null },
    revision: REVISION,
  });
  expect(built.isErr()).toBe(true);
  if (built.isErr()) {
    expect(built.error.message).toContain("append safety ceiling");
  }
});

test("builder dispatch is exhaustive over manifest-owned versions", () => {
  expect(
    buildCorpusProjectionDocuments({
      family: "case_law",
      manifest: CORPUS_INDEX_MANIFESTS.case_law_v5,
      input: CASE_LAW_INPUT,
      payload: { text: "Rozsudek", ast: null },
      revision: REVISION,
    }).isOk(),
  ).toBe(true);
  expect(
    buildCorpusProjectionDocuments({
      family: "legislation",
      manifest: CORPUS_INDEX_MANIFESTS.legislation_v2,
      input: LEGISLATION_INPUT,
      payload: { text: "Zákon", ast: null },
      revision: REVISION,
    }).isOk(),
  ).toBe(true);
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

test("every generation emits stable unique passage identities exactly when its mapping supports them", () => {
  const texts = [
    "první ".repeat(250),
    "druhý ".repeat(250),
    "třetí ".repeat(250),
  ];
  const text = texts.join("\n\n");
  const ast = {
    ...SUMMARY_AST,
    blocks: texts.map((plainText, index) => ({
      id: `p${index}`,
      anchorId: `p${index}`,
      type: "paragraph",
      role: "argumentation",
      plainText,
      inlines: [{ type: "text", text: plainText }],
    })),
  } satisfies DocumentAst;
  const nextRevision = toSafeId<"corpusIndexProjectionIntent">(
    "0198e331-e578-7000-8000-000000000007",
  );
  expect(nextRevision).not.toBe(REVISION);
  for (const manifest of Object.values(CORPUS_INDEX_MANIFESTS)) {
    if (manifest.family !== "case_law") {
      continue;
    }
    const mapping = manifest.engine.indexConfig.doc_mapping.field_mappings.find(
      ({ name }) => name === "chunk_id",
    );
    for (const payload of [
      { text, ast: null },
      { text, ast },
    ]) {
      const documents = buildCaseLawProjectionDocuments({
        manifest,
        input: CASE_LAW_INPUT,
        payload,
        revision: REVISION,
      });
      expect(documents).toHaveLength(texts.length);
      if (mapping === undefined) {
        expect(documents.every((document) => !("chunk_id" in document))).toBe(
          true,
        );
        continue;
      }
      expect(mapping).toMatchObject({
        indexed: true,
        stored: true,
        tokenizer: "raw",
      });
      const expected = documents.map(
        (_, seq) => `${CASE_LAW_INPUT.documentId}:${seq}`,
      );
      const identities = documents.map(({ chunk_id }) => chunk_id);
      expect(identities).toEqual(expected);
      expect(new Set(identities).size).toBe(documents.length);
      const replay = buildCaseLawProjectionDocuments({
        manifest,
        input: CASE_LAW_INPUT,
        payload,
        revision: nextRevision,
      });
      expect(replay.map(({ chunk_id }) => chunk_id)).toEqual(identities);
      const otherId = "0198e331-e578-7000-8000-000000000008";
      expect(otherId).not.toBe(CASE_LAW_INPUT.documentId);
      const other = buildCaseLawProjectionDocuments({
        manifest,
        input: { ...CASE_LAW_INPUT, documentId: otherId },
        payload,
        revision: REVISION,
      });
      expect(other.map(({ chunk_id }) => chunk_id)).toEqual(
        other.map((_, seq) => `${otherId}:${seq}`),
      );
      expect(
        new Set([...identities, ...other.map(({ chunk_id }) => chunk_id)]).size,
      ).toBe(documents.length + other.length);
    }
  }
});

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

test("v7 keeps a classification out of the headnote field", () => {
  const documents = buildCaseLawProjectionDocuments({
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v7,
    input: {
      ...CASE_LAW_INPUT,
      metadata: { keywords: ["nájem", "výpověď"], legalArea: "Daně" },
    },
    payload: {
      text: `${"první ".repeat(400)}\n\n${"druhý ".repeat(400)}`,
      ast: null,
    },
    revision: REVISION,
  });

  expect(documents.length).toBeGreaterThan(1);
  // The publisher wrote no sentence about this decision, so it has no
  // headnote: the terms it was indexed under are not one.
  expect(documents.at(0)).toMatchObject({ keywords: "nájem · výpověď" });
  for (const [index, document] of documents.entries()) {
    expect("headnote" in document).toBe(false);
    expect("headnote_stem" in document).toBe(false);
    expect("keywords" in document).toBe(index === 0);
    expect(
      Object.keys(document).every((key) =>
        manifestFields("case_law_v7").has(key),
      ),
    ).toBe(true);
  }
});

test("v7 writes a headnote and a classification to their own fields", () => {
  const [document] = buildCaseLawProjectionDocuments({
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v7,
    input: {
      ...CASE_LAW_INPUT,
      metadata: {
        legalSentence: "Nájemního bytu se to netýká.",
        legalAreas: ["Občanské právo", "Nájem"],
      },
    },
    payload: { text: "Nájemního bytu se to netýká.", ast: null },
    revision: REVISION,
  });

  expect(document).toMatchObject({
    headnote: "Nájemního bytu se to netýká.",
    keywords: "Občanské právo · Nájem",
  });
  // The headnote keeps its stem companion; the classification has none, so a
  // field it could not fill is a field it does not emit.
  expect("headnote_stem" in (document ?? {})).toBe(true);
  expect("keywords_stem" in (document ?? {})).toBe(false);
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

test("the summary a v6 index already holds keeps its fallback", () => {
  // v6 maps one field for everything a publisher wrote. Splitting the two
  // readings under it would leave one index holding both, so the generation
  // that maps a second field is the one that stops using the fallback.
  const [document] = buildCaseLawProjectionDocuments({
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v6,
    input: { ...CASE_LAW_INPUT, metadata: { keywords: ["nájem"] } },
    payload: { text: "Usnesení", ast: null },
    revision: REVISION,
  });

  expect(document).toMatchObject({ headnote: "nájem" });
  expect("keywords" in (document ?? {})).toBe(false);
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

test("a court-partitioned decision carries its partition on every passage", () => {
  const input = {
    ...DATED_CASE_LAW_INPUT,
    jurisdiction: "USA",
    language: "en",
    court: "Supreme Court of the United States",
    courtId: "scotus",
  } as const satisfies CaseLawProjectionInput;
  const scotus = resolveUsCourt("scotus");
  if (scotus.type !== "accepted") {
    throw new Error("scotus is not an accepted court");
  }
  for (const manifest of [
    CORPUS_INDEX_MANIFESTS.case_law_v5,
    CORPUS_INDEX_MANIFESTS.case_law_v6,
    CORPUS_INDEX_MANIFESTS.case_law_v7,
  ]) {
    const documents = buildCaseLawProjectionDocuments({
      manifest,
      input,
      payload: {
        text: `${"first ".repeat(400)}\n\n${"second ".repeat(400)}`,
        ast: null,
      },
      revision: REVISION,
    });
    expect(documents.length).toBeGreaterThan(1);
    // Every passage, not only the opening one: the partition routes splits,
    // so a passage without it would sit outside every pruned read.
    expect(documents.map((document) => document.court_partition)).toEqual(
      documents.map(() => scotus.court.courtPartition),
    );
    // Strict mapping: every emitted field is one the group's effective
    // contract maps, not merely the manifest.
    const mapped = new Set(
      corpusIndexGroupConfig(
        corpusIndexGroupContractForJurisdiction(manifest, "USA"),
      ).doc_mapping.field_mappings.map(({ name }) => name),
    );
    for (const document of documents) {
      expect(Object.keys(document).filter((key) => !mapped.has(key))).toEqual(
        [],
      );
    }
  }
});

test("a group under its manifest's contract writes the documents it wrote before", () => {
  // The court partition is the contract's addition, and nothing else is: a
  // decision of a base group carries no partition key at all, so its NDJSON
  // bytes are unchanged.
  for (const manifest of [
    CORPUS_INDEX_MANIFESTS.case_law_v5,
    CORPUS_INDEX_MANIFESTS.case_law_v7,
  ]) {
    const documents = buildCaseLawProjectionDocuments({
      manifest,
      input: DATED_CASE_LAW_INPUT,
      payload: { text: "Právní věta", ast: null },
      revision: REVISION,
    });
    for (const document of documents) {
      expect("court_partition" in document).toBe(false);
    }
  }
});
