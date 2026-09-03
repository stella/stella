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
 * covers, so these change only when what the generation writes changes, and
 * then deliberately. Extend the map with a new generation; never edit an entry
 * to make a test pass.
 */
const EXPECTED_FINGERPRINTS = {
  case_law_v5:
    "67b6e403467118f9e7369c10b8f2de9d76d3297033926efb81b2cc47945d7acf",
  case_law_v6:
    "f52ff99433302ac499667cf09c3745046db4a5451bb5c46e218eb8bc8d8376f1",
} as const;

test("only a generation that writes stem fields fingerprints the stemmer set", () => {
  // Stems are content: the manifest digest pins the fields, not the algorithms
  // filling them, so a new language or a Snowball upgrade has to move v6's
  // fingerprint and re-project, and has to leave v5 — which writes no stem
  // field — exactly where it is.
  const fingerprintOf = (manifest: CorpusIndexManifest) => {
    const descriptor = deriveCorpusIndexProjectionDescriptor(
      manifest,
      CASE_LAW_INPUT,
    );
    return descriptor.action === "upsert" ? descriptor.fingerprint : null;
  };

  expect(fingerprintOf(CORPUS_INDEX_MANIFESTS.case_law_v5)).toBe(
    EXPECTED_FINGERPRINTS.case_law_v5,
  );
  expect(fingerprintOf(CORPUS_INDEX_MANIFESTS.case_law_v6)).toBe(
    EXPECTED_FINGERPRINTS.case_law_v6,
  );
  // Why the v6 pin moves: the version names the release and every language the
  // module dispatches, so either kind of change reaches the fingerprint.
  expect(MORPHOLOGY_VERSION).toContain(SNOWBALL_RELEASE);
  for (const language of MORPHOLOGY_LANGUAGES) {
    expect(MORPHOLOGY_VERSION).toContain(language);
  }
});
