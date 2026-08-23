import { join } from "node:path";

import { createBenchmarkAdapters } from "./adapters";
import { scoreBlindCorpus } from "./blind/score";
import {
  loadVerifiedTabTestCorpus,
  selectBlindSample,
  TAB_PROVENANCE,
  TAB_SAMPLE_SEED,
  TAB_SAMPLE_SIZE,
} from "./blind/tab";
import type { GroundTruthDocument } from "./ground-truth";
import { benchmarkSourceGitSha } from "./git-revision";
import { runSealedBoundary } from "./sealed-boundary";
import {
  SEALED_AGGREGATE_REPORT_SCHEMA_VERSION,
  type SealedAggregateReport,
  type SealedLibraryResult,
  type TabAggregateMetrics,
  normalizeSealedProviderVersion,
  writeSealedAggregateReport,
} from "./sealed-report";

const RESULTS_DIR = join(import.meta.dir, "..", "results", "blind");
const sourceGitSha = benchmarkSourceGitSha();

const full = process.argv.slice(2).includes("--full");
const corpus = await runSealedBoundary(
  "TAB verification or parsing",
  loadVerifiedTabTestCorpus,
);
const selected = full ? corpus : selectBlindSample(corpus);
if (!full && selected.length !== TAB_SAMPLE_SIZE) {
  throw new Error("TAB fixed sample size invariant failed");
}

const inputs: GroundTruthDocument[] = selected.map(({ id, text }) => ({
  id,
  text,
  language: "en",
  title: id,
  entities: [],
}));

const libraries: SealedLibraryResult[] = [];
for (const adapter of createBenchmarkAdapters()) {
  process.stderr.write(`running sealed TAB adapter ${adapter.name}...\n`);
  const start = performance.now();
  const outcome = await runSealedBoundary(
    `sealed adapter ${adapter.name}`,
    () => adapter.run(inputs),
  );
  const adapterWallSeconds = (performance.now() - start) / 1000;
  if (outcome.status === "unavailable") {
    libraries.push({
      name: adapter.name,
      version: adapter.version,
      status: "unavailable",
      reasonCode: outcome.reasonCode,
    });
    continue;
  }
  const score = scoreBlindCorpus(selected, outcome.predictions);
  const metrics: TabAggregateMetrics = {
    type: "tab-independent-annotator-span-redaction",
    ...score,
  };
  libraries.push({
    name: adapter.name,
    version: normalizeSealedProviderVersion(
      outcome.reportedVersion ?? adapter.version,
    ),
    status: "ok",
    timing: outcome.timing,
    adapterWallSeconds,
    metrics,
  });
}

const report: SealedAggregateReport = {
  schemaVersion: SEALED_AGGREGATE_REPORT_SCHEMA_VERSION,
  createdAt: new Date().toISOString(),
  sourceGitSha,
  runtime: `Bun ${Bun.version}`,
  policy: "evaluation-only",
  corpus: {
    id: "tab-echr",
    source: TAB_PROVENANCE.repository,
    version: TAB_PROVENANCE.commit,
    file: TAB_PROVENANCE.file,
    sha256: TAB_PROVENANCE.sha256,
    license: TAB_PROVENANCE.license,
    split: "test",
    documentCount: selected.length,
    selection: full
      ? { type: "full-test-split" }
      : { type: "fixed-hash-sample", seed: TAB_SAMPLE_SEED },
  },
  libraries,
};

const { jsonPath, markdownPath } = await writeSealedAggregateReport({
  directory: RESULTS_DIR,
  report,
});
process.stderr.write(
  `wrote aggregate-only sealed TAB report:\n  ${jsonPath}\n  ${markdownPath}\n`,
);
