import { join } from "node:path";

import { createBenchmarkAdapters } from "./adapters";
import type { GroundTruthDocument } from "./ground-truth";
import { benchmarkSourceGitSha } from "./git-revision";
import { runSealedBoundary } from "./sealed-boundary";
import {
  type RedactionBenchAggregateMetrics,
  SEALED_AGGREGATE_REPORT_SCHEMA_VERSION,
  type SealedAggregateReport,
  type SealedLibraryResult,
  normalizeSealedProviderVersion,
  writeSealedAggregateReport,
} from "./sealed-report";
import {
  loadVerifiedRedactionBench,
  REDACTIONBENCH_PROVENANCE,
} from "./suite/redactionbench";
import { scoreRedactionBench } from "./suite/redactionbench-score";

const RESULTS_DIR = join(
  import.meta.dir,
  "..",
  "results",
  "blind",
  "redactionbench",
);
const sourceGitSha = benchmarkSourceGitSha();
const documents = await runSealedBoundary(
  "RedactionBench verification or parsing",
  loadVerifiedRedactionBench,
);
const inputs: GroundTruthDocument[] = documents.map(({ id, text }) => ({
  id,
  text,
  title: id,
  language: "en",
  entities: [],
}));
const libraries: SealedLibraryResult[] = [];
for (const adapter of createBenchmarkAdapters()) {
  process.stderr.write(
    `running sealed RedactionBench adapter ${adapter.name}...\n`,
  );
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
  const metrics: RedactionBenchAggregateMetrics = {
    type: "redactionbench-transparent-interim",
    ...scoreRedactionBench(documents, outcome.predictions),
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
    id: "redactionbench",
    source: REDACTIONBENCH_PROVENANCE.repository,
    version: REDACTIONBENCH_PROVENANCE.commit,
    file: REDACTIONBENCH_PROVENANCE.file,
    sha256: REDACTIONBENCH_PROVENANCE.sha256,
    license: REDACTIONBENCH_PROVENANCE.license,
    split: "test",
    documentCount: documents.length,
    selection: { type: "full-test-split" },
  },
  libraries,
};
const { jsonPath, markdownPath } = await writeSealedAggregateReport({
  directory: RESULTS_DIR,
  report,
});
process.stderr.write(
  `wrote aggregate-only sealed RedactionBench report:\n  ${jsonPath}\n  ${markdownPath}\n`,
);
