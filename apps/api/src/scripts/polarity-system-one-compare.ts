import { panic, Result } from "better-result";
import { and, eq, exists, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { mkdir } from "node:fs/promises";

import { mapWithConcurrency } from "@stll/concurrency";

import { caseLawCitations, caseLawDecisions } from "@/api/db/schema";
import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import { extractContext } from "@/api/handlers/case-law/polarity/context";
import { classifyWithLLM } from "@/api/handlers/case-law/polarity/llm-classifier";
import {
  POLARITY_QUESTION,
  SYSTEM_ONE_POLARITY_ACCEPT_CONFIDENCE,
} from "@/api/handlers/case-law/polarity/system-one-classifier";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { openCaseLawReadOnlySession } from "@/api/lib/case-law/maintenance-lane";
import { readCorpusText } from "@/api/lib/legal-search/corpus-storage";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import {
  createSystemOneClient,
  SYSTEM_ONE_USD_PER_INPUT_TOKEN,
} from "@/api/lib/workflow/decisions/system-one";
import {
  disagreements,
  DISAGREEMENT_EXAMPLES,
  parseCompareArgs,
  planSampleBuckets,
  renderComparisonReport,
  STORED_LABEL_ABSENT,
  storedLabelOf,
  summariseComparison,
  truncateExcerpt,
  USAGE,
} from "@/api/scripts/polarity-system-one-compare.logic";
import type {
  ComparisonRow,
  JevOutcome,
  LlmOutcome,
  SampleBucket,
  SampleSkipReason,
} from "@/api/scripts/polarity-system-one-compare.logic";

/**
 * How a System One reading of citation polarity compares with the label the
 * corpus already carries, over a sample of resolved precedent citations.
 *
 * Reads only, through the public-law reader role: the confusion matrix, the
 * acceptance curve `SYSTEM_ONE_POLARITY_ACCEPT_CONFIDENCE` is set from,
 * latency and the input-token cost. Nothing is written back — the run judges
 * the tier, it does not label the corpus.
 *
 * The sample is stratified per stored label by default, NULL and `unknown`
 * included: the corpus is mostly unlabelled and `negative` is rare, so a
 * population sample would measure almost nothing outside the majority label.
 * Rows whose stored label is NULL or `unknown` carry no reading to agree
 * with, so they are reported as coverage rather than scored.
 *
 *   cd apps/api && bun --env-file=.env src/scripts/polarity-system-one-compare.ts \
 *     --limit 200 --language cs --seed 2026-09-17
 *
 * Needs PUBLIC_LAW_DATABASE_URL (the read-only corpus role) and
 * TYPESAFE_API_KEY; TYPESAFE_MODEL or --model pins the model.
 */

const USAGE_EXIT_CODE = 2;
/** Nothing was read: the run measured nothing, and must not read as a pass. */
const EMPTY_SAMPLE_EXIT_CODE = 1;

// The explicit function-type annotation (not just a return annotation) is what
// lets control-flow analysis treat a `fail(...)` statement as unreachable-after
// and narrow past it.
const fail: (message: string) => never = (message) => {
  console.error(message);
  console.error(USAGE);
  process.exit(USAGE_EXIT_CODE);
};

/** Runtime failure: same exit code as `fail`, without re-printing usage. */
const abort: (message: string) => never = (message) => {
  console.error(message);
  process.exit(USAGE_EXIT_CODE);
};

const parsed = parseCompareArgs(process.argv.slice(2));
if (Result.isError(parsed)) {
  fail(parsed.error.message);
}
if (parsed.value.type === "help") {
  console.log(USAGE);
  process.exit(0);
}
const options = parsed.value.options;

if (envBase.PUBLIC_LAW_DATABASE_URL === undefined) {
  abort(
    "PUBLIC_LAW_DATABASE_URL is not set. Point it at the corpus, as the read-only public-law role.",
  );
}
const apiKey = env.TYPESAFE_API_KEY;
if (apiKey === undefined) {
  abort("TYPESAFE_API_KEY is not set; the System One tier cannot be measured.");
}
const client = createSystemOneClient({
  apiKey,
  model: options.model ?? env.TYPESAFE_MODEL,
});

const REQUEST_TIMEOUT_MS = 15_000;

type SampledCitation = {
  id: string;
  citationText: string;
  citingDecisionId: string;
  citedDecisionId: string | null;
  sectionIndex: number | null;
  storedPolarity: string | null;
};

/**
 * The citation columns the public-law reader role may select, aliased to
 * `SampledCitation` above. Every column is named through its Drizzle
 * definition, so a renamed column fails to compile rather than to select.
 */
const sampleSelection = sql`
  ${caseLawCitations.id} AS "id",
  ${caseLawCitations.citationText} AS "citationText",
  ${caseLawCitations.citingDecisionId} AS "citingDecisionId",
  ${caseLawCitations.citedDecisionId} AS "citedDecisionId",
  ${caseLawCitations.sectionIndex} AS "sectionIndex",
  ${caseLawCitations.polarity} AS "storedPolarity"
`;

/**
 * Deterministic order over the filtered population: the same seed draws the
 * same citations, so a run can be repeated against another model and the two
 * reports compared row for row. The hash is computed over every row the
 * filters admit, which is what the run pays for, so keep `--limit` and the
 * filters in mind against the whole corpus.
 */
const samplingOrder = sql`md5(${caseLawCitations.id}::text || ${options.seed})`;

const storedLabelPredicate = (bucket: SampleBucket) => {
  switch (bucket.scope) {
    case "all":
      return undefined;
    case "stored-label":
      return bucket.label === STORED_LABEL_ABSENT
        ? isNull(caseLawCitations.polarity)
        : eq(caseLawCitations.polarity, bucket.label);
    default:
      bucket satisfies never;
      return panic("unhandled sample bucket scope", bucket);
  }
};

/**
 * The language filter as a semi-join rather than a join: the sample is drawn
 * from the citations alone, and the citing decisions are read once, for the
 * rows that survive.
 */
const languagePredicate = (tx: CaseLawPublicReadTransaction) =>
  options.language === null
    ? undefined
    : exists(
        tx
          .select({ one: sql`1` })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.id, caseLawCitations.citingDecisionId),
              eq(caseLawDecisions.language, options.language),
            ),
          ),
      );

/**
 * One stratum, as a parenthesized branch of the sampling statement. The whole
 * sample is one round trip: the strata are a fixed, small set, and each branch
 * is its own top-N over the hash, which is the plan a per-label index can
 * serve.
 */
const bucketQuery = (
  tx: CaseLawPublicReadTransaction,
  bucket: SampleBucket,
) => {
  const filters =
    and(
      eq(caseLawCitations.kind, CITATION_KIND.PRECEDENT),
      isNotNull(caseLawCitations.citedDecisionId),
      storedLabelPredicate(bucket),
      languagePredicate(tx),
    ) ?? panic("the sample filters collapsed to nothing", bucket);
  return sql`(
    SELECT ${sampleSelection}
    FROM ${caseLawCitations}
    WHERE ${filters}
    ORDER BY ${samplingOrder}
    LIMIT ${bucket.limit}
  )`;
};

type CitingDecision = {
  language: string;
  court: string;
  caseNumber: string;
  /** Null where the row's text was trimmed to object storage. */
  sections: DecisionSection[] | null;
  /** The Postgres copy of the text; null for a canonical row. */
  fulltext: string | null;
  /** Where a canonical row keeps its text instead. */
  textS3Key: string | null;
};

const { rootDb } = await openCaseLawReadOnlySession();

const readSample = async () =>
  await rootDb.transaction(async (tx) => {
    const citations = await tx.execute<SampledCitation>(
      sql.join(
        planSampleBuckets(options).map((bucket) => bucketQuery(tx, bucket)),
        sql.raw(" UNION ALL "),
      ),
    );
    const citingIds = [
      ...new Set(citations.map((citation) => citation.citingDecisionId)),
    ].map(brandPersistedCaseLawDecisionId);
    const decisions = new Map<string, CitingDecision>();
    if (citingIds.length === 0) {
      return { citations, decisions };
    }
    const rows = await tx
      .select({
        id: caseLawDecisions.id,
        language: caseLawDecisions.language,
        court: caseLawDecisions.court,
        caseNumber: caseLawDecisions.caseNumber,
        sections: caseLawDecisions.sections,
        fulltext: caseLawDecisions.fulltext,
        textS3Key: caseLawDecisions.textS3Key,
      })
      .from(caseLawDecisions)
      .where(inArray(caseLawDecisions.id, citingIds));
    for (const { id, ...decision } of rows) {
      decisions.set(id, decision);
    }
    return { citations, decisions };
  });

const { citations, decisions } = await readSample();

/** One sampled citation with the context window both tiers read. */
type ComparisonItem = {
  citation: SampledCitation;
  decision: CitingDecision;
  context: string;
};

/** The row's text: its Postgres copy, else its corpus object, else nothing. */
const decisionText = async (
  decision: CitingDecision,
): Promise<string | null> => {
  if (decision.fulltext !== null) {
    return decision.fulltext;
  }
  if (decision.textS3Key === null) {
    return null;
  }
  const read = await Result.tryPromise(
    async () => await readCorpusText(decision.textS3Key ?? ""),
  );
  return Result.isOk(read) ? read.value : null;
};

const items: ComparisonItem[] = [];
const skipped: SampleSkipReason[] = [];
for (const citation of citations) {
  const decision =
    decisions.get(citation.citingDecisionId) ??
    panic("a sampled citation has no citing decision", {
      citationId: citation.id,
    });
  // Most rows carry no segmentation; the classifier's own runner reads the
  // window off the sections, so the full text stands in for them here and
  // the section index is dropped with them. A canonical row keeps that text
  // in object storage, read through the corpus client (one object per row).
  const text = await decisionText(decision);
  const sections = decision.sections ?? (text === null ? null : [{ text }]);
  if (sections === null) {
    skipped.push("sections-missing");
    continue;
  }
  const context = extractContext(
    sections,
    citation.citationText,
    decision.sections === null ? null : citation.sectionIndex,
  );
  if (context === null) {
    skipped.push("context-not-found");
    continue;
  }
  items.push({ citation, decision, context });
}

/**
 * The raw model, not a decision: the agreement curve is what sets the floor,
 * so every reading is kept whatever its confidence, together with the model,
 * latency and tokens the run is priced from.
 */
const readWithSystemOne = async (item: ComparisonItem): Promise<JevOutcome> => {
  const asked = await client.ask({
    state: {
      language: item.decision.language,
      citation: item.citation.citationText,
      excerpt: item.context,
    },
    questions: { polarity: POLARITY_QUESTION },
    abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (Result.isError(asked)) {
    return {
      status: "failed",
      kind: asked.error.kind,
      message: asked.error.message,
    };
  }
  const { answers, model, latencyMs, usage } = asked.value;
  return {
    status: "read",
    polarity: answers.polarity.choice,
    probabilities: answers.polarity.probabilities,
    confidence: answers.polarity.confidence,
    latencyMs,
    inputTokens: usage.inputTokens,
    model,
  };
};

const readWithLlm = async (item: ComparisonItem): Promise<LlmOutcome> => {
  if (!options.llm) {
    return { status: "not-run" };
  }
  const startedAt = performance.now();
  const classified = await classifyWithLLM({
    context: item.context,
    citationText: item.citation.citationText,
    language: item.decision.language,
  });
  const latencyMs = Math.round(performance.now() - startedAt);
  if (Result.isError(classified)) {
    return { status: "failed", message: classified.error.message };
  }
  const { polarity, confidence, keyPhrase } = classified.value;
  return { status: "read", polarity, confidence, keyPhrase, latencyMs };
};

let completed = 0;
const rows = await mapWithConcurrency({
  items,
  limit: options.concurrency,
  operation: async (item: ComparisonItem): Promise<ComparisonRow> => {
    const [jev, llm] = await Promise.all([
      readWithSystemOne(item),
      readWithLlm(item),
    ]);
    completed += 1;
    console.error(`read ${completed}/${items.length}…`);
    return {
      citationId: item.citation.id,
      citingDecisionId: item.citation.citingDecisionId,
      citedDecisionId:
        item.citation.citedDecisionId ??
        panic("a sampled citation resolved to no decision", {
          citationId: item.citation.id,
        }),
      caseNumber: item.decision.caseNumber,
      court: item.decision.court,
      language: item.decision.language,
      citationText: item.citation.citationText,
      excerpt: truncateExcerpt(item.context),
      stored: storedLabelOf(item.citation.storedPolarity),
      jev,
      llm,
    };
  },
});

const summary = summariseComparison({
  rows,
  sampled: citations.length,
  skipped,
  usdPerInputToken: SYSTEM_ONE_USD_PER_INPUT_TOKEN,
});

const markdown = renderComparisonReport({
  summary,
  options,
  rows,
  acceptFloor: SYSTEM_ONE_POLARITY_ACCEPT_CONFIDENCE,
  model:
    rows
      .flatMap((row) => (row.jev.status === "read" ? [row.jev.model] : []))
      .at(0) ?? null,
});

await mkdir(options.outDir, { recursive: true });
const jsonPath = `${options.outDir}/report.json`;
const markdownPath = `${options.outDir}/report.md`;
await Bun.write(
  jsonPath,
  `${JSON.stringify({ options, summary, rows }, null, 2)}\n`,
);
await Bun.write(markdownPath, `${markdown}\n`);

console.log(markdown);
// The examples again, unwrapped: a table cell folds the excerpt onto one line,
// and this is the part a human reads to judge who is right.
for (const row of disagreements(rows, DISAGREEMENT_EXAMPLES)) {
  const read =
    row.jev.status === "read"
      ? row.jev
      : panic("a disagreement carries no reading", {
          citationId: row.citationId,
        });
  console.log(
    `\n${row.caseNumber} — stored ${row.stored}, Jev ${read.polarity} (${read.confidence.toFixed(2)})\n  ${row.citationText}\n  ${row.excerpt}`,
  );
}
console.log(`\nwrote ${jsonPath} and ${markdownPath}`);

process.exit(summary.read === 0 ? EMPTY_SAMPLE_EXIT_CODE : 0);
