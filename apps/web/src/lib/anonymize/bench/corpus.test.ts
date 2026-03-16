/**
 * Corpus regression test: runs the pipeline on all corpus
 * inputs and asserts output matches committed baselines.
 *
 * Gracefully skips when the __corpus__ submodule is not
 * initialized.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_ENTITY_LABELS, runPipeline } from "@stella/anonymize";
import type { Entity, PipelineConfig } from "@stella/anonymize";

import { createNerInference } from "./ner";

const CORPUS_DIR = join(import.meta.dirname, "..", "__corpus__");
const INPUTS_DIR = join(CORPUS_DIR, "inputs");
const BASELINES_DIR = join(CORPUS_DIR, "baselines");

const corpusAvailable = existsSync(INPUTS_DIR) && existsSync(BASELINES_DIR);

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

describe.skipIf(!corpusAvailable)("corpus baseline regression", () => {
  const config: PipelineConfig = {
    threshold: 0.65,
    enableTriggerPhrases: true,
    enableRegex: true,
    enableNameCorpus: true,
    enableGazetteer: false,
    enableNer: true,
    enableConfidenceBoost: true,
    enableCoreference: true,
    labels: [...DEFAULT_ENTITY_LABELS],
    workspaceId: "test",
  };

  const nerInference = createNerInference();

  const files = corpusAvailable
    ? readdirSync(INPUTS_DIR).filter((f) => f.endsWith(".txt"))
    : [];

  for (const file of files) {
    const baselineName = file.replace(/\.txt$/, ".json");
    const baselinePath = join(BASELINES_DIR, baselineName);

    if (!existsSync(baselinePath)) {
      continue;
    }

    it(`matches baseline for ${file}`, async () => {
      const inputPath = join(INPUTS_DIR, file);
      const text = readFileSync(inputPath, "utf8");

      const entities = await runPipeline(text, config, [], nerInference);

      const current = serializeEntities(entities);
      // eslint-disable-next-line no-unsafe-type-assertion -- baseline files have known shape
      const expected = JSON.parse(
        readFileSync(baselinePath, "utf8"),
      ) as BaselineFile;

      expect(current.entities).toStrictEqual(expected.entities);
    });
  }
});
