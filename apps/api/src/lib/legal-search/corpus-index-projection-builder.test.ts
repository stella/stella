import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { UNDATED_DECISION_TIMESTAMP } from "@/api/lib/legal-search/corpus-index-config";
import { CORPUS_INDEX_MANIFESTS } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  buildCaseLawV5ProjectionDocuments,
  buildCorpusProjectionDocuments,
  buildLegislationV2ProjectionDocuments,
} from "@/api/lib/legal-search/corpus-index-projection-builder";
import type {
  CaseLawV5ProjectionInput,
  LegislationV2ProjectionInput,
} from "@/api/lib/legal-search/corpus-index-projection-descriptor";

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
} as const satisfies CaseLawV5ProjectionInput;
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

const manifestFields = (family: "case_law" | "legislation"): Set<string> =>
  new Set(
    CORPUS_INDEX_MANIFESTS[
      family === "case_law" ? "case_law_v5" : "legislation_v2"
    ].engine.indexConfig.doc_mapping.field_mappings.map(({ name }) => name),
  );

test("case-law v5 emits exact attempt identity and one opening passage", () => {
  const documents = buildCaseLawV5ProjectionDocuments({
    input: CASE_LAW_INPUT,
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
    decision_date_ts: UNDATED_DECISION_TIMESTAMP,
  });
  for (const [index, document] of documents.entries()) {
    expect(document.projection_revision).toBe(REVISION);
    expect("title" in document).toBe(index === 0);
    expect(
      Object.keys(document).every((key) => manifestFields("case_law").has(key)),
    ).toBe(true);
  }
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
      manifestFields("legislation").has(key),
    ),
  ).toBe(true);
});

test("builder dispatch is exhaustive over manifest-owned versions", () => {
  expect(
    buildCorpusProjectionDocuments({
      manifest: CORPUS_INDEX_MANIFESTS.case_law_v5,
      input: CASE_LAW_INPUT,
      payload: { text: "Rozsudek", ast: null },
      revision: REVISION,
    }),
  ).toHaveLength(1);
  expect(
    buildCorpusProjectionDocuments({
      manifest: CORPUS_INDEX_MANIFESTS.legislation_v2,
      input: LEGISLATION_INPUT,
      payload: { text: "Zákon", ast: null },
      revision: REVISION,
    }),
  ).toHaveLength(1);
});
