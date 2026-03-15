/**
 * Bench run script: reads corpus inputs, runs the full
 * anonymisation pipeline, and writes baseline JSON files.
 *
 * Usage:
 *   bun apps/web/src/lib/anonymize/bench/run.ts
 *   bun apps/web/src/lib/anonymize/bench/run.ts --filter ecj
 */
/* eslint-disable no-console -- CLI bench script */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import { DEFAULT_ENTITY_LABELS, runPipeline } from "@stella/anonymize";
import type { Entity, PipelineConfig } from "@stella/anonymize";

import { createNerInference } from "./ner";

const CORPUS_DIR = join(import.meta.dirname, "..", "__corpus__");
const INPUTS_DIR = join(CORPUS_DIR, "inputs");
const BASELINES_DIR = join(CORPUS_DIR, "baselines");

type BaselineEntry = {
  start: number;
  end: number;
  label: string;
  text: string;
  score: number;
  source: string;
};

type BaselineFile = {
  entities: BaselineEntry[];
  stats: {
    totalEntities: number;
    bySource: Record<string, number>;
    byLabel: Record<string, number>;
  };
};

const serializeEntities = (entities: Entity[]): BaselineFile => {
  const sorted = entities.toSorted((a, b) => a.start - b.start);

  const bySource: Record<string, number> = {};
  const byLabel: Record<string, number> = {};

  for (const entity of sorted) {
    bySource[entity.source] = (bySource[entity.source] ?? 0) + 1;
    byLabel[entity.label] = (byLabel[entity.label] ?? 0) + 1;
  }

  return {
    entities: sorted.map((e) => ({
      start: e.start,
      end: e.end,
      label: e.label,
      text: e.text,
      score: Math.round(e.score * 1000) / 1000,
      source: e.source,
    })),
    stats: {
      totalEntities: sorted.length,
      bySource,
      byLabel,
    },
  };
};

const main = async () => {
  if (!existsSync(INPUTS_DIR)) {
    console.error(
      "Corpus not found. Run: git submodule init && git submodule update",
    );
    process.exit(1);
  }

  const filterArg = process.argv.indexOf("--filter");
  const filter = filterArg !== -1 ? process.argv[filterArg + 1] : null;

  const findTxtFiles = (dir: string): string[] => {
    const results: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findTxtFiles(full));
      } else if (entry.name.endsWith(".txt")) {
        results.push(full);
      }
    }
    return results;
  };

  const allFiles = findTxtFiles(INPUTS_DIR).map((f) => ({
    inputPath: f,
    relativeName: relative(INPUTS_DIR, f),
  }));
  const files = allFiles
    .filter((f) => !filter || f.relativeName.includes(filter))
    .map((f) => ({
      ...f,
      relativeName: f.relativeName.replace(/\.txt$/, ".json"),
    }));

  if (files.length === 0) {
    console.log("No matching input files found.");
    return;
  }

  console.log(`Processing ${files.length} file(s)...`);

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
    workspaceId: "bench",
  };

  mkdirSync(BASELINES_DIR, { recursive: true });

  let created = 0;
  let changed = 0;
  let unchanged = 0;

  for (const file of files) {
    const baselineDir = join(
      BASELINES_DIR,
      dirname(file.relativeName),
    );
    mkdirSync(baselineDir, { recursive: true });
    const baselinePath = join(BASELINES_DIR, file.relativeName);

    const text = readFileSync(file.inputPath, "utf8");
    console.log(`  ${file.relativeName} (${text.length} chars)...`);

    const entities = await runPipeline(text, config, [], nerInference);

    const baseline = serializeEntities(entities);
    const json = `${JSON.stringify(baseline, null, 2)}\n`;

    if (!existsSync(baselinePath)) {
      writeFileSync(baselinePath, json, "utf8");
      created++;
      console.log(`    created (${baseline.stats.totalEntities} entities)`);
    } else {
      const existing = readFileSync(baselinePath, "utf8");
      if (existing === json) {
        unchanged++;
        console.log(`    unchanged`);
      } else {
        writeFileSync(baselinePath, json, "utf8");
        changed++;
        console.log(`    changed (${baseline.stats.totalEntities} entities)`);
      }
    }
  }

  console.log(
    `\nDone: ${created} created, ${changed} changed, ${unchanged} unchanged`,
  );
};

main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
