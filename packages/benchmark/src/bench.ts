import { mkdirSync } from "node:fs";
import { cpus, arch, platform, totalmem } from "node:os";
import { join } from "node:path";

import { loadAdhocDocs, runAdhoc } from "./adhoc";
import { createOpenRedactionAdapter } from "./adapters/openredaction";
import { createStllAdapter } from "./adapters/stella";
import { createRedactPiiAdapter } from "./adapters/redact-pii";
import { createPythonAdapter } from "./adapters/python";
import {
  DATAFOG_PROVIDER,
  PRESIDIO_PROVIDER,
  SCRUBADUB_PROVIDER,
} from "./adapters/python-providers";
import type { Adapter, NativePrediction } from "./adapters/types";
import { loadGroundTruth } from "./ground-truth";
import {
  aggregate,
  OVERLAP_THRESHOLD,
  scoreCorpus,
  type ScoredSpan,
} from "./metrics";
import {
  type BenchResult,
  type LibraryReport,
  renderMarkdown,
  type ThroughputReport,
} from "./report";
import {
  COMMON_LABELS,
  DATAFOG_MAPPING,
  type CommonLabel,
  type NativeMapping,
  OPENREDACTION_MAPPING,
  PRESIDIO_MAPPING,
  REDACT_PII_MAPPING,
  SCRUBADUB_MAPPING,
  STELLA_MAPPING,
  supportedLabels,
} from "./taxonomy";

const RESULTS_DIR = join(import.meta.dir, "..", "results");

const git = (args: string[]): string => {
  try {
    const proc = Bun.spawnSync(["git", ...args], { cwd: import.meta.dir });
    // spawnSync can fail to launch (git absent, permission denied): `success`
    // is false and `stdout` may be null. Only trust stdout on a clean exit.
    if (!proc.success || proc.exitCode !== 0 || proc.stdout == null) {
      return "";
    }
    return proc.stdout.toString().trim();
  } catch {
    return "";
  }
};

const gitSha = (): string => {
  const sha = git(["rev-parse", "--short", "HEAD"]) || "no-git";
  const dirty = git(["status", "--porcelain"]) === "" ? "" : "-dirty";
  return `${sha}${dirty}`;
};

const hardwareNote = (): string => {
  const model = cpus().at(0)?.model ?? "unknown CPU";
  const gib = (totalmem() / 1024 ** 3).toFixed(0);
  return `${platform()}/${arch()}, ${cpus().length}x ${model}, ${gib} GiB RAM`;
};

const byLabelPrf = (
  spans: readonly ScoredSpan[],
): Record<CommonLabel, ReturnType<typeof aggregate>> => {
  const record = {} as Record<CommonLabel, ReturnType<typeof aggregate>>;
  for (const label of COMMON_LABELS) {
    record[label] = aggregate(spans.filter((span) => span.label === label));
  }
  return record;
};

const byLanguagePrf = (
  spans: readonly ScoredSpan[],
  languages: readonly string[],
): Record<string, ReturnType<typeof aggregate>> => {
  const record: Record<string, ReturnType<typeof aggregate>> = {};
  for (const language of languages) {
    record[language] = aggregate(
      spans.filter((span) => span.language === language),
    );
  }
  return record;
};

type RegisteredAdapter = { adapter: Adapter; mapping: NativeMapping };

const buildRegisteredAdapters = (): RegisteredAdapter[] => [
  { adapter: createStllAdapter(), mapping: STELLA_MAPPING },
  {
    adapter: createOpenRedactionAdapter(),
    mapping: OPENREDACTION_MAPPING,
  },
  {
    adapter: createPythonAdapter(PRESIDIO_PROVIDER),
    mapping: PRESIDIO_MAPPING,
  },
  {
    adapter: createPythonAdapter(SCRUBADUB_PROVIDER),
    mapping: SCRUBADUB_MAPPING,
  },
  {
    adapter: createPythonAdapter(DATAFOG_PROVIDER),
    mapping: DATAFOG_MAPPING,
  },
  { adapter: createRedactPiiAdapter(), mapping: REDACT_PII_MAPPING },
];

type CliArgs = {
  readonly inputPath: string | undefined;
  readonly language: string;
};

const parseArgs = (argv: readonly string[]): CliArgs => {
  let inputPath: string | undefined;
  let language = "en";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input" || arg === "-i") {
      inputPath = argv[i + 1];
      i++;
    } else if (arg === "--lang") {
      language = argv[i + 1] ?? language;
      i++;
    }
  }
  return { inputPath, language };
};

/**
 * Ad-hoc mode: run every available library over user-supplied files with no
 * ground truth and write an uncommitted side-by-side comparison. This is the
 * anti-overfitting escape hatch documented in the README.
 */
const runAdhocMode = async (
  inputPath: string,
  language: string,
): Promise<void> => {
  const docs = await loadAdhocDocs(inputPath);
  const markdown = await runAdhoc({
    adapters: buildRegisteredAdapters(),
    docs,
    language,
  });

  const adhocDir = join(RESULTS_DIR, "adhoc");
  mkdirSync(adhocDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(adhocDir, `${stamp}.md`);
  await Bun.write(outPath, markdown);

  process.stderr.write(
    `\nwrote (uncommitted, git-ignored):\n  ${outPath}\n` +
      "This report quotes detected entities from your input; do not commit or\n" +
      "share it if the input was sensitive.\n",
  );
};

const run = async (): Promise<void> => {
  const docs = await loadGroundTruth();
  const languages = [...new Set(docs.map((doc) => doc.language))].sort();

  const byLanguage: Record<string, number> = {};
  const byLabel: Record<string, number> = {};
  let entityCount = 0;
  for (const doc of docs) {
    byLanguage[doc.language] = (byLanguage[doc.language] ?? 0) + 1;
    for (const entity of doc.entities) {
      byLabel[entity.label] = (byLabel[entity.label] ?? 0) + 1;
      entityCount++;
    }
  }

  const registered = buildRegisteredAdapters();

  const libraries: LibraryReport[] = [];

  for (const { adapter, mapping } of registered) {
    process.stderr.write(`running ${adapter.name}...\n`);
    const outcome = await adapter.run(docs);

    if (outcome.status === "unavailable") {
      libraries.push({
        name: adapter.name,
        version: adapter.version,
        status: "unavailable",
        reason: outcome.reason,
      });
      process.stderr.write(`  unavailable: ${outcome.reason}\n`);
      continue;
    }

    const supported = [...supportedLabels(mapping)].sort() as CommonLabel[];
    const supportedSet = new Set<CommonLabel>(supported);
    const predictions: ReadonlyMap<string, readonly NativePrediction[]> =
      outcome.predictions;

    const overlapSpans = scoreCorpus(docs, predictions, mapping, "overlap");
    const exactSpans = scoreCorpus(docs, predictions, mapping, "exact");
    const overlapSupported = overlapSpans.filter((span) =>
      supportedSet.has(span.label),
    );

    const throughput: ThroughputReport = {
      initSeconds: outcome.timing.initSeconds,
      totalChars: outcome.timing.totalChars,
      coldCharsPerSec:
        outcome.timing.coldSeconds > 0
          ? outcome.timing.totalChars / outcome.timing.coldSeconds
          : 0,
      warmCharsPerSec:
        outcome.timing.warmSeconds > 0
          ? outcome.timing.totalChars / outcome.timing.warmSeconds
          : 0,
    };

    libraries.push({
      name: adapter.name,
      version: outcome.reportedVersion ?? adapter.version,
      status: "ok",
      notes: outcome.notes,
      supportedLabels: supported,
      throughput,
      overall: {
        overlapAll: aggregate(overlapSpans),
        overlapSupported: aggregate(overlapSupported),
        exactAll: aggregate(exactSpans),
      },
      perLabel: byLabelPrf(overlapSpans),
      perLanguage: byLanguagePrf(overlapSpans, languages),
    });
  }

  const result: BenchResult = {
    createdAt: new Date().toISOString(),
    gitSha: gitSha(),
    hardware: hardwareNote(),
    runtime: `Bun ${Bun.version}`,
    corpus: {
      documents: docs.length,
      entities: entityCount,
      byLanguage,
      byLabel,
    },
    matching: {
      primary: `overlap: same label and IoU >= ${OVERLAP_THRESHOLD}`,
      secondary: "exact: same label and identical [start, end)",
    },
    libraries,
  };

  const date = result.createdAt.slice(0, 10);
  const jsonPath = join(RESULTS_DIR, `${date}.json`);
  const mdPath = join(RESULTS_DIR, `${date}.md`);
  const latestPath = join(RESULTS_DIR, "development-latest.md");
  const markdown = renderMarkdown(result);

  await Bun.write(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  await Bun.write(mdPath, markdown);
  await Bun.write(latestPath, markdown);

  process.stderr.write(
    `\nwrote:\n  ${jsonPath}\n  ${mdPath}\n  ${latestPath}\n`,
  );

  process.stderr.write("\noverall (overlap, all-labels):\n");
  for (const lib of libraries) {
    if (lib.status === "ok") {
      process.stderr.write(
        `  ${lib.name.padEnd(12)} P=${(lib.overall.overlapAll.precision * 100).toFixed(1)} R=${(lib.overall.overlapAll.recall * 100).toFixed(1)} F1=${(lib.overall.overlapAll.f1 * 100).toFixed(1)}\n`,
      );
    }
  }
};

const { inputPath, language } = parseArgs(process.argv.slice(2));
if (inputPath !== undefined) {
  await runAdhocMode(inputPath, language);
} else {
  await run();
}
