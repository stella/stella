/**
 * Bench eval script: scores pipeline output against
 * gold-annotated academic benchmarks.
 *
 * Usage:
 *   bun apps/web/src/lib/anonymize/bench/eval.ts --benchmark tab
 *   bun apps/web/src/lib/anonymize/bench/eval.ts --benchmark tab --limit 30
 */
/* eslint-disable no-console -- CLI bench script */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { DEFAULT_ENTITY_LABELS, runPipeline } from "@stella/anonymize";
import type { PipelineConfig } from "@stella/anonymize";

import { createNerInference } from "./ner";

const CORPUS_DIR = join(import.meta.dirname, "..", "__corpus__");

type GoldAnnotation = {
  start: number;
  end: number;
  label: string;
  text: string;
};

/**
 * Normalize gold annotation labels to canonical pipeline labels.
 */
const GOLD_LABEL_MAP: Record<string, string> = {
  PERSON: "person",
  PER: "person",
  ORG: "organization",
  LOC: "address",
  GPE: "address",
  DATETIME: "date",
  CODE: "registration number",
  QUANTITY: "registration number",
};

const normalizeGoldLabel = (label: string): string =>
  GOLD_LABEL_MAP[label] ?? label.toLowerCase();

/**
 * Check if two spans overlap by at least 50%.
 */
const hasOverlap50 = (
  predStart: number,
  predEnd: number,
  goldStart: number,
  goldEnd: number,
): boolean => {
  const overlapStart = Math.max(predStart, goldStart);
  const overlapEnd = Math.min(predEnd, goldEnd);
  const overlapLen = Math.max(0, overlapEnd - overlapStart);

  const goldLen = goldEnd - goldStart;
  const predLen = predEnd - predStart;

  if (goldLen === 0 || predLen === 0) {
    return false;
  }

  // 50% overlap relative to the shorter span
  const minLen = Math.min(goldLen, predLen);
  return overlapLen >= minLen * 0.5;
};

type LabelScores = {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
};

const computeScores = (tp: number, fp: number, fn: number): LabelScores => {
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 =
    precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : 0;
  return { tp, fp, fn, precision, recall, f1 };
};

const main = async () => {
  const benchmarkIdx = process.argv.indexOf("--benchmark");
  const benchmark =
    benchmarkIdx !== -1 ? process.argv[benchmarkIdx + 1] : undefined;

  if (!benchmark) {
    console.error("Usage: --benchmark <name> [--limit <n>]");
    process.exit(1);
  }

  const limitIdx = process.argv.indexOf("--limit");
  const limitRaw =
    limitIdx !== -1 ? Number(process.argv[limitIdx + 1]) : Infinity;
  const limit = Number.isNaN(limitRaw) ? Infinity : limitRaw;

  const evalInputDir = join(CORPUS_DIR, "inputs", "_eval", benchmark);

  if (!existsSync(evalInputDir)) {
    console.error(`Benchmark directory not found: ${evalInputDir}`);
    console.error("Run: git submodule init && git submodule update");
    process.exit(1);
  }

  const goldFiles = readdirSync(evalInputDir).filter((f) =>
    f.endsWith(".gold.json"),
  );

  if (goldFiles.length === 0) {
    console.log("No gold annotation files found.");
    return;
  }

  const filesToProcess = goldFiles.slice(0, limit);
  console.log(
    `Evaluating ${filesToProcess.length} file(s) from ${benchmark}...`,
  );

  const nerInference = createNerInference();

  const config: PipelineConfig = {
    threshold: 0.65,
    enableTriggerPhrases: true,
    enableRegex: true,
    enableGazetteer: false,
    enableNer: true,
    enableConfidenceBoost: true,
    enableCoreference: true,
    labels: [...DEFAULT_ENTITY_LABELS],
    workspaceId: "bench-eval",
  };

  const totalCounts: Record<string, { tp: number; fp: number; fn: number }> =
    {};

  const fileScores: {
    file: string;
    precision: number;
    recall: number;
    f1: number;
  }[] = [];

  for (const goldFile of filesToProcess) {
    const name = goldFile.replace(".gold.json", "");
    const textPath = join(evalInputDir, `${name}.txt`);
    const goldPath = join(evalInputDir, goldFile);

    if (!existsSync(textPath)) {
      console.warn(`  Skipping ${name}: no .txt file`);
      continue;
    }

    const text = readFileSync(textPath, "utf8");
    // eslint-disable-next-line no-unsafe-type-assertion -- gold annotation files have known shape
    const goldRaw = JSON.parse(
      readFileSync(goldPath, "utf8"),
    ) as GoldAnnotation[];

    const gold = goldRaw.map((g) => ({
      ...g,
      label: normalizeGoldLabel(g.label),
    }));

    const predictions = await runPipeline(text, config, [], nerInference);

    // Match predictions against gold
    const matchedGold = new Set<number>();
    const matchedPred = new Set<number>();

    for (let pi = 0; pi < predictions.length; pi++) {
      const pred = predictions[pi];
      if (!pred) {
        continue;
      }

      for (let gi = 0; gi < gold.length; gi++) {
        if (matchedGold.has(gi)) {
          continue;
        }
        const g = gold[gi];
        if (!g) {
          continue;
        }

        if (
          pred.label === g.label &&
          hasOverlap50(pred.start, pred.end, g.start, g.end)
        ) {
          matchedGold.add(gi);
          matchedPred.add(pi);
          break;
        }
      }
    }

    const tp = matchedGold.size;
    const fp = predictions.length - matchedPred.size;
    const fn = gold.length - matchedGold.size;

    // Accumulate per-label counts
    for (const pred of predictions) {
      const label = pred.label;
      totalCounts[label] ??= { tp: 0, fp: 0, fn: 0 };
    }
    for (const g of gold) {
      totalCounts[g.label] ??= { tp: 0, fp: 0, fn: 0 };
    }

    for (let pi = 0; pi < predictions.length; pi++) {
      const pred = predictions[pi];
      if (!pred) {
        continue;
      }
      const counts = totalCounts[pred.label];
      if (!counts) {
        continue;
      }
      if (matchedPred.has(pi)) {
        counts.tp++;
      } else {
        counts.fp++;
      }
    }

    for (let gi = 0; gi < gold.length; gi++) {
      const g = gold[gi];
      if (!g) {
        continue;
      }
      if (!matchedGold.has(gi)) {
        const counts = totalCounts[g.label];
        if (counts) {
          counts.fn++;
        }
      }
    }

    const scores = computeScores(tp, fp, fn);
    fileScores.push({
      file: name,
      precision: scores.precision,
      recall: scores.recall,
      f1: scores.f1,
    });

    console.log(
      `  ${name}: P=${scores.precision.toFixed(3)} R=${scores.recall.toFixed(3)} F1=${scores.f1.toFixed(3)} (${tp}tp ${fp}fp ${fn}fn)`,
    );
  }

  // Summary
  console.log("\n--- Per-label scores ---");
  const labelScores: Record<string, LabelScores> = {};
  let totalTp = 0;
  let totalFp = 0;
  let totalFn = 0;

  for (const [label, counts] of Object.entries(totalCounts)) {
    const scores = computeScores(counts.tp, counts.fp, counts.fn);
    labelScores[label] = scores;
    totalTp += counts.tp;
    totalFp += counts.fp;
    totalFn += counts.fn;
    console.log(
      `  ${label}: P=${scores.precision.toFixed(3)} R=${scores.recall.toFixed(3)} F1=${scores.f1.toFixed(3)}`,
    );
  }

  const overall = computeScores(totalTp, totalFp, totalFn);
  console.log(
    `\nOverall: P=${overall.precision.toFixed(3)} R=${overall.recall.toFixed(3)} F1=${overall.f1.toFixed(3)}`,
  );

  // Write scores.json
  const evalOutDir = join(CORPUS_DIR, "eval", benchmark);
  mkdirSync(evalOutDir, { recursive: true });

  const scoresOutput = {
    benchmark,
    filesEvaluated: filesToProcess.length,
    overall,
    perLabel: labelScores,
    perFile: fileScores,
  };

  const scoresPath = join(evalOutDir, "scores.json");
  writeFileSync(
    scoresPath,
    `${JSON.stringify(scoresOutput, null, 2)}\n`,
    "utf8",
  );
  console.log(`\nScores written to ${scoresPath}`);
};

main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
