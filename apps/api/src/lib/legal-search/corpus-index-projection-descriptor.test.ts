import { expect, test } from "bun:test";

import {
  CORPUS_INDEX_MANIFESTS,
  type CorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  caseLawProjectionTitle,
  deriveCorpusIndexProjectionDescriptor,
  type CaseLawProjectionInput,
  type LegislationV2ProjectionInput,
} from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/lib/legal-search/corpus-storage";
import { SNOWBALL_RELEASE } from "@/api/lib/legal-search/morphology/snowball/base-stemmer";
import {
  MORPHOLOGY_LANGUAGES,
  MORPHOLOGY_VERSION,
} from "@/api/lib/legal-search/morphology/stem";

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
  metadata: null,
} as const satisfies CaseLawProjectionInput;

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
  expect(caseLawProjectionTitle(CASE_LAW_INPUT)).toBe(
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

test("redaction, missing or empty payload, and redistribution revocation erase", () => {
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
  for (const contentHash of EMPTY_CORPUS_CONTENT_HASHES) {
    expect(
      deriveCorpusIndexProjectionDescriptor(
        CORPUS_INDEX_MANIFESTS.case_law_v5,
        { ...CASE_LAW_INPUT, contentHash },
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

const fingerprintOf = (
  manifest: CorpusIndexManifest,
  input: CaseLawProjectionInput,
): string | null => {
  const descriptor = deriveCorpusIndexProjectionDescriptor(manifest, input);
  return descriptor.action === "upsert" ? descriptor.fingerprint : null;
};

test("only a generation that indexes the summary fingerprints it", () => {
  const withSummary = {
    ...CASE_LAW_INPUT,
    metadata: { legalSentence: "Právní věta" },
  };

  // v5 never writes the field, so a publisher editing the summary must not
  // re-project the generation currently serving.
  expect(
    deriveCorpusIndexProjectionDescriptor(
      CORPUS_INDEX_MANIFESTS.case_law_v5,
      withSummary,
    ),
  ).toEqual(
    deriveCorpusIndexProjectionDescriptor(
      CORPUS_INDEX_MANIFESTS.case_law_v5,
      CASE_LAW_INPUT,
    ),
  );
  expect(
    deriveCorpusIndexProjectionDescriptor(
      CORPUS_INDEX_MANIFESTS.case_law_v6,
      withSummary,
    ),
  ).not.toEqual(
    deriveCorpusIndexProjectionDescriptor(
      CORPUS_INDEX_MANIFESTS.case_law_v6,
      CASE_LAW_INPUT,
    ),
  );
  // A metadata key no source of the summary names changes nothing anywhere.
  expect(
    deriveCorpusIndexProjectionDescriptor(CORPUS_INDEX_MANIFESTS.case_law_v6, {
      ...CASE_LAW_INPUT,
      metadata: { unrelated: "bookkeeping" },
    }),
  ).toEqual(
    deriveCorpusIndexProjectionDescriptor(
      CORPUS_INDEX_MANIFESTS.case_law_v6,
      CASE_LAW_INPUT,
    ),
  );
});

/**
 * The projection census. A fingerprint moving re-projects every document it
 * covers, so these change only when the manifest digest or what the generation
 * writes changes, and then deliberately. Extend the map with a new generation;
 * edit an entry only for a generation nothing has built, never to make a test
 * pass.
 */
const EXPECTED_FINGERPRINTS = {
  case_law_v5:
    "67b6e403467118f9e7369c10b8f2de9d76d3297033926efb81b2cc47945d7acf",
  case_law_v6:
    "f52ff99433302ac499667cf09c3745046db4a5451bb5c46e218eb8bc8d8376f1",
  case_law_v7:
    "d3ef561a8db3feab3ff67a726b743840d1c1224baedc9e5dc1777c462f9f5fd9",
} as const;

test("v7 fingerprints the sentence and the classification apart", () => {
  const tagged = {
    ...CASE_LAW_INPUT,
    metadata: { legalArea: "Daně" },
  } as const satisfies CaseLawProjectionInput;
  const written = {
    ...CASE_LAW_INPUT,
    metadata: { legalSentence: "Daně" },
  } as const satisfies CaseLawProjectionInput;

  // v6 reads both through one field, so the two decisions project the same
  // way: the tag is written where the sentence would have been.
  expect(fingerprintOf(CORPUS_INDEX_MANIFESTS.case_law_v6, tagged)).toBe(
    fingerprintOf(CORPUS_INDEX_MANIFESTS.case_law_v6, written),
  );
  // v7 writes them to different fields, so they are different projections and
  // a fingerprint that could not tell them apart would leave one of them
  // holding the other's document.
  expect(fingerprintOf(CORPUS_INDEX_MANIFESTS.case_law_v7, tagged)).not.toBe(
    fingerprintOf(CORPUS_INDEX_MANIFESTS.case_law_v7, written),
  );
  // Both readings are covered, so editing either re-projects.
  for (const input of [tagged, written]) {
    expect(fingerprintOf(CORPUS_INDEX_MANIFESTS.case_law_v7, input)).not.toBe(
      fingerprintOf(CORPUS_INDEX_MANIFESTS.case_law_v7, CASE_LAW_INPUT),
    );
  }
});

test("only a generation that writes stem fields fingerprints the stemmer set", () => {
  // Stems are content: the manifest digest pins the fields, not the algorithms
  // filling them, so a new language or a Snowball upgrade has to move v6's
  // fingerprint and re-project, and has to leave v5 — which writes no stem
  // field — exactly where it is.
  expect(
    fingerprintOf(CORPUS_INDEX_MANIFESTS.case_law_v5, CASE_LAW_INPUT),
  ).toBe(EXPECTED_FINGERPRINTS.case_law_v5);
  expect(
    fingerprintOf(CORPUS_INDEX_MANIFESTS.case_law_v6, CASE_LAW_INPUT),
  ).toBe(EXPECTED_FINGERPRINTS.case_law_v6);
  expect(
    fingerprintOf(CORPUS_INDEX_MANIFESTS.case_law_v7, CASE_LAW_INPUT),
  ).toBe(EXPECTED_FINGERPRINTS.case_law_v7);
  // Why the v6 pin moves: the version names the release and every language the
  // module dispatches, so either kind of change reaches the fingerprint.
  expect(MORPHOLOGY_VERSION).toContain(SNOWBALL_RELEASE);
  for (const language of MORPHOLOGY_LANGUAGES) {
    expect(MORPHOLOGY_VERSION).toContain(language);
  }
});
