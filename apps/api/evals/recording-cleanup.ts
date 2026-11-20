/**
 * Runs the recording cleanup prompt against real models and prints what
 * each answers, with what the server's acceptance check makes of it, beside
 * the expected text when a sample has one. A person reads the output; there
 * is no score.
 *
 * It calls paid models with the instance credentials in `.env`, so it runs
 * on demand, never in CI. The committed samples are synthetic. Real
 * transcripts stay in a local file outside the repository, passed with
 * `--samples`.
 *
 *   bun run eval:recording-cleanup -- --models claude-opus-5-5
 *   bun run eval:recording-cleanup -- --models a,b --samples ~/private/recordings.json --json /tmp/out.json
 */
import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import * as v from "valibot";

import { desktopDictationRecordingCleanupRequestSchema } from "@stll/api-contract/desktop-dictation-cleanup";

import { toSafeId } from "@/api/lib/branded-types";
import { admitFixtureModelDispatch } from "@/api/lib/rate-limit/model-dispatch-admission";
import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";

import {
  acceptRecordingCleanup,
  buildRecordingCleanupPrompt,
  RECORDING_CLEANUP_OUTPUT_TOKENS,
  RECORDING_CLEANUP_SYSTEM_PROMPT,
  recordingCleanupModelOutputSchema,
} from "../src/handlers/dictation/recording-cleanup-model";
import { resolveModelTargets } from "./lib/org-model-targets";

const USAGE =
  "Usage: bun run eval:recording-cleanup -- --models <id[,id…]> [--samples <file.json>] [--json <out.json>]";
const DEFAULT_SAMPLES = path.join(
  import.meta.dir,
  "fixtures/recording-cleanup-samples.json",
);
const EVAL_ORGANIZATION_ID = toSafeId<"organization">("eval-org");
const REQUEST_TIMEOUT_MS = 180_000;

/** A sample: the request the desktop would send, and optionally the answer
 *  a careful typist would give. */
const sampleSchema = v.object({
  id: v.string(),
  expected: v.optional(
    v.object({ instructions: v.array(v.string()), markdown: v.string() }),
  ),
  ...desktopDictationRecordingCleanupRequestSchema.entries,
});
type Sample = v.InferOutput<typeof sampleSchema>;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    models: { type: "string" },
    samples: { type: "string" },
    json: { type: "string" },
  },
  strict: true,
});
const models = (values.models ?? "")
  .split(",")
  .map((model) => model.trim())
  .filter((model) => model !== "");
if (models.length === 0) {
  panic(USAGE);
}
const samples: Sample[] = v.parse(
  v.array(sampleSchema),
  JSON.parse(readFileSync(values.samples ?? DEFAULT_SAMPLES, "utf-8")),
);

type RunRecord = {
  model: string;
  sample: string;
  latencyMs: number;
  outcome: string;
  output: unknown;
};

const runSample = async (
  model: string,
  orgAIConfig: Parameters<
    typeof generateTanStackObjectForTask
  >[0]["orgAIConfig"],
  { id, expected: _expected, ...request }: Sample,
): Promise<RunRecord> => {
  const started = performance.now();
  try {
    const output = await generateTanStackObjectForTask({
      dataClass: "customer",
      // An offline evaluation runs no admission: it mints the proof itself.
      admission: admitFixtureModelDispatch({
        userId: null,
        organizationId: EVAL_ORGANIZATION_ID,
        actionKind: "dictation.cleanup",
        modelTier: MANAGED_MODEL_TIER.standard,
      }),
      userId: null,
      organizationId: EVAL_ORGANIZATION_ID,
      orgAIConfig,
      task: "chat",
      serviceTier: "standard",
      caching: { enabled: false, reason: "org-disabled" },
      tenantWorkspaceIds: [],
      deadlineMs: REQUEST_TIMEOUT_MS,
      systemPromptOrigin: "server-built",
      system: RECORDING_CLEANUP_SYSTEM_PROMPT,
      prompt: buildRecordingCleanupPrompt(request),
      outputSchema: recordingCleanupModelOutputSchema,
      outputTokenBudget: RECORDING_CLEANUP_OUTPUT_TOKENS,
    });
    const accepted = acceptRecordingCleanup(output, request.transcript);
    return {
      model,
      sample: id,
      latencyMs: Math.round(performance.now() - started),
      outcome: accepted.isOk() ? "accepted" : `refused: ${accepted.error}`,
      output: accepted.isOk() ? accepted.value : output,
    };
  } catch (error) {
    return {
      model,
      sample: id,
      latencyMs: Math.round(performance.now() - started),
      outcome: `failed: ${error instanceof Error ? error.message : String(error)}`,
      output: null,
    };
  }
};

const records: RunRecord[] = [];
for (const target of resolveModelTargets(models)) {
  if (target.type === "resolution-error") {
    console.log(`## ${target.id}\n\n${target.message}\n`);
    continue;
  }
  console.log(`## ${target.id}\n`);
  for (const sample of samples) {
    const record = await runSample(target.id, target.orgAIConfig, sample);
    records.push(record);
    console.log(
      `### ${sample.id} (${record.outcome}, ${String(record.latencyMs)} ms)\n`,
    );
    console.log(JSON.stringify(record.output, null, 2));
    if (sample.expected !== undefined) {
      console.log(`\nexpected:\n${JSON.stringify(sample.expected, null, 2)}\n`);
    }
  }
}
const accepted = records.filter(({ outcome }) => outcome === "accepted");
console.log(
  `${String(accepted.length)}/${String(records.length)} answers accepted`,
);
if (values.json !== undefined) {
  writeFileSync(values.json, `${JSON.stringify(records, null, 2)}\n`);
}
