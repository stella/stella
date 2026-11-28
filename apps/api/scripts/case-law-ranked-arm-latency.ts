/**
 * Latency of the ranked decision query on one route, per arm (all words, at
 * least half, any word), first pass and repeated: the flip gate for the
 * decision-level generation.
 *
 * The pinned engine has no score pruning, so the any-word arm scores every
 * decision that holds any word: its cost grows with the postings of every
 * word and is only known by measuring it on real splits. Each query runs
 * once per arm in a rotation (the "first pass") and then `--warm` more times;
 * the report gives p50 and p95 per arm and phase and the engine's hit count,
 * which says how many decisions each arm ranked. The engine's caches are not
 * controlled: a first pass after another arm, or a query repeated in the
 * file, may find postings already read, so a first pass is not a cold read.
 * A cold number needs a run against a searcher whose caches were emptied.
 *
 * Read-only: it sends searches and nothing else. It reads through the same
 * strict ES request the search sends (`allow_partial_search_results=false`),
 * so a failed split fails the measurement instead of shortening it.
 *
 * Usage (from apps/api):
 *   CORPUS_INDEX_Q09_SEARCH_ENDPOINT=http://127.0.0.1:7291 \
 *   bun run bench:case-law-ranked-arms -- --index=case_law_v11_cze \
 *     --language=cs --queries=queries.txt [--field=decision_terms] \
 *     [--scope='is_opening:true'] [--warm=5] [--size=20] [--boost=2] [--json]
 *
 * `queries.txt` holds one query per line, as a lawyer types it.
 */
import { panic } from "better-result";
import { parseArgs } from "node:util";

import { functionWordsFor } from "@stll/legal-morphology/function-words";
import {
  MORPHOLOGY_LANGUAGES,
  type MorphologyLanguage,
  stemLegalTerm,
} from "@stll/legal-morphology/stem";

import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  partitionCorpusFunctionWords,
  tokenizeCorpusFreeText,
} from "@/api/lib/legal-search/corpus-query";
import {
  DECISION_RANKING_ARMS,
  type DecisionRankingArm,
  rankedDecisionQuery,
  type RankedDecisionWord,
} from "@/api/lib/legal-search/corpus-ranked-decision-query";

const { values } = parseArgs({
  options: {
    index: { type: "string" },
    language: { type: "string" },
    queries: { type: "string" },
    field: { type: "string", default: "decision_terms" },
    scope: { type: "string", default: "is_opening:true" },
    keywords: { type: "string", default: "keywords" },
    warm: { type: "string", default: "5" },
    size: { type: "string", default: "20" },
    boost: { type: "string", default: "2" },
    json: { type: "boolean", default: false },
  },
});

const required = (name: string, value: string | undefined): string =>
  value ?? panic(`--${name} is required`);

const isMorphologyLanguage = (value: string): value is MorphologyLanguage =>
  (MORPHOLOGY_LANGUAGES as readonly string[]).includes(value);

const indexId = required("index", values.index);
const languageArg = required("language", values.language);
const language = isMorphologyLanguage(languageArg)
  ? languageArg
  : panic(`--language must be one of ${MORPHOLOGY_LANGUAGES.join(", ")}`);
/** A whole number at least `min`, or the run stops before any search. */
const wholeNumber = (name: string, value: string, min: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min
    ? parsed
    : panic(`--${name} must be a whole number of at least ${String(min)}`);
};

const warmRuns = wholeNumber("warm", values.warm, 0);
const size = wholeNumber("size", values.size, 1);
const boost = Number(values.boost);
if (!Number.isFinite(boost) || boost <= 0) {
  panic("--boost must be a positive number");
}

const quoted = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** One word's leaves: its stem on the decision field, its form on keywords. */
const wordsOf = (query: string): RankedDecisionWord[] => {
  const { required: terms } = partitionCorpusFunctionWords(
    tokenizeCorpusFreeText(query),
    functionWordsFor(language),
  );
  return terms.map((term) => {
    const stems = term.value
      .split(" ")
      .map((word) => stemLegalTerm(word, language))
      .join(" ");
    return {
      decisionLeaves: [`${values.field}:${quoted(stems)}`],
      boostedLeaves: [`${values.keywords}:${quoted(term.value)}`],
    };
  });
};

type Sample = { ms: number; hits: number };

const search = async (
  words: readonly RankedDecisionWord[],
  arm: DecisionRankingArm,
): Promise<Sample> => {
  const startedAt = performance.now();
  // Through the corpus client: the same strict request the search sends,
  // with its failed-split check, so a lost split fails the run.
  const answer = await getCorpusIndexClient("q09").scoredSearch({
    observer: "unobserved",
    indexId,
    query: {
      type: "dsl",
      query: rankedDecisionQuery({ scope: values.scope, words, arm, boost }),
    },
    from: 0,
    size,
    fields: ["document_id"],
    requiredFields: ["document_id"],
  });
  const ms = performance.now() - startedAt;
  if (answer.isErr()) {
    return panic(`${arm} failed`, answer.error);
  }
  const total = answer.value.numHits;
  return { ms, hits: total };
};

const percentile = (sorted: readonly number[], p: number): number =>
  sorted.length === 0
    ? Number.NaN
    : (sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ??
      Number.NaN);

const summary = (samples: readonly Sample[]) => {
  const ms = samples.map((sample) => sample.ms).toSorted((a, b) => a - b);
  const hits = samples.map((sample) => sample.hits).toSorted((a, b) => a - b);
  return {
    runs: samples.length,
    p50Ms: Math.round(percentile(ms, 0.5)),
    p95Ms: Math.round(percentile(ms, 0.95)),
    maxMs: Math.round(ms.at(-1) ?? Number.NaN),
    p50Hits: percentile(hits, 0.5),
  };
};

const queries = (await Bun.file(required("queries", values.queries)).text())
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

const firstPass = new Map<DecisionRankingArm, Sample[]>(
  DECISION_RANKING_ARMS.map((arm) => [arm, []]),
);
const warm = new Map<DecisionRankingArm, Sample[]>(
  DECISION_RANKING_ARMS.map((arm) => [arm, []]),
);

for (const [index, query] of queries.entries()) {
  const words = wordsOf(query);
  if (words.length === 0) {
    continue;
  }
  // Rotate which arm touches a query's postings first, so no arm is always
  // the one that pays for the first read.
  const arms = DECISION_RANKING_ARMS.map(
    (_, offset) =>
      DECISION_RANKING_ARMS[(index + offset) % DECISION_RANKING_ARMS.length] ??
      panic("Arm rotation out of range"),
  );
  for (const arm of arms) {
    // Sequential on purpose: concurrent arms would measure each other.
    firstPass.get(arm)?.push(await search(words, arm));
  }
  for (let run = 0; run < warmRuns; run += 1) {
    for (const arm of arms) {
      warm.get(arm)?.push(await search(words, arm));
    }
  }
}

const report = DECISION_RANKING_ARMS.map((arm) => ({
  arm,
  firstPass: summary(firstPass.get(arm) ?? []),
  // No repeated phase when none was asked for, rather than empty statistics.
  repeated: warmRuns === 0 ? null : summary(warm.get(arm) ?? []),
}));

if (values.json) {
  console.log(
    JSON.stringify({ indexId, language, queries: queries.length, report }),
  );
} else {
  console.log(`${indexId} (${language}), ${String(queries.length)} queries`);
  for (const { arm, firstPass: first, repeated } of report) {
    console.log(
      `${arm.padEnd(5)} first pass p50 ${String(first.p50Ms)} ms p95 ${String(first.p95Ms)} ms | ${repeated === null ? "repeated: not run" : `repeated p50 ${String(repeated.p50Ms)} ms p95 ${String(repeated.p95Ms)} ms`} | median hits ${String(first.p50Hits)}`,
    );
  }
}
