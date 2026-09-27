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
import {
  GLOBAL_MORPHOLOGY_KEY,
  MORPHOLOGY_LANGUAGES,
  MORPHOLOGY_REVISIONS,
  morphologyKey,
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
  listingOnly: false,
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

test("redaction, a listing-only row, missing or empty payload, and redistribution revocation erase", () => {
  for (const input of [
    { ...CASE_LAW_INPUT, redacted: true },
    // The row was listed and never served: durable, and never projected. It
    // is erased even carrying a body, which a partial refresh can give it
    // while the marker still stands.
    { ...CASE_LAW_INPUT, listingOnly: true },
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
});

/**
 * Fingerprints computed before stemmer revisions became per language, when
 * every document of a stem-writing generation carried one global key. A
 * document whose language has not changed since must keep its fingerprint
 * byte for byte, or it re-projects for a change to another language's
 * stemmer.
 */
const GLOBAL_KEY_FINGERPRINTS = [
  {
    generation: "case_law_v6",
    jurisdiction: "CZE",
    language: "cs",
    fingerprint:
      "5540500bcbe8acfbe983d4841afa81d92bab4e2bbcddd2c7bd025073518bad59",
  },
  {
    generation: "case_law_v7",
    jurisdiction: "CZE",
    language: "cs",
    fingerprint:
      "60363da479c398457526c95b5c1230c984664349b0419fee5b577e78f61b4dbd",
  },
  {
    generation: "case_law_v6",
    jurisdiction: "POL",
    language: "pl",
    fingerprint:
      "a8208e052c40cfcaa1012ab094e8a3addd53e986dd28fa9cf8f98ff2296a842d",
  },
  {
    generation: "case_law_v7",
    jurisdiction: "POL",
    language: "pl",
    fingerprint:
      "1ddd23f9d182101bf056ce28b357460183710f1e47a4d25ca7e4516aca479192",
  },
  {
    generation: "case_law_v6",
    jurisdiction: "EU",
    language: "fr",
    fingerprint:
      "974a1fd4030519dc1b8c501c6f84628340c376e0e4f658bfb91b35e5c249bbd1",
  },
  {
    generation: "case_law_v7",
    jurisdiction: "EU",
    language: "fr",
    fingerprint:
      "75ebedd1b3de4d3f1a85d32884ca9a118647d9b10fb954d6caddbd44e39f1ba1",
  },
  // Maltese has no stemmer: the document carries the key all the same.
  {
    generation: "case_law_v6",
    jurisdiction: "EU",
    language: "mt",
    fingerprint:
      "fa52e3128ac3964f34fc7eeff5ceb8ed1cdd345e89d49a024eb405584107d701",
  },
  {
    generation: "case_law_v7",
    jurisdiction: "EU",
    language: "mt",
    fingerprint:
      "ab9c475c59b604f50f68b287453b43757cbc7330cb56f2e7aeaa4fc6922b76f7",
  },
  {
    generation: "case_law_v6",
    jurisdiction: "AUT",
    language: "de",
    fingerprint:
      "2674245a7c6c13e83cf4aa98207fa16db9da834aafa3499e4859bccba6fcae41",
  },
  {
    generation: "case_law_v7",
    jurisdiction: "AUT",
    language: "de",
    fingerprint:
      "5fbe7d8e87fd027d3cd5eeee3c2f565d94913c81b81087e3af4304fff535b32b",
  },
  {
    generation: "case_law_v6",
    jurisdiction: "HUN",
    language: "hu",
    fingerprint:
      "df153ea9217857bdba3a66cc97dbc3341f5c16ce626cd615a41be0996b39de35",
  },
  {
    generation: "case_law_v7",
    jurisdiction: "HUN",
    language: "hu",
    fingerprint:
      "379f6a7905b0837b33e0b847ff7c14b2e3126823a181dc503e5773947c86032f",
  },
  {
    generation: "case_law_v6",
    jurisdiction: "SVK",
    language: "sk",
    fingerprint:
      "52e27eb96ebc57c10545481cb6158798b5cf5b1a45fb4326511f4e1c65160186",
  },
  {
    generation: "case_law_v7",
    jurisdiction: "SVK",
    language: "sk",
    fingerprint:
      "25d74ad07d2c8839c35e17fbb92b0f81436d2b2bb2099e314199bf1809dae7a3",
  },
] as const;

test("a stemmer revision re-projects only its own language's documents", () => {
  for (const pin of GLOBAL_KEY_FINGERPRINTS) {
    const current = fingerprintOf(CORPUS_INDEX_MANIFESTS[pin.generation], {
      ...CASE_LAW_INPUT,
      identifiers: [{ type: "docket", value: "4 As 3/2008" }],
      court: "Soud",
      jurisdiction: pin.jurisdiction,
      language: pin.language,
    });
    const label = `${pin.generation} ${pin.jurisdiction} ${pin.language}`;
    // Slovak is at revision 1, so its documents move and nothing else does.
    if (pin.language === "sk") {
      expect(current, label).not.toBe(pin.fingerprint);
    } else {
      expect(current, label).toBe(pin.fingerprint);
    }
  }
});

test("every language still at revision 0 keeps the global key", () => {
  expect(GLOBAL_MORPHOLOGY_KEY).toBe(
    "v3.1.1+cs,da,de,el,en,es,et,fi,fr,ga,hu,it,lt,nl,pl,pt,ro,sk,sv",
  );
  expect(morphologyKey(null)).toBe(GLOBAL_MORPHOLOGY_KEY);
  for (const language of MORPHOLOGY_LANGUAGES) {
    expect(morphologyKey(language) === GLOBAL_MORPHOLOGY_KEY, language).toBe(
      MORPHOLOGY_REVISIONS[language] === 0,
    );
  }
});
