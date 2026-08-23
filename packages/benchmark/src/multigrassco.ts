import { join } from "node:path";

import { createBenchmarkAdapters } from "./adapters";
import type { GroundTruthDocument } from "./ground-truth";
import { benchmarkSourceGitSha } from "./git-revision";
import { runSealedBoundary } from "./sealed-boundary";
import {
  SEALED_AGGREGATE_REPORT_SCHEMA_VERSION,
  type MultiGraSCCoAggregateMetrics,
  type SealedAggregateReport,
  type SealedLibraryResult,
  normalizeSealedProviderVersion,
  writeSealedAggregateReport,
} from "./sealed-report";
import {
  loadVerifiedMultiGraSCCo,
  MULTIGRASCCO_PROVENANCE,
} from "./suite/multigrassco";
import { scoreSpanCorpus } from "./suite/span-score";

const RESULTS_DIR = join(
  import.meta.dir,
  "..",
  "results",
  "blind",
  "multigrassco",
);
const sourceGitSha = benchmarkSourceGitSha();
const corpus = await runSealedBoundary(
  "MultiGraSCCo verification or parsing",
  loadVerifiedMultiGraSCCo,
);
const inputs: GroundTruthDocument[] = corpus.documents.map(
  ({ id, language, text }) => ({
    id,
    text,
    title: id,
    language,
    entities: [],
  }),
);
const libraries: SealedLibraryResult[] = [];
for (const adapter of createBenchmarkAdapters()) {
  process.stderr.write(
    `running sealed MultiGraSCCo adapter ${adapter.name}...\n`,
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
  const direct = scoreSpanCorpus(
    corpus.documents.map(({ id, text, directSpans }) => ({
      id,
      text,
      spans: directSpans,
    })),
    outcome.predictions,
  );
  const indirect = scoreSpanCorpus(
    corpus.documents.map(({ id, text, indirectSpans }) => ({
      id,
      text,
      spans: indirectSpans,
    })),
    outcome.predictions,
  );
  const accepted = scoreSpanCorpus(
    corpus.documents.map(({ id, text, directSpans, indirectSpans }) => ({
      id,
      text,
      spans: [...directSpans, ...indirectSpans],
    })),
    outcome.predictions,
  );
  let predictedSpans = 0;
  for (const { id } of corpus.documents) {
    predictedSpans += outcome.predictions.get(id)?.length ?? 0;
  }
  const metrics: MultiGraSCCoAggregateMetrics = {
    type: "multigrassco-direct-indirect-redaction",
    documents: corpus.documents.length,
    directSpans: direct.goldSpans,
    indirectSpans: indirect.goldSpans,
    predictedSpans,
    directSpanRecall: direct.spanRecall,
    indirectSpanRecall: indirect.spanRecall,
    directCharacterRecall: direct.characterRecall,
    indirectCharacterRecall: indirect.characterRecall,
    acceptedCharacterPrecision: accepted.characterPrecision,
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
    id: "multigrassco",
    source: MULTIGRASCCO_PROVENANCE.repository,
    version: MULTIGRASCCO_PROVENANCE.version,
    file: MULTIGRASCCO_PROVENANCE.file,
    sha256: MULTIGRASCCO_PROVENANCE.sha256,
    license: MULTIGRASCCO_PROVENANCE.license,
    split: "evaluation",
    documentCount: corpus.documents.length,
    selection: {
      type: "validated-offset-subset",
      sourceDocuments: corpus.sourceDocuments,
      excludedDocuments: corpus.excludedDocuments,
      reasonCode: "invalid-source-spans",
    },
  },
  libraries,
};
const { jsonPath, markdownPath } = await writeSealedAggregateReport({
  directory: RESULTS_DIR,
  report,
});
process.stderr.write(
  `wrote aggregate-only sealed MultiGraSCCo report:\n  ${jsonPath}\n  ${markdownPath}\n`,
);
