import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  readerExplainCases,
  SCHREMS_I,
  SCHREMS_II,
} from "./lib/reader-explain-cases";
import {
  type explainCorpusCaptureSchema,
  explainToolTraceSchema,
} from "./lib/reader-explain-score";

const promptSchema = v.object({
  runId: v.pipe(v.string(), v.uuid()),
  tracePath: v.string(),
  caseId: v.string(),
  tool: v.object({ command: v.array(v.string()) }),
});

test("prompt runs own separate traces and the emitted tool preserves related directions", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "reader-explain-run-"));
  const capturePath = path.join(directory, "capture.json");
  const corpus = {
    decisions: [SCHREMS_I, SCHREMS_II].map((ecli) => ({
      decisionId: ecli,
      ecli,
      paragraphs: [
        ...new Set(
          readerExplainCases
            .flatMap(({ selection, expectedCitation }) => [
              selection,
              expectedCitation,
            ])
            .filter((locator) => locator.ecli === ecli)
            .map(({ publisherParagraph }) => publisherParagraph),
        ),
      ].map((publisherParagraph) => ({
        publisherParagraph,
        paragraphId: `point${String(publisherParagraph)}`,
        text: "Synthetic public decision excerpt",
      })),
    })),
    edges: [{ citingDecisionId: SCHREMS_II, citedDecisionId: SCHREMS_I }],
  } satisfies v.InferOutput<typeof explainCorpusCaptureSchema>;
  writeFileSync(capturePath, JSON.stringify(corpus));
  const invoke = (args: string[]) =>
    spawnSync(
      process.execPath,
      [path.join(import.meta.dir, "reader-explain-local.ts"), ...args],
      { maxBuffer: 2 ** 30, encoding: "utf-8" },
    );
  const prompts = () => {
    const output = invoke(["prompts", capturePath]);
    expect(output.status, output.stderr).toBe(0);
    return output.stdout
      .trim()
      .split("\n")
      .map((line) => v.parse(promptSchema, JSON.parse(line)));
  };
  try {
    const previous = prompts();
    const previousPrompt = previous.at(0);
    if (!previousPrompt) {
      throw new TypeError("Previous Explain run emitted no prompts");
    }
    for (const prompt of previous) {
      expect(prompt.runId).toBe(previousPrompt.runId);
      expect(prompt.tracePath).toBe(previousPrompt.tracePath);
      const command = prompt.tool.command.slice(2);
      const output = spawnSync(process.execPath, command, {
        maxBuffer: 2 ** 30,
        encoding: "utf-8",
      });
      expect(output.status, output.stderr).toBe(0);
      const toolResult = v.parse(
        v.object({
          excerpts: v.array(
            v.object({ direction: v.picklist(["cited", "citing"]) }),
          ),
        }),
        JSON.parse(output.stdout),
      );
      const scenario = readerExplainCases.find(
        ({ id }) => id === prompt.caseId,
      );
      expect(scenario).toBeDefined();
      expect(toolResult.excerpts.at(0)?.direction).toBe(scenario?.direction);
    }
    const previousTraces = readFileSync(previousPrompt.tracePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => v.parse(explainToolTraceSchema, JSON.parse(line)));
    expect(previousTraces).toHaveLength(readerExplainCases.length);

    const current = prompts();
    const currentPrompt = current.at(0);
    if (!currentPrompt) {
      throw new TypeError("Current Explain run emitted no prompts");
    }
    expect(currentPrompt.runId).not.toBe(previousPrompt.runId);
    expect(currentPrompt.tracePath).not.toBe(previousPrompt.tracePath);
    expect(readFileSync(currentPrompt.tracePath, "utf-8")).toBe("");
    const resultPath = path.join(directory, "results.jsonl");
    const results = readerExplainCases.map((scenario) => ({
      runId: currentPrompt.runId,
      caseId: scenario.id,
      harness: "local",
      answer: "Synthetic explanation citing the expected related paragraph.",
      citations: [
        {
          decisionId: scenario.expectedCitation.ecli,
          paragraphId: `point${String(scenario.expectedCitation.publisherParagraph)}`,
        },
      ],
    }));
    writeFileSync(
      resultPath,
      results.map((result) => JSON.stringify(result)).join("\n"),
    );
    const staleScore = invoke([
      "score",
      capturePath,
      resultPath,
      previousPrompt.tracePath,
    ]);
    expect(staleScore.status, staleScore.stderr).toBe(1);
    const scores = staleScore.stdout
      .trim()
      .split("\n")
      .map((line) =>
        v.parse(
          v.object({ citationPass: v.boolean(), expectedCited: v.boolean() }),
          JSON.parse(line),
        ),
      );
    expect(scores).toHaveLength(readerExplainCases.length);
    expect(
      scores.every(
        ({ expectedCited, citationPass }) => expectedCited && !citationPass,
      ),
    ).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
