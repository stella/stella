import { join } from "node:path";

import { createBenchmarkAdapters } from "./adapters";
import { createNymAssistedAdapter } from "./adapters/nym-assisted";
import type { GroundTruthDocument } from "./ground-truth";
import { benchmarkSourceGitSha } from "./git-revision";
import { runSealedBoundary } from "./sealed-boundary";
import {
  type GermanLerAggregateMetrics,
  normalizeSealedProviderVersion,
  SEALED_AGGREGATE_REPORT_SCHEMA_VERSION,
  type SealedAggregateReport,
  type SealedLibraryResult,
  writeSealedAggregateReport,
} from "./sealed-report";
import {
  GERMAN_LER_PROVENANCE,
  loadVerifiedGermanLer,
} from "./suite/german-ler";
import { scoreSpanCorpus } from "./suite/span-score";

const RESULTS_DIR = join(
  import.meta.dir,
  "..",
  "results",
  "blind",
  "german-ler",
);
const sourceGitSha = benchmarkSourceGitSha();
const assisted = process.argv.slice(2).includes("--assisted");
const unexpectedArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--assisted");
if (unexpectedArguments.length > 0) {
  throw new Error(`unknown argument: ${unexpectedArguments.join(", ")}`);
}
const documents = await runSealedBoundary(
  "German LER verification or parsing",
  loadVerifiedGermanLer,
);
const inputs: GroundTruthDocument[] = documents.map(({ id, text }) => ({
  id,
  text,
  title: id,
  language: "de",
  entities: [],
}));
const libraries: SealedLibraryResult[] = [];
const adapters = createBenchmarkAdapters();
if (assisted) adapters.push(createNymAssistedAdapter());
for (const adapter of adapters) {
  process.stderr.write(
    `running sealed German LER adapter ${adapter.name}...\n`,
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
  const score = scoreSpanCorpus(documents, outcome.predictions);
  const predictedSpans = [...outcome.predictions.values()].reduce(
    (sum, spans) => sum + spans.length,
    0,
  );
  const metrics: GermanLerAggregateMetrics = {
    type: "german-legal-entity-coverage",
    documents: documents.length,
    entityRecall: score.spanRecall,
    characterRecall: score.characterRecall,
    characterPrecision: score.characterPrecision,
    goldEntities: score.goldSpans,
    predictedSpans,
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
    id: "german-ler",
    source: GERMAN_LER_PROVENANCE.repository,
    version: GERMAN_LER_PROVENANCE.commit,
    file: GERMAN_LER_PROVENANCE.file,
    sha256: GERMAN_LER_PROVENANCE.sha256,
    license: GERMAN_LER_PROVENANCE.license,
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
  `wrote aggregate-only sealed German LER report:\n  ${jsonPath}\n  ${markdownPath}\n`,
);
