import { panic } from "better-result";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

const observationSchema = v.strictObject({
  kind: v.picklist(["http", "handler-context", "mcp"]),
  identity: v.pipe(v.string(), v.minLength(1)),
});
const journalSchema = v.strictObject({
  version: v.literal(1),
  observations: v.array(observationSchema),
});

type SuccessfulExecutionBatch = {
  label: string;
  testFiles: readonly string[];
  observations: v.InferOutput<typeof observationSchema>[];
};

export const readSuccessfulResponseConformanceBatch = (
  directory: string,
  provenance: { label: string; testFiles: readonly string[] },
): SuccessfulExecutionBatch => {
  const observations: v.InferOutput<typeof observationSchema>[] = [];
  const journals = readdirSync(directory);
  if (journals.length === 0) {
    panic("Successful batch did not emit a response conformance journal");
  }
  for (const file of journals) {
    const journal = v.parse(
      journalSchema,
      JSON.parse(readFileSync(path.join(directory, file), "utf-8")),
    );
    observations.push(...journal.observations);
  }
  return { ...provenance, observations };
};

type WriteExecutionReportOptions = {
  outputPath: string;
  successfulBatches: readonly SuccessfulExecutionBatch[];
  plannedBatches: number;
  complete: boolean;
  sourceRevision?: string | undefined;
};

/** Execution is a separate observation, never evidence for the PR's static ratchet. */
export const writeResponseConformanceExecutionReport = ({
  outputPath,
  successfulBatches,
  plannedBatches,
  complete,
  sourceRevision,
}: WriteExecutionReportOptions) => {
  const counts = (kind: v.InferOutput<typeof observationSchema>["kind"]) => {
    const identities = new Set<string>();
    for (const batch of successfulBatches) {
      for (const observation of batch.observations) {
        if (observation.kind !== kind) {
          continue;
        }
        identities.add(observation.identity);
      }
    }
    return identities.size;
  };
  const summary = {
    httpRouteTemplates: counts("http"),
    directHandlerContexts: counts("handler-context"),
    mcpTools: counts("mcp"),
  };
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    `${JSON.stringify(
      {
        version: 1,
        measure: "runtime-execution",
        completedAt: new Date().toISOString(),
        complete: complete && successfulBatches.length === plannedBatches,
        sourceRevision,
        plannedBatches,
        successfulBatches: successfulBatches.length,
        counts: summary,
        identitySources: {
          httpRouteTemplates:
            "matched method and route template across observed Elysia apps; not composed API census proof",
          directHandlerContexts: "context.route; not endpoint identity",
          mcpTools: "tool name",
        },
        batches: successfulBatches.toSorted((left, right) =>
          compareCodeUnit(left.label, right.label),
        ),
      },
      null,
      2,
    )}\n`,
  );
  return summary;
};
