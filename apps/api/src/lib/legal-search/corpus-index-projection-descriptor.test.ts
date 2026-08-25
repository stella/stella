import { expect, test } from "bun:test";

import { CORPUS_INDEX_MANIFESTS } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  caseLawV5Title,
  deriveCorpusIndexProjectionDescriptor,
  type CaseLawV5ProjectionInput,
  type LegislationV2ProjectionInput,
} from "@/api/lib/legal-search/corpus-index-projection-descriptor";

const CASE_LAW_INPUT = {
  family: "case_law",
  documentId: "0198e331-e578-7000-8000-000000000001",
  sourceId: "0198e331-e578-7000-8000-000000000002",
  jurisdiction: "CZE",
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
  decisionDate: "2008-02-27",
  ecli: null,
} as const satisfies CaseLawV5ProjectionInput;

const LEGISLATION_INPUT = {
  family: "legislation",
  documentId: "0198e331-e578-7000-8000-000000000003",
  sourceId: "0198e331-e578-7000-8000-000000000004",
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

test("case-law title and fingerprint canonicalize identifier order", () => {
  expect(caseLawV5Title(CASE_LAW_INPUT)).toBe(
    "4 As 3/2008 · NSS-4-AS-3-2008 — Nejvyšší správní soud",
  );
  const first = deriveCorpusIndexProjectionDescriptor(
    CORPUS_INDEX_MANIFESTS.case_law_v5,
    CASE_LAW_INPUT,
  );
  const second = deriveCorpusIndexProjectionDescriptor(
    CORPUS_INDEX_MANIFESTS.case_law_v5,
    { ...CASE_LAW_INPUT, identifiers: CASE_LAW_INPUT.identifiers.toReversed() },
  );
  expect(first).toEqual(second);
  expect(first).toMatchObject({
    action: "upsert",
    indexId: "case_law_v5_cs_sk",
  });
  expect(first.action === "upsert" ? first.fingerprint : "").toMatch(
    /^[0-9a-f]{64}$/u,
  );
});

test("every projected metadata change invalidates the input fingerprint", () => {
  const first = deriveCorpusIndexProjectionDescriptor(
    CORPUS_INDEX_MANIFESTS.case_law_v5,
    CASE_LAW_INPUT,
  );
  const changed = deriveCorpusIndexProjectionDescriptor(
    CORPUS_INDEX_MANIFESTS.case_law_v5,
    { ...CASE_LAW_INPUT, court: "Ústavní soud" },
  );
  expect(changed).not.toEqual(first);
});

test("redaction, missing payload, and redistribution revocation erase", () => {
  for (const input of [
    { ...CASE_LAW_INPUT, redacted: true },
    { ...CASE_LAW_INPUT, contentHash: null },
    { ...CASE_LAW_INPUT, redistributionEligible: false },
  ]) {
    expect(
      deriveCorpusIndexProjectionDescriptor(
        CORPUS_INDEX_MANIFESTS.case_law_v5,
        input,
      ),
    ).toEqual({ action: "erase" });
  }
});

test("legislation uses the open jurisdiction route and exact metadata", () => {
  const first = deriveCorpusIndexProjectionDescriptor(
    CORPUS_INDEX_MANIFESTS.legislation_v2,
    LEGISLATION_INPUT,
  );
  expect(first).toMatchObject({
    action: "upsert",
    indexId: "legislation_v2_cze",
  });
  expect(
    deriveCorpusIndexProjectionDescriptor(
      CORPUS_INDEX_MANIFESTS.legislation_v2,
      { ...LEGISLATION_INPUT, status: "repealed" },
    ),
  ).not.toEqual(first);
});

test("manifest and projection families cannot be crossed", () => {
  expect(() =>
    deriveCorpusIndexProjectionDescriptor(
      CORPUS_INDEX_MANIFESTS.legislation_v2,
      CASE_LAW_INPUT,
    ),
  ).toThrow("Corpus projection family mismatch");
});
