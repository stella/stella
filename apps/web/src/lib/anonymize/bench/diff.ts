/**
 * Bench diff script: interactive diff reviewer comparing
 * current pipeline output against committed baselines.
 *
 * Usage:
 *   bun apps/web/src/lib/anonymize/bench/diff.ts
 *   bun apps/web/src/lib/anonymize/bench/diff.ts --accept-all
 *   bun apps/web/src/lib/anonymize/bench/diff.ts --summary
 */
/* eslint-disable no-console -- CLI bench script */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { DEFAULT_ENTITY_LABELS, runPipeline } from "@stella/anonymize";
import type { Entity, PipelineConfig } from "@stella/anonymize";

import { createNerInference } from "./ner";

const CORPUS_DIR = join(import.meta.dirname, "..", "__corpus__");
const INPUTS_DIR = join(CORPUS_DIR, "inputs");
const BASELINES_DIR = join(CORPUS_DIR, "baselines");

// ANSI colour codes
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

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

type DiffEntry =
  | { type: "added"; entity: BaselineEntry }
  | { type: "removed"; entity: BaselineEntry }
  | {
      type: "changed";
      before: BaselineEntry;
      after: BaselineEntry;
    };

const entriesToBaseline = (entities: Entity[]): BaselineFile => {
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

const computeDiff = (
  baseline: BaselineEntry[],
  current: BaselineEntry[],
): DiffEntry[] => {
  const diffs: DiffEntry[] = [];
  const matchedBaseline = new Set<number>();
  const matchedCurrent = new Set<number>();

  // Match by position and label
  for (let ci = 0; ci < current.length; ci++) {
    const curr = current[ci];
    if (!curr) {
      continue;
    }

    for (let bi = 0; bi < baseline.length; bi++) {
      if (matchedBaseline.has(bi)) {
        continue;
      }
      const base = baseline[bi];
      if (!base) {
        continue;
      }

      if (
        curr.start === base.start &&
        curr.end === base.end &&
        curr.label === base.label
      ) {
        // Same span; check if score/source changed
        if (curr.score !== base.score || curr.source !== base.source) {
          diffs.push({
            type: "changed",
            before: base,
            after: curr,
          });
        }
        matchedBaseline.add(bi);
        matchedCurrent.add(ci);
        break;
      }
    }
  }

  // Unmatched baseline entries are removals
  for (let bi = 0; bi < baseline.length; bi++) {
    if (!matchedBaseline.has(bi)) {
      const base = baseline[bi];
      if (base) {
        diffs.push({ type: "removed", entity: base });
      }
    }
  }

  // Unmatched current entries are additions
  for (let ci = 0; ci < current.length; ci++) {
    if (!matchedCurrent.has(ci)) {
      const curr = current[ci];
      if (curr) {
        diffs.push({ type: "added", entity: curr });
      }
    }
  }

  return diffs;
};

const formatDiffEntry = (entry: DiffEntry): string => {
  switch (entry.type) {
    case "added":
      return `${GREEN}+ [${entry.entity.start}-${entry.entity.end}] ${entry.entity.label}: "${entry.entity.text}" (${entry.entity.score})${RESET}`;
    case "removed":
      return `${RED}- [${entry.entity.start}-${entry.entity.end}] ${entry.entity.label}: "${entry.entity.text}" (${entry.entity.score})${RESET}`;
    case "changed":
      return `${YELLOW}~ [${entry.before.start}-${entry.before.end}] ${entry.before.label}: "${entry.before.text}" score ${entry.before.score} -> ${entry.after.score}${RESET}`;
    default:
      return "";
  }
};

const prompt = async (question: string): Promise<string> => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return await new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
};

const main = async () => {
  if (!existsSync(INPUTS_DIR)) {
    console.error(
      "Corpus not found. Run: git submodule init && git submodule update",
    );
    process.exit(1);
  }

  const acceptAll = process.argv.includes("--accept-all");
  const summaryOnly = process.argv.includes("--summary");

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
    workspaceId: "bench-diff",
  };

  const files = readdirSync(INPUTS_DIR).filter((f) => f.endsWith(".txt"));

  let totalAdded = 0;
  let totalRemoved = 0;
  let totalChanged = 0;
  let accepted = 0;
  let skipped = 0;

  for (const file of files) {
    const inputPath = join(INPUTS_DIR, file);
    const baselineName = file.replace(/\.txt$/, ".json");
    const baselinePath = join(BASELINES_DIR, baselineName);

    if (!existsSync(baselinePath)) {
      console.log(`  ${file}: no baseline (run bench/run.ts first)`);
      continue;
    }

    const text = readFileSync(inputPath, "utf8");
    // eslint-disable-next-line no-unsafe-type-assertion -- baseline files have known shape
    const baselineRaw = JSON.parse(
      readFileSync(baselinePath, "utf8"),
    ) as BaselineFile;

    const entities = await runPipeline(text, config, [], nerInference);
    const current = entriesToBaseline(entities);

    const diffs = computeDiff(baselineRaw.entities, current.entities);

    if (diffs.length === 0) {
      continue;
    }

    const added = diffs.filter((d) => d.type === "added").length;
    const removed = diffs.filter((d) => d.type === "removed").length;
    const changed = diffs.filter((d) => d.type === "changed").length;

    totalAdded += added;
    totalRemoved += removed;
    totalChanged += changed;

    console.log(
      `\n${file}: ${added} added, ${removed} removed, ${changed} changed`,
    );

    if (summaryOnly) {
      continue;
    }

    for (const diff of diffs) {
      console.log(`  ${formatDiffEntry(diff)}`);
    }

    if (acceptAll) {
      const json = `${JSON.stringify(current, null, 2)}\n`;
      writeFileSync(baselinePath, json, "utf8");
      accepted++;
      console.log("  -> accepted");
    } else {
      const answer = await prompt("  (a)ccept / (s)kip / (q)uit? ");

      if (answer === "a") {
        const json = `${JSON.stringify(current, null, 2)}\n`;
        writeFileSync(baselinePath, json, "utf8");
        accepted++;
        console.log("  -> accepted");
      } else if (answer === "q") {
        console.log("Quitting.");
        break;
      } else {
        skipped++;
        console.log("  -> skipped");
      }
    }
  }

  console.log(
    `\nSummary: +${totalAdded} -${totalRemoved} ~${totalChanged} | ${accepted} accepted, ${skipped} skipped`,
  );
};

main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
