import { expect, test } from "bun:test";

import { resolveUsCourt } from "@stll/api-contract/us-courts";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { CaseLawDocumentLanguageUndeclaredError } from "@stll/legal-morphology/corpus-language";
import { corpusTokens } from "@stll/legal-morphology/corpus-tokens";

import { toSafeId } from "@/api/lib/branded-types";
import {
  PROVISION_KEY_MAX_BYTES,
  PROVISION_KEYS_MAX_COUNT,
  PROVISION_KEYS_MAX_SERIALIZED_BYTES,
} from "@/api/lib/case-law/provision-keys";
import {
  PROJECTION_GENERATION_FIELD,
  UNDATED_DECISION_TIMESTAMP,
} from "@/api/lib/legal-search/corpus-index-config";
import {
  corpusIndexGroupConfig,
  corpusIndexGroupContractForJurisdiction,
} from "@/api/lib/legal-search/corpus-index-group-contract";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexDecisionTerms,
  corpusIndexGenerationField,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  buildCaseLawProjection,
  buildCaseLawProjectionDocuments,
  buildCorpusProjectionDocuments,
  buildLegislationV2ProjectionDocuments,
  LEGISLATION_SINGLE_DOCUMENT_MAX_BYTES,
} from "@/api/lib/legal-search/corpus-index-projection-builder";
import type {
  CaseLawProjectionInput,
  LegislationV2ProjectionInput,
} from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import {
  CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES,
  CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES,
  planCorpusProjectionAppendRequests,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
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
  provisionKeys: [],
  rankingSignals: {
    citationAuthorityBucket: 0,
    languageGroupKey: null,
    languageGroupShared: false,
  },
  vacatedFrom: null,
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

test("literal provision indices share surface and stem boundaries without rewriting source text", () => {
  const text = "art. 23¹ p.p.s.a.";
  const ast = {
    version: 1,
    source: SUMMARY_AST.source,
    metadata: SUMMARY_AST.metadata,
    blocks: [
      {
        id: "p-1",
        anchorId: "p-1",
        type: "paragraph",
        plainText: text,
        inlines: [{ type: "text", text }],
      },
    ],
  } satisfies DocumentAst;
  const original = structuredClone(ast);
  expect(corpusTokens(text)).toContain("23¹");

  for (const payload of [
    { text, ast },
    { text, ast: null },
  ]) {
    const documents = buildCaseLawProjectionDocuments({
      manifest: CORPUS_INDEX_MANIFESTS.case_law_v6,
      input: { ...CASE_LAW_INPUT, jurisdiction: "POL", language: "pl" },
      payload,
      revision: REVISION,
    });

    expect(documents).toHaveLength(1);
    expect(documents.at(0)?.text).toBe("art. 23^1 p.p.s.a.");
    const stems = corpusTokens(documents.at(0)?.text_stem ?? "");
    expect(stems.filter((token) => /^\d+$/u.test(token))).toEqual(["23", "1"]);
    expect(stems).toHaveLength(
      corpusTokens(documents.at(0)?.text ?? "").length,
    );
    expect(payload.text).toBe(text);
  }
  expect(ast).toEqual(original);
});

test("a language with no stemmer writes no stem field at all", () => {
  const documents = buildCaseLawProjectionDocuments({
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v6,
    input: {
      ...CASE_LAW_INPUT,
      // Snowball ships no Bulgarian algorithm, so a Bulgarian judgment of the
      // European index goes unstemmed.
      jurisdiction: "eu",
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

test("a language its jurisdiction does not declare is refused, not indexed unreachable", () => {
  // The read side asks a Czech index for Czech and English stems only, so
  // German stems written there would be stems no query asks for.
  expect(() =>
    openingTextStem("cze", "de", "Die Verträge waren nichtig."),
  ).toThrow("Case-law document of CZE in an undeclared language: de");
  // A decision with no recorded language declares none either.
  for (const language of ["", "und"]) {
    expect(() => openingTextStem("svk", language, "Zmluva.")).toThrow(
      `Case-law document of SVK in an undeclared language: ${language}`,
    );
  }
  // An undeclared jurisdiction has no index group to be routed to at all.
  expect(() => openingTextStem("xxx", "cs", "Smlouva.")).toThrow(
    "Undeclared case-law index group: xxx",
  );
  // Declared, with or without a stemmer, including a Slovak decision written
  // in Czech before 1993.
  expect(openingTextStem("eu", "mt", "Il-kuntratt.")).toBeUndefined();
  expect(openingTextStem("gbr", "en", "The contracts were void.")).toBe(
    "the contract were void",
  );
  expect(openingTextStem("svk", "cs", "Smlouvy byly neplatné.")).toBe(
    openingTextStem("cze", "cs", "Smlouvy byly neplatné."),
  );
});

test("the public builder answers an undeclared language as its typed error, for the revision build to block", () => {
  const built = buildCorpusProjectionDocuments({
    family: "case_law",
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v11,
    input: { ...CASE_LAW_INPUT, jurisdiction: "pol", language: "cs" },
    payload: { text: "Umowa jest nieważna.", ast: null },
    revision: REVISION,
  });
  expect(built.isErr()).toBe(true);
  const error = built.isErr() ? built.error : null;
  expect(CaseLawDocumentLanguageUndeclaredError.is(error)).toBe(true);
  expect(error).toMatchObject({ jurisdiction: "POL", language: "cs" });
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

const PROVISION_KEYS = [
  "262/2006 Sb.|par_316",
  "262/2006 Sb.|par_316-odst_2",
  "262/2006 Sb.|par_316-odst_2-pism_a",
];

test("a Czech decision in the building generation carries its provision keys on every passage", () => {
  const manifest = CORPUS_INDEX_MANIFESTS.case_law_v9;
  const documents = buildCaseLawProjectionDocuments({
    manifest,
    input: {
      ...DATED_CASE_LAW_INPUT,
      provisionKeys: PROVISION_KEYS.toReversed(),
    },
    payload: {
      text: `${"first ".repeat(400)}\n\n${"second ".repeat(400)}`,
      ast: null,
    },
    revision: REVISION,
  });
  expect(documents.length).toBeGreaterThan(1);
  // Every passage, not only the opening one: a provision filter is one exact
  // term, and any passage a query reaches has to answer it. Sorted, so the
  // same links write the same bytes.
  expect(documents.map((document) => document.provision_keys)).toEqual(
    documents.map(() => PROVISION_KEYS),
  );
  // Strict mapping: every emitted field is one the group's effective contract
  // maps.
  const mapped = new Set(
    corpusIndexGroupConfig(
      corpusIndexGroupContractForJurisdiction(manifest, "CZE"),
    ).doc_mapping.field_mappings.map(({ name }) => name),
  );
  for (const document of documents) {
    expect(Object.keys(document).filter((key) => !mapped.has(key))).toEqual([]);
  }
});

test("a Czech decision with no recorded link writes no provision keys field", () => {
  const documents = buildCaseLawProjectionDocuments({
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v9,
    input: DATED_CASE_LAW_INPUT,
    payload: { text: "Právní věta", ast: null },
    revision: REVISION,
  });
  expect(documents.length).toBeGreaterThan(0);
  for (const document of documents) {
    expect("provision_keys" in document).toBe(false);
  }
});

test("the serving generations write the documents they wrote before, whatever keys the input holds", () => {
  // The same Czech decision is projected into v8 beside v9; its v8 copy is
  // byte for byte what it was, and no other group ever carries the field.
  for (const manifest of [
    CORPUS_INDEX_MANIFESTS.case_law_v5,
    CORPUS_INDEX_MANIFESTS.case_law_v7,
    CORPUS_INDEX_MANIFESTS.case_law_v8,
  ]) {
    for (const input of [
      DATED_CASE_LAW_INPUT,
      { ...DATED_CASE_LAW_INPUT, jurisdiction: "POL", language: "pl" },
    ]) {
      const documents = buildCaseLawProjectionDocuments({
        manifest,
        input: { ...input, provisionKeys: PROVISION_KEYS },
        payload: { text: "Právní věta", ast: null },
        revision: REVISION,
      });
      const plain = buildCaseLawProjectionDocuments({
        manifest,
        input,
        payload: { text: "Právní věta", ast: null },
        revision: REVISION,
      });
      expect(documents).toEqual(plain);
      for (const document of documents) {
        expect("provision_keys" in document).toBe(false);
        expect(PROJECTION_GENERATION_FIELD in document).toBe(false);
        expect("court_partition" in document).toBe(false);
      }
    }
  }
});

test("a key set at the cap fits a passage and one past it is refused", () => {
  const atCap = Array.from(
    { length: PROVISION_KEYS_MAX_COUNT },
    (_, index) =>
      `${"x".repeat(PROVISION_KEY_MAX_BYTES - 2 - 8)}${String(index).padStart(8, "0")}`,
  );
  const [document] = buildCaseLawProjectionDocuments({
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v9,
    input: { ...DATED_CASE_LAW_INPUT, provisionKeys: atCap },
    payload: { text: "Právní věta", ast: null },
    revision: REVISION,
  });
  expect(document?.provision_keys).toHaveLength(PROVISION_KEYS_MAX_COUNT);
  // The field as the projection sends it fits the budget the cap is derived
  // from, and that budget is a small part of the single-document ceiling a
  // request is split against.
  expect(
    Buffer.byteLength(JSON.stringify(document?.provision_keys), "utf-8"),
  ).toBeLessThanOrEqual(PROVISION_KEYS_MAX_SERIALIZED_BYTES);
  expect(PROVISION_KEYS_MAX_SERIALIZED_BYTES).toBeLessThanOrEqual(
    CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES / 8,
  );
  expect(Buffer.byteLength(JSON.stringify(document), "utf-8") + 1).toBeLessThan(
    CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES / 8,
  );
  expect(() =>
    buildCaseLawProjectionDocuments({
      manifest: CORPUS_INDEX_MANIFESTS.case_law_v9,
      input: {
        ...DATED_CASE_LAW_INPUT,
        provisionKeys: [...atCap, "one past the cap"],
      },
      payload: { text: "Právní věta", ast: null },
      revision: REVISION,
    }),
  ).toThrow("Provision keys exceed");
});

test("every passage carries its generation origin exactly when its mapping supports it", () => {
  for (const manifest of Object.values(CORPUS_INDEX_MANIFESTS)) {
    if (manifest.family !== "case_law") {
      continue;
    }
    const documents = buildCaseLawProjectionDocuments({
      manifest,
      input: DATED_CASE_LAW_INPUT,
      payload: {
        text: `${"first ".repeat(400)}\n\n${"second ".repeat(400)}`,
        ast: null,
      },
      revision: REVISION,
    });
    expect(documents.length).toBeGreaterThan(1);
    const field = corpusIndexGenerationField(manifest);
    for (const document of documents) {
      expect(PROJECTION_GENERATION_FIELD in document).toBe(field !== null);
      if (field !== null) {
        expect(document[field]).toBe(manifest.generation);
      }
    }
  }
});

const RANKED_CASE_LAW_INPUT = {
  ...DATED_CASE_LAW_INPUT,
  jurisdiction: "svk",
  courtId: "sk-court-7",
  rankingSignals: {
    citationAuthorityBucket: 17,
    languageGroupKey: "ECLI:SK:NSSR:2008:1",
    languageGroupShared: true,
  },
} as const satisfies CaseLawProjectionInput;

const TWO_PASSAGES = {
  text: `${"first ".repeat(400)}\n\n${"second ".repeat(400)}`,
  ast: null,
};

test("case_law_v10 writes the ranking signals on every passage, and its mapping holds each one", () => {
  const manifest = CORPUS_INDEX_MANIFESTS.case_law_v10;
  const documents = buildCaseLawProjectionDocuments({
    manifest,
    input: RANKED_CASE_LAW_INPUT,
    payload: TWO_PASSAGES,
    revision: REVISION,
  });
  expect(documents.length).toBeGreaterThan(1);
  // Every passage, not only the opening one: the scan ranks a decision by the
  // passage it reached, and reads that passage's fields alone.
  for (const document of documents) {
    expect(document).toMatchObject({
      court: RANKED_CASE_LAW_INPUT.court,
      jurisdiction: "SVK",
      citation_authority_bucket: 17,
      court_id: "sk-court-7",
      language_group_key: "ECLI:SK:NSSR:2008:1",
      language_group_shared: true,
      passage_count: documents.length,
    });
  }
  // Strict mapping: every emitted field is one the generation maps.
  const mapped = manifestFields("case_law_v10");
  for (const document of documents) {
    expect(Object.keys(document).filter((key) => !mapped.has(key))).toEqual([]);
  }
});

test("case_law_v10 writes no field for an absent court id or language group", () => {
  const [document, ...rest] = buildCaseLawProjectionDocuments({
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v10,
    input: DATED_CASE_LAW_INPUT,
    payload: { text: "Právní věta", ast: null },
    revision: REVISION,
  });
  expect(rest).toEqual([]);
  expect(document).toMatchObject({
    citation_authority_bucket: 0,
    language_group_shared: false,
    passage_count: 1,
  });
  expect(document !== undefined && "court_id" in document).toBe(false);
  expect(document !== undefined && "language_group_key" in document).toBe(
    false,
  );
});

test("a generation without ranking signals writes the documents it wrote before", () => {
  for (const generation of [
    "case_law_v5",
    "case_law_v6",
    "case_law_v7",
    "case_law_v8",
    "case_law_v9",
  ] as const) {
    const manifest = CORPUS_INDEX_MANIFESTS[generation];
    const signalled = buildCaseLawProjectionDocuments({
      manifest,
      input: RANKED_CASE_LAW_INPUT,
      payload: TWO_PASSAGES,
      revision: REVISION,
    });
    const unsignalled = buildCaseLawProjectionDocuments({
      manifest,
      input: {
        ...RANKED_CASE_LAW_INPUT,
        rankingSignals: CASE_LAW_INPUT.rankingSignals,
      },
      payload: TWO_PASSAGES,
      revision: REVISION,
    });
    // The fixture reaches the fault: v10 writes these signals.
    expect(signalled.length).toBeGreaterThan(1);
    expect([generation, signalled]).toEqual([generation, unsignalled]);
    for (const document of signalled) {
      for (const field of [
        "citation_authority_bucket",
        "court_id",
        "language_group_key",
        "language_group_shared",
        "passage_count",
      ]) {
        expect([generation, field in document]).toEqual([generation, false]);
      }
    }
  }
});

const DECISION_TERMS_TEXT = [
  "Nejvyšší soud zamítl dovolání žalobce ve věci náhrady škody.",
  "Jednatel společnosti porušil povinnost loajality a odklonil obchody.",
  "Soudy obou stupňů správně posoudily ušlý zisk i skutečnou škodu.",
]
  .map((sentence) => `${sentence} `.repeat(30))
  .join("\n\n");

/**
 * The language classes a decision can arrive in, with what its terms must be.
 * Written out rather than read from the morphology module: the point is that
 * a language without a stemmer still gets a field.
 */
const DECISION_TERMS_FORM_BY_LANGUAGE = {
  cs: "stems",
  sk: "stems",
  de: "stems",
  bg: "surface",
  hr: "surface",
  lv: "surface",
  mt: "surface",
  sl: "surface",
} as const;

/** A jurisdiction whose documents are declared to be written in `language`. */
const declaringJurisdiction = (language: string): string =>
  language === "sk" || language === "cs" ? "svk" : "eu";

test("v11 writes the decision's terms on the opening passage in every language", () => {
  const mapped = manifestFields("case_law_v11");
  for (const [language, form] of Object.entries(
    DECISION_TERMS_FORM_BY_LANGUAGE,
  )) {
    const { documents, decisionTerms } = buildCaseLawProjection({
      manifest: CORPUS_INDEX_MANIFESTS.case_law_v11,
      input: {
        ...RANKED_CASE_LAW_INPUT,
        jurisdiction: declaringJurisdiction(language),
        language,
      },
      payload: { text: DECISION_TERMS_TEXT, ast: null },
      revision: REVISION,
    });
    // The fixture reaches the boundary: more than one passage.
    expect(documents.length).toBeGreaterThan(1);
    const [opening, ...rest] = documents;
    const terms = opening?.decision_terms;
    expect([language, typeof terms, terms === ""]).toEqual([
      language,
      "string",
      false,
    ]);
    for (const document of rest) {
      expect([language, "decision_terms" in document]).toEqual([
        language,
        false,
      ]);
    }
    for (const document of documents) {
      expect([language, "decision_terms_partial" in document]).toEqual([
        language,
        false,
      ]);
      expect(Object.keys(document).filter((key) => !mapped.has(key))).toEqual(
        [],
      );
    }
    expect([language, decisionTerms]).toEqual([
      language,
      {
        kind: "whole",
        form,
        bytes: Buffer.byteLength(terms ?? "", "utf-8"),
      },
    ]);
    // The whole decision: every passage's stems where there is a stemmer, and
    // its surface tokens, which the field's tokenizer folds, where there is not.
    const expected =
      form === "stems"
        ? documents.map(({ text_stem }) => text_stem ?? "").join(" ")
        : corpusTokens(documents.map(({ text }) => text).join(" ")).join(" ");
    expect([language, terms]).toEqual([language, expected]);
    expect([language, documents.some((d) => "text_stem" in d)]).toEqual([
      language,
      form === "stems",
    ]);
  }
});

test("v11 writes exactly v10's documents plus the decision's terms", () => {
  for (const language of Object.keys(DECISION_TERMS_FORM_BY_LANGUAGE)) {
    const options = {
      input: {
        ...RANKED_CASE_LAW_INPUT,
        jurisdiction: declaringJurisdiction(language),
        language,
      },
      payload: { text: DECISION_TERMS_TEXT, ast: null },
      revision: REVISION,
    };
    const v10 = buildCaseLawProjection({
      ...options,
      manifest: CORPUS_INDEX_MANIFESTS.case_law_v10,
    });
    const v11 = buildCaseLawProjection({
      ...options,
      manifest: CORPUS_INDEX_MANIFESTS.case_law_v11,
    });
    expect(v10.decisionTerms).toEqual({ kind: "not_mapped" });
    expect(
      v11.documents.map(({ decision_terms: _terms, ...document }) => document),
    ).toEqual(v10.documents);
  }
});

test("no generation before v11 writes the decision's terms", () => {
  for (const manifest of Object.values(CORPUS_INDEX_MANIFESTS)) {
    if (
      manifest.family !== "case_law" ||
      corpusIndexDecisionTerms(manifest) !== null
    ) {
      continue;
    }
    const { documents, decisionTerms } = buildCaseLawProjection({
      manifest,
      input: RANKED_CASE_LAW_INPUT,
      payload: { text: DECISION_TERMS_TEXT, ast: null },
      revision: REVISION,
    });
    expect([manifest.generation, decisionTerms]).toEqual([
      manifest.generation,
      { kind: "not_mapped" },
    ]);
    for (const document of documents) {
      expect([
        manifest.generation,
        "decision_terms" in document,
        "decision_terms_partial" in document,
      ]).toEqual([manifest.generation, false, false]);
    }
  }
});

test("terms past the document ceiling are written as a marked prefix, and every passage keeps its words", () => {
  // Slovene has no stemmer, so the field holds surface tokens and the fixture
  // pays no stemming. About 10.5 MiB of text, past the 9.5 MiB ceiling.
  const paragraph = `${"slovo ".repeat(250)}\n\n`;
  const text = paragraph.repeat(
    Math.ceil(
      (CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES + 1024 * 1024) /
        paragraph.length,
    ),
  );
  const input = {
    ...RANKED_CASE_LAW_INPUT,
    jurisdiction: "eu",
    language: "sl",
  };
  const { documents, decisionTerms } = buildCaseLawProjection({
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v11,
    input,
    payload: { text, ast: null },
    revision: REVISION,
  });
  const whole = corpusTokens(documents.map((d) => d.text).join(" ")).join(" ");
  // The fixture reaches the fault: the whole terms alone exceed the ceiling.
  expect(Buffer.byteLength(whole, "utf-8")).toBeGreaterThan(
    CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES,
  );
  const [opening, ...rest] = documents;
  const prefix = opening?.decision_terms ?? "";
  expect(decisionTerms).toEqual({
    kind: "prefix",
    form: "surface",
    bytes: Buffer.byteLength(whole, "utf-8"),
    writtenBytes: Buffer.byteLength(prefix, "utf-8"),
    ceiling: "document",
  });
  expect(opening?.decision_terms_partial).toBe(true);
  // A prefix cut at a term boundary, as long as the ceiling allows.
  expect(prefix.length).toBeGreaterThan(0);
  expect(whole.startsWith(prefix)).toBe(true);
  expect(whole.at(prefix.length)).toBe(" ");
  const openingBytes = Buffer.byteLength(JSON.stringify(opening), "utf-8");
  expect(openingBytes).toBeLessThanOrEqual(
    CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES,
  );
  expect(openingBytes + Buffer.byteLength(" slovo", "utf-8")).toBeGreaterThan(
    CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES,
  );
  for (const document of rest) {
    expect("decision_terms" in document).toBe(false);
    expect("decision_terms_partial" in document).toBe(false);
  }
  // The append planner, the gate every writer passes, takes the revision.
  expect(
    planCorpusProjectionAppendRequests([
      { revision: REVISION, documents },
    ]).isOk(),
  ).toBe(true);
  // Nothing is lost from the passages: they still hold every word.
  expect(corpusTokens(documents.map((d) => d.text).join(" ")).length).toBe(
    corpusTokens(text).length,
  );
  // The public builder answers the same documents.
  const built = buildCorpusProjectionDocuments({
    family: "case_law",
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v11,
    input,
    payload: { text, ast: null },
    revision: REVISION,
  });
  expect(built.isOk() ? built.value.length : -1).toBe(documents.length);
});

test("the comparison twin writes v11's documents, marked with their generation", () => {
  const options = {
    input: { ...RANKED_CASE_LAW_INPUT, jurisdiction: "cze", language: "cs" },
    payload: { text: DECISION_TERMS_TEXT, ast: null },
    revision: REVISION,
  };
  const v11 = buildCaseLawProjection({
    ...options,
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v11,
  });
  const v12 = buildCaseLawProjection({
    ...options,
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v12,
  });
  expect(v12.decisionTerms).toEqual(v11.decisionTerms);
  expect(v12.documents).toEqual(
    v11.documents.map((document) => ({
      ...document,
      [PROJECTION_GENERATION_FIELD]: "case_law_v12",
    })),
  );
});

test("an opening passage over the ceiling on its own is refused as too large, not a panic", () => {
  // One block the chunker keeps whole, past the 9.5 MiB document ceiling.
  const text = "slovo ".repeat(
    Math.ceil(
      (CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES + 512 * 1024) / 6,
    ),
  );
  const options = {
    family: "case_law",
    input: { ...RANKED_CASE_LAW_INPUT, jurisdiction: "eu", language: "sl" },
    payload: { text, ast: null },
    revision: REVISION,
  } as const;
  // The fixture reaches the boundary: v10 builds one opening passage that is
  // already over the ceiling, which only the append planner would refuse.
  const [v10Opening] = buildCaseLawProjectionDocuments({
    ...options,
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v10,
  });
  expect(
    Buffer.byteLength(JSON.stringify(v10Opening), "utf-8"),
  ).toBeGreaterThan(CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES);
  const { documents, decisionTerms } = buildCaseLawProjection({
    ...options,
    manifest: CORPUS_INDEX_MANIFESTS.case_law_v11,
  });
  expect(decisionTerms.kind).toBe("opening_over_ceiling");
  expect(documents.some((d) => "decision_terms" in d)).toBe(false);
  // The append planner refuses it the way it refuses v10's, which blocks the
  // revision alone.
  const planned = planCorpusProjectionAppendRequests([
    { revision: REVISION, documents },
  ]);
  expect(planned.isErr() ? planned.error.code : "ok").toBe(
    "revision_too_large",
  );
});
