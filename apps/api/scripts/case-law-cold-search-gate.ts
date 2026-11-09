import { panic } from "better-result";
import { Buffer } from "node:buffer";

import { printError } from "@stll/errors";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { envBase } from "@/api/env-base";
import { toSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_ENGINE_INGEST_MAX_BYTES,
  getCorpusIndexClient,
} from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexConfigFromManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { buildCaseLawProjectionDocuments } from "@/api/lib/legal-search/corpus-index-projection-builder";
import type { CaseLawProjectionInput } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { caseLawCorpusQueryFields } from "@/api/lib/legal-search/corpus-index-read-contract";
import { caseLawCorpusQuery } from "@/api/lib/legal-search/corpus-query";
import { judgeMcpToolLatency } from "@/api/mcp/tool-latency-budgets";

/**
 * First-hit search latency against a fragmented corpus index, one country at
 * a time, with every cache emptied before the measured query.
 *
 * This is a fixture and not production: it reproduces the split counts of an
 * index whose small splits were never merged, on a single CI runner with
 * local-disk storage and a few thousand short documents. It shows how long
 * a first hit takes under that split layout and query shape, and how that
 * moves between revisions. It does not predict production latency, where the
 * document count, the object-store reads and the concurrent load differ.
 *
 * Report-only unless STELLA_COLD_SEARCH_MODE=enforce.
 */

const MANIFEST = CORPUS_INDEX_MANIFESTS.case_law_v7;
const REVISION = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-00000000c01d",
);
const SOURCE_ID = "0198e331-e578-7000-8000-00000000c01e";
const CONTROL_SERIAL_BASE = 9_000_000;

const DECISIONS_PER_SPLIT = 5;
const PASSAGE_MIN_CHARS = 1100;
const QUERY_PAGE_SIZE = 20;
const ENGINE_READY_ATTEMPTS = 120;
const ENGINE_READY_PAUSE_MS = 500;
const CONTROL_DOCUMENT_BATCHES = 400;

type CountryProfile = {
  country: string;
  language: string;
  court: string;
  query: string;
  sentence: string;
};

type GroupProfile = {
  /** Physical index group; the suffix of the fixture's index id. */
  group: string;
  /** Splits to create, matching an unmerged layout of this group. */
  splits: number;
  countries: readonly CountryProfile[];
};

const GROUPS = [
  {
    group: "cs_sk",
    splits: 450,
    countries: [
      {
        country: "CZE",
        language: "cs",
        court: "Nejvyšší soud",
        query: "náhrada škody",
        sentence:
          "Soud posoudil nárok na náhradu škody podle občanského zákoníku.",
      },
      {
        country: "SVK",
        language: "sk",
        court: "Najvyšší súd Slovenskej republiky",
        query: "náhrada škody",
        sentence:
          "Súd posúdil nárok na náhradu škody podľa Občianskeho zákonníka.",
      },
    ],
  },
  {
    group: "eu",
    splits: 408,
    countries: [
      {
        country: "EU",
        language: "en",
        court: "Court of Justice of the European Union",
        query: "damages liability",
        sentence:
          "The Court examined the claim for damages and the liability of the undertaking.",
      },
    ],
  },
  {
    group: "pol",
    splits: 343,
    countries: [
      {
        country: "POL",
        language: "pl",
        court: "Sąd Najwyższy",
        query: "odszkodowanie umowa",
        sentence:
          "Sąd rozpoznał roszczenie o odszkodowanie wynikające z umowy najmu lokalu.",
      },
    ],
  },
  {
    group: "hun",
    splits: 310,
    countries: [
      {
        country: "HUN",
        language: "hu",
        court: "Kúria",
        query: "kártérítés szerződés",
        sentence:
          "A bíróság a szerződésszegésből eredő kártérítési igényt vizsgálta.",
      },
    ],
  },
] as const satisfies readonly GroupProfile[];

const CONTROL_GROUP: GroupProfile = {
  group: "pol_control",
  splits: 1,
  countries: GROUPS[2].countries,
};

const ENGINE_CONTAINER = process.env["STELLA_COLD_SEARCH_CONTAINER"] ?? "";
const ENGINE_ENDPOINT = process.env["STELLA_CORPUS_ENGINE_TEST_ENDPOINT"] ?? "";
const DROP_PAGE_CACHE =
  process.env["STELLA_COLD_SEARCH_DROP_PAGE_CACHE"] === "true";
const ENFORCE = process.env["STELLA_COLD_SEARCH_MODE"] === "enforce";

const FIXTURE_PREFIX = "case_law_v7_cold";
const fixtureIndexId = (group: string): string => `${FIXTURE_PREFIX}_${group}`;

const passage = (sentence: string): string => {
  const parts: string[] = [];
  let length = 0;
  while (length < PASSAGE_MIN_CHARS) {
    parts.push(sentence);
    length += sentence.length + 1;
  }
  return parts.join(" ");
};

type DecisionDocumentsOptions = {
  profile: CountryProfile;
  serial: number;
};

const decisionDocuments = ({ profile, serial }: DecisionDocumentsOptions) => {
  const text = passage(profile.sentence);
  const ast = {
    version: 1,
    source: {
      system: "fixture",
      documentId: "cold-search",
      webUrl: "https://example.test/cold-search",
      printUrl: "https://example.test/cold-search.pdf",
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
        id: "p0",
        anchorId: "p0",
        type: "paragraph",
        role: "argumentation",
        inlines: [{ type: "text", text }],
        plainText: text,
      },
    ],
  } satisfies DocumentAst;
  const input = {
    family: "case_law",
    documentId: `0198e331-e578-7000-8000-${String(serial).padStart(12, "0")}`,
    sourceId: SOURCE_ID,
    jurisdiction: profile.country,
    language: profile.language,
    documentType: "rozsudok",
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
    caseNumber: `${String(serial)} Cdo 1/2024`,
    identifiers: [],
    court: profile.court,
    courtId: null,
    decisionDate: "2024-01-15",
    ecli: null,
    metadata: null,
  } satisfies CaseLawProjectionInput;
  return buildCaseLawProjectionDocuments({
    manifest: MANIFEST,
    input,
    payload: { text, ast },
    revision: REVISION,
  });
};

const mutationBase = (): string => {
  const base = envBase.CORPUS_INDEX_Q09_ENDPOINT;
  if (base === undefined || base.length === 0) {
    return panic("CORPUS_INDEX_Q09_ENDPOINT is required");
  }
  return base.replace(/\/+$/u, "");
};

/**
 * The engine rejects a merge policy outside its own set, so the fixture adds
 * `no_merge` through the engine's API rather than widening the manifest type:
 * production configs must never be able to disable merging.
 */
const createUnmergedIndex = async (indexId: string): Promise<void> => {
  const config = corpusIndexConfigFromManifest(MANIFEST, indexId);
  const response = await fetch(`${mutationBase()}/api/v1/indexes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...config,
      indexing_settings: {
        ...config.indexing_settings,
        merge_policy: { type: "no_merge" },
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    panic(
      `Create ${indexId} failed: ${String(response.status)} ${await response.text()}`,
    );
  }
};

/** One forced commit, so one split, per call. */
const ingestSplit = async (
  indexId: string,
  documents: readonly unknown[],
): Promise<void> => {
  const ndjson = `${documents.map((document) => JSON.stringify(document)).join("\n")}\n`;
  if (Buffer.byteLength(ndjson) > CORPUS_INDEX_ENGINE_INGEST_MAX_BYTES) {
    panic(`A fixture split for ${indexId} exceeds the engine's ingest limit`);
  }
  const response = await fetch(
    `${mutationBase()}/api/v1/${indexId}/ingest?commit=force`,
    {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: ndjson,
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!response.ok) {
    panic(
      `Ingest into ${indexId} failed: ${String(response.status)} ${await response.text()}`,
    );
  }
};

const seedGroup = async (group: GroupProfile): Promise<void> => {
  const indexId = fixtureIndexId(group.group);
  await createUnmergedIndex(indexId);
  for (let split = 0; split < group.splits; split += 1) {
    const profile =
      group.countries[split % group.countries.length] ??
      panic(`Group ${group.group} has no countries`);
    const documents = Array.from({ length: DECISIONS_PER_SPLIT }, (_, slot) =>
      decisionDocuments({
        profile,
        serial: split * DECISIONS_PER_SPLIT + slot + 1,
      }),
    ).flat();
    await ingestSplit(indexId, documents);
  }
};

/** The control holds the same documents as one index, in a single split. */
const seedControl = async (): Promise<void> => {
  const indexId = fixtureIndexId(CONTROL_GROUP.group);
  await createUnmergedIndex(indexId);
  const profile =
    CONTROL_GROUP.countries[0] ?? panic("Control group has no countries");
  const documents = Array.from(
    { length: CONTROL_DOCUMENT_BATCHES },
    (_, batch) =>
      Array.from({ length: DECISIONS_PER_SPLIT }, (__, slot) =>
        decisionDocuments({
          profile,
          serial: CONTROL_SERIAL_BASE + batch * DECISIONS_PER_SPLIT + slot,
        }),
      ).flat(),
  ).flat();
  await ingestSplit(indexId, documents);
};

const runDocker = async (args: readonly string[]): Promise<void> => {
  const child = Bun.spawn(["docker", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    panic(`docker ${args.join(" ")} failed (${String(exitCode)}): ${stderr}`);
  }
};

const dropPageCache = async (): Promise<void> => {
  const child = Bun.spawn(
    ["sudo", "-n", "sh", "-c", "sync; echo 3 > /proc/sys/vm/drop_caches"],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    panic(`Dropping the page cache failed: ${stderr}`);
  }
};

const waitForEngine = async (): Promise<void> => {
  for (let attempt = 0; attempt < ENGINE_READY_ATTEMPTS; attempt += 1) {
    const ready = await fetch(`${ENGINE_ENDPOINT}/health/readyz`, {
      signal: AbortSignal.timeout(2000),
    }).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) {
      return;
    }
    await Bun.sleep(ENGINE_READY_PAUSE_MS);
  }
  panic("The corpus engine did not come back after a restart");
};

/** Empties the engine's in-process caches and, in CI, the host page cache. */
const makeCold = async (): Promise<void> => {
  await runDocker(["restart", ENGINE_CONTAINER]);
  if (DROP_PAGE_CACHE) {
    await dropPageCache();
  }
  await waitForEngine();
};

type Probe = {
  label: string;
  group: string;
  profile: CountryProfile;
  court: string | undefined;
};

const queryFor = ({ profile, court }: Probe): string => {
  const fields = caseLawCorpusQueryFields({
    generation: MANIFEST.generation,
    jurisdiction: profile.country,
    language: undefined,
  });
  return (
    caseLawCorpusQuery({
      jurisdiction: profile.country,
      text: profile.query,
      filters: {
        jurisdiction: profile.country,
        ...(court === undefined ? {} : { court }),
      },
      queryVariant: "off",
      stemming: fields.stemming,
      surfaceFields: fields.surfaceFields,
      keywordFields: fields.keywordFields,
      functionWords: fields.functionWords,
    }) ?? panic(`No engine query for ${profile.country}`)
  );
};

type Timed = { elapsedMs: number; hits: number };

const timedSearch = async (probe: Probe): Promise<Timed> => {
  const started = performance.now();
  const result = await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: fixtureIndexId(probe.group),
    query: queryFor(probe),
    maxHits: QUERY_PAGE_SIZE,
    startOffset: 0,
    sortBy: "_score",
  });
  const elapsedMs = performance.now() - started;
  if (result.isErr()) {
    return panic(`${probe.label}: ${result.error.message}`);
  }
  return { elapsedMs, hits: result.value.numHits };
};

type Measurement = {
  label: string;
  firstMs: number;
  repeatMs: number;
  hits: number;
  budgetMs: number;
  overBudget: boolean;
};

const measure = async (probe: Probe): Promise<Measurement> => {
  await makeCold();
  const first = await timedSearch(probe);
  const repeat = await timedSearch(probe);
  if (first.hits === 0) {
    panic(`${probe.label}: the fixture answered no hits`);
  }
  const { budgetMs, overBudget } = judgeMcpToolLatency({
    toolName: "search_case_law",
    elapsedMs: first.elapsedMs,
  });
  return {
    label: probe.label,
    firstMs: first.elapsedMs,
    repeatMs: repeat.elapsedMs,
    hits: first.hits,
    budgetMs,
    overBudget,
  };
};

const probes: Probe[] = GROUPS.flatMap((group) =>
  group.countries.flatMap((profile) => [
    {
      label: `${profile.country} fresh`,
      group: group.group,
      profile,
      court: undefined,
    },
    {
      label: `${profile.country} top court`,
      group: group.group,
      profile,
      court: profile.court,
    },
  ]),
);

const main = async (): Promise<void> => {
  if (ENGINE_CONTAINER === "" || ENGINE_ENDPOINT === "") {
    panic(
      "STELLA_COLD_SEARCH_CONTAINER and STELLA_CORPUS_ENGINE_TEST_ENDPOINT are required",
    );
  }
  await Promise.all(GROUPS.map(seedGroup));
  await seedControl();

  const measurements: Measurement[] = [];
  for (const probe of probes) {
    measurements.push(await measure(probe));
  }
  const control = await measure({
    label: "POL single-split control",
    group: CONTROL_GROUP.group,
    profile:
      CONTROL_GROUP.countries[0] ?? panic("Control group has no countries"),
    court: undefined,
  });
  const fragmented =
    measurements.find(({ label }) => label === "POL fresh") ??
    panic("POL measurement is missing");
  const ratio = fragmented.firstMs / Math.max(control.firstMs, 1);

  const rows = [...measurements, control].map(
    ({ label, firstMs, repeatMs, hits, budgetMs, overBudget }) =>
      `| ${label} | ${firstMs.toFixed(0)} | ${repeatMs.toFixed(0)} | ${String(hits)} | ${String(budgetMs)} | ${overBudget ? "over" : "within"} |`,
  );
  const failures = measurements.filter(({ overBudget }) => overBudget);
  const summary = [
    "## Case-law first-hit search (many-split fixture)",
    "",
    "Fixture, not production: split counts of an unmerged index, local disk, small documents.",
    "",
    "| Probe | First hit (ms) | Repeat (ms) | Hits | Tool budget (ms) | First hit |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `POL fragmented versus single-split first hit: ${ratio.toFixed(1)}x.`,
    "",
    ENFORCE
      ? `Enforced: ${String(failures.length)} probe(s) over budget.`
      : `Report-only: ${String(failures.length)} probe(s) over budget.`,
    "",
  ].join("\n");
  process.stdout.write(`${summary}\n`);
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath !== undefined && summaryPath !== "") {
    await Bun.write(summaryPath, summary);
  }
  if (ratio <= 1) {
    process.stdout.write(
      "::warning::The many-split fixture was not slower than its single-split control, so it is not measuring fragmentation.\n",
    );
  }
  if (ENFORCE && failures.length > 0) {
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main().catch((error: unknown) => {
    printError(error);
    process.exitCode = 1;
  });
}
