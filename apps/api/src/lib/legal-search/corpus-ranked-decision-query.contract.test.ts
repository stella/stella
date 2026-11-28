import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { stemLegalTerm } from "@stll/legal-morphology/stem";

import { envBase } from "@/api/env-base";
import { toSafeId } from "@/api/lib/branded-types";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexConfigFromManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { buildCaseLawProjectionDocuments } from "@/api/lib/legal-search/corpus-index-projection-builder";
import type { CaseLawProjectionInput } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import {
  type DecisionRankingArm,
  rankedDecisionQuery,
  type RankedDecisionWord,
} from "@/api/lib/legal-search/corpus-ranked-decision-query";

/**
 * The ranked decision query against the pinned engine.
 *
 * Each decision here is one passage, so its stem field holds the stems of the
 * whole decision: the shape the decision-level field gives every decision on
 * its opening passage. That is enough to prove what the ranking relies on the
 * engine for: `minimum_should_match` over one clause per word, scope in
 * `filter` changing no score, and the long-question case a passage-level AND
 * misses, a decision holding ten of eleven words.
 *
 * Opt-in, like every engine suite: STELLA_RUN_CORPUS_ENGINE_TESTS=true with
 * the q09 compose engine serving.
 */
const runEngineTests = process.env["STELLA_RUN_CORPUS_ENGINE_TESTS"] === "true";

const MANIFEST = CORPUS_INDEX_MANIFESTS.case_law_v10;
const INDEX_ID = `case_law_ranked_contract_${Bun.randomUUIDv7().replaceAll("-", "").slice(-12)}`;
const ENGINE_TIMEOUT_MS = 120_000;
const REVISION = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-0000000000a1",
);
const SOURCE_ID = "0198e331-e578-7000-8000-0000000000a2";
const STEM_FIELD = "text_stem";

/** The long question a lawyer typed, as its eleven content words. */
const QUESTION = [
  "odklonil",
  "obchody",
  "jiné",
  "společnosti",
  "člen",
  "statutárního",
  "orgánu",
  "loajalita",
  "škoda",
  "ušlý",
  "zisk",
] as const;

const id = (serial: number) =>
  `0198e331-e578-7000-8000-${String(serial).padStart(12, "0")}`;

/** Ten of the eleven words, spread over separate sentences. */
const TEN_OF_ELEVEN = id(1);
/** Two of the words. */
const TWO_WORDS = id(2);
/** Every word, but in another jurisdiction: scope must drop it. */
const OTHER_JURISDICTION = id(3);
/** Six of the words. */
const SIX_WORDS = id(4);

const DECISIONS = [
  {
    documentId: TEN_OF_ELEVEN,
    jurisdiction: "CZE",
    text: [
      "Člen statutárního orgánu porušil povinnost loajality.",
      "Uzavíral obchody pro jiné společnosti, které ovládal.",
      "Společnosti tím vznikla škoda a ušlý zisk.",
      "Loajalita vůči společnosti je základní povinností.",
    ].join(" "),
  },
  {
    documentId: TWO_WORDS,
    jurisdiction: "CZE",
    text: "Náhrada škoda a ušlé mzdy zaměstnance.",
  },
  {
    documentId: OTHER_JURISDICTION,
    // A Czech judgment of the European index: the same stems, another scope.
    jurisdiction: "EU",
    text: QUESTION.join(" "),
  },
  {
    documentId: SIX_WORDS,
    jurisdiction: "CZE",
    text: "Člen orgánu uzavřel obchody pro jiné společnosti a způsobil škoda.",
  },
] as const;

const documentsOf = ({
  documentId,
  jurisdiction,
  text,
}: (typeof DECISIONS)[number]) => {
  const input = {
    family: "case_law",
    documentId,
    sourceId: SOURCE_ID,
    jurisdiction,
    language: "cs",
    documentType: null,
    contentHash: null,
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
    caseNumber: "",
    identifiers: [],
    court: "",
    courtId: null,
    decisionDate: null,
    ecli: null,
    metadata: null,
  } satisfies CaseLawProjectionInput;
  return buildCaseLawProjectionDocuments({
    manifest: MANIFEST,
    input,
    payload: { text, ast: null },
    revision: REVISION,
  });
};

const WORDS: RankedDecisionWord[] = QUESTION.map((word) => ({
  decisionLeaves: [`${STEM_FIELD}:"${stemLegalTerm(word, "cs")}"`],
  boostedLeaves: [],
}));

const client = getCorpusIndexClient("q09");

const rank = async (arm: DecisionRankingArm, scope: string) => {
  const result = await client.scoredSearch({
    observer: "unobserved",
    indexId: INDEX_ID,
    query: {
      type: "dsl",
      query: rankedDecisionQuery({ scope, words: WORDS, arm, boost: 2 }),
    },
    from: 0,
    size: 10,
    fields: ["document_id"],
    requiredFields: ["document_id"],
  });
  if (result.isErr()) {
    throw result.error;
  }
  return result.value.hits.map((hit) => ({
    id: hit.fields["document_id"],
    score: hit.score,
  }));
};

const CZECH = 'jurisdiction:"CZE"';

describe.skipIf(!runEngineTests)(
  "the ranked decision query against the pinned engine",
  () => {
    // timeout: creates the index and waits for its one forced commit.
    beforeAll(async () => {
      const created = await client.createIndex(
        corpusIndexConfigFromManifest(MANIFEST, INDEX_ID),
        "unobserved",
      );
      if (created.isErr()) {
        throw created.error;
      }
      const documents = DECISIONS.flatMap(documentsOf);
      // One passage each: the stem field then holds the whole decision.
      expect(documents).toHaveLength(DECISIONS.length);
      const response = await fetch(
        `${String(envBase.CORPUS_INDEX_Q09_ENDPOINT ?? envBase.CORPUS_INDEX_Q09_SEARCH_ENDPOINT)}/api/v1/${INDEX_ID}/ingest?commit=force`,
        {
          method: "POST",
          headers: { "content-type": "application/x-ndjson" },
          body: `${documents.map((document) => JSON.stringify(document)).join("\n")}\n`,
        },
      );
      if (!response.ok) {
        throw new Error(`ingest ${String(response.status)}`);
      }
    }, ENGINE_TIMEOUT_MS);

    // timeout: deletes the index the engine holds.
    afterAll(async () => {
      const deleted = await client.deleteIndex(INDEX_ID, "unobserved");
      if (deleted.isErr()) {
        throw deleted.error;
      }
    }, ENGINE_TIMEOUT_MS);

    // timeout: three real engine searches.
    test(
      "a decision holding ten of eleven words is found first, where every word is required nothing is",
      async () => {
        // The passage-level AND's answer to the long question: nothing.
        expect(await rank("all", CZECH)).toEqual([]);

        const any = await rank("any", CZECH);
        expect(any.map(({ id: hit }) => hit)).toEqual([
          TEN_OF_ELEVEN,
          SIX_WORDS,
          TWO_WORDS,
        ]);
        // At least half the words (six) keeps the two that hold enough.
        expect((await rank("half", CZECH)).map(({ id: hit }) => hit)).toEqual([
          TEN_OF_ELEVEN,
          SIX_WORDS,
        ]);
      },
      ENGINE_TIMEOUT_MS,
    );

    // timeout: two real engine searches.
    test(
      "scope filters without adding to any score",
      async () => {
        const scoped = await rank("any", CZECH);
        const unscoped = await rank("any", "*");
        // The decision in another jurisdiction holds every word: in scope it
        // would lead, and scope removes it.
        expect(unscoped.at(0)?.id).toBe(OTHER_JURISDICTION);
        expect(scoped.map(({ id: hit }) => hit)).not.toContain(
          OTHER_JURISDICTION,
        );
        // A scope clause in the query string would add its own idf to every
        // score; in `filter` the scores are the unscoped ones.
        for (const hit of scoped) {
          expect(hit.score).toBeCloseTo(
            unscoped.find(({ id: other }) => other === hit.id)?.score ??
              Number.NaN,
            6,
          );
        }
      },
      ENGINE_TIMEOUT_MS,
    );
  },
);
