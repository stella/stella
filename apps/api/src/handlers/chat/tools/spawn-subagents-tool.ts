import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";
import * as v from "valibot";

import type { SafeDb } from "@/api/db/safe-db";
import { env } from "@/api/env";
import { createChatTextPart } from "@/api/handlers/chat/chat-message-parts";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import type { ChatToolMap } from "@/api/handlers/chat/tools/chat-tool-types";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { ChatMessage } from "@/api/handlers/chat/types";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { SafeId } from "@/api/lib/branded-types";
import { runSubagent } from "@/api/lib/tanstack-ai-agent";
import {
  getTanStackTextModelInfoForRole,
  isAllowedBYOKModelForRole,
  resolveEffectiveServiceTierForProvider,
} from "@/api/lib/tanstack-ai-models";
import { computeUsageUnitCost } from "@/api/lib/usage/action-weights";
import { assertUsageAvailable } from "@/api/lib/usage/usage-ledger";

export const SPAWN_SUBAGENTS_TOOL_NAME = "spawn_subagents";

/**
 * Nested delegation is one level deep: a top-level turn (depth 0) may
 * spawn subagents (running at depth 1), but a subagent's own toolset
 * never includes `spawn_subagents` — see `projectToolMapForSubagent`
 * in `subagent-tools.ts`, which strips it unconditionally, and
 * `chat-tools.ts`, which only registers the tool while
 * `delegationDepth < SUBAGENT_DELEGATION_DEPTH_CAP`.
 */
export const SUBAGENT_DELEGATION_DEPTH_CAP = 1;

/** Upper bound on how many subtasks one `spawn_subagents` call may batch. */
export const MAX_SUBAGENTS_PER_CALL = 8;

/** Step budget for each subagent's own nested agentic loop. */
export const SUBAGENT_MAX_STEPS = 25;

/**
 * Wall-clock cap applied only when the tool context provides no `abortSignal`
 * (it normally does — the parent `chat()` run threads one through). Without it,
 * the fallback would be a signal that never fires, so a subagent could run
 * unbounded if the parent were ever cancelled with no signal to forward.
 */
const SUBAGENT_FALLBACK_TIMEOUT_MS = 300_000;

const spawnSubagentsInputSchema = v.strictObject({
  subagents: v.pipe(
    v.array(
      v.strictObject({
        task: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(4000),
          v.description("The subtask for this subagent to complete."),
        ),
        context: v.optional(
          v.pipe(
            v.string(),
            v.maxLength(4000),
            v.description("Optional background/context the subagent needs."),
          ),
        ),
        expectedOutput: v.optional(
          v.pipe(
            v.string(),
            v.maxLength(1000),
            v.description(
              "Optional description of the result shape you want back.",
            ),
          ),
        ),
        model: v.optional(
          v.pipe(
            v.string(),
            v.description(
              "Optional exact model id; omit to use the default fast tier.",
            ),
          ),
        ),
      }),
    ),
    v.minLength(1),
    v.maxLength(MAX_SUBAGENTS_PER_CALL),
    v.description(
      "One or more independent subtasks to run in parallel on cheap subagents.",
    ),
  ),
});

// A discriminated union (not shared optional `result`/`error` fields):
// exactly one of them is meaningful per status, and every producer
// (`runOneSubagent` below) and consumer (`SpawnSubagentsCard` on the
// frontend) already branches on `status` first.
const spawnSubagentsResultSchema = v.variant("status", [
  v.strictObject({
    index: v.number(),
    status: v.literal("completed"),
    result: v.string(),
  }),
  v.strictObject({
    index: v.number(),
    status: v.literal("failed"),
    error: v.string(),
  }),
]);

const spawnSubagentsOutputSchema = v.strictObject({
  results: v.array(spawnSubagentsResultSchema),
});

export type SpawnSubagentsToolInput = v.InferOutput<
  typeof spawnSubagentsInputSchema
>;
export type SpawnSubagentsToolOutput = v.InferOutput<
  typeof spawnSubagentsOutputSchema
>;

type SubagentSpec = SpawnSubagentsToolInput["subagents"][number];

/**
 * Brief on purpose (see Jan's "keep system prompts brief" preference):
 * the subagent gets just enough framing to act autonomously, plus the
 * caller's optional shape hint.
 */
const buildSubagentSystemPrompt = (expectedOutput?: string): string => {
  const base =
    "You are a subagent completing one delegated subtask inside stella, a legal workspace. " +
    "You have read/write tools available but no direct user interaction — never ask the user a question; make reasonable assumptions and proceed. " +
    "Return a concise final result summarizing what you did and the output the caller needs.";
  return expectedOutput
    ? `${base} Return output matching: ${expectedOutput}`
    : base;
};

type BuildSubagentUserMessageProps = {
  task: string;
  context?: string | undefined;
};

const buildSubagentUserMessage = ({
  task,
  context,
}: BuildSubagentUserMessageProps): ChatMessage => ({
  id: Bun.randomUUIDv7(),
  role: "user",
  parts: [
    createChatTextPart(context ? `${task}\n\nContext:\n${context}` : task),
  ],
});

type SubagentModelInfo = ReturnType<typeof getTanStackTextModelInfoForRole>;

type ResolveValidatedSubagentModelIdArgs = {
  subModel: string | undefined;
  modelInfo: SubagentModelInfo;
};

/**
 * Validate a model-generated `sub.model` override against what the org is
 * actually entitled to, given the fast role's resolved model info. Returns the
 * override only when it is safe to use, else `undefined` (a silent fall back to
 * the fast default). `getTanStackTextModelById` does not allowlist model ids,
 * so without this a prompted override could run an arbitrary, possibly
 * expensive model — under the organization's own key on a platform-key deploy.
 * Provider-qualified overrides (`provider::modelId`) are rejected outright (they
 * can switch which stored key is used); with a real BYOK key the override must
 * be in the curated catalog for the role; on a platform key it must match the
 * configured fast model exactly.
 */
export const resolveValidatedSubagentModelId = ({
  subModel,
  modelInfo,
}: ResolveValidatedSubagentModelIdArgs): string | undefined => {
  if (!subModel) {
    return undefined;
  }
  if (subModel.includes("::")) {
    return undefined;
  }
  if (modelInfo.keySource === "byok") {
    return isAllowedBYOKModelForRole({
      provider: modelInfo.provider,
      modelId: subModel,
      role: "fast",
    })
      ? subModel
      : undefined;
  }
  return subModel === modelInfo.modelId ? subModel : undefined;
};

type SubagentBatchPreflightResult =
  | { ok: true }
  | { ok: false; message: string };

type PreflightSubagentBatchUsageArgs = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  fastModelInfo: SubagentModelInfo;
  subtaskCount: number;
};

/**
 * Batch-level usage pre-flight for the whole `spawn_subagents` call.
 *
 * `recordUsageEvent({ actionType: "subagent" })` (see `runSubagent` /
 * `createTanStackAIAnalyticsCallbacks`) deliberately never checks balance —
 * that's the pre-flight's job, same split as everywhere else in the usage
 * ledger. The route-level `requiresUsage` pre-flight only covers the single
 * parent `chat` unit; without a check here, a single tool call could
 * dispatch up to `MAX_SUBAGENTS_PER_CALL` metered model runs against an org
 * that is already at (or over) its cap.
 *
 * Mirrors `resolveMeteringContext` in `api-handlers.ts`: same BYOK
 * detection (`keySource === "byok"` zeroes the unit cost — the org's own
 * key pays, not the platform), same `resolveEffectiveServiceTierForProvider`
 * call, same `computeUsageUnitCost` inputs. The one difference is the `*
 * subtaskCount` multiplier, since this single tool call fans out into that
 * many separate metered subagent runs.
 */
const preflightSubagentBatchUsage = async ({
  safeDb,
  organizationId,
  fastModelInfo,
  subtaskCount,
}: PreflightSubagentBatchUsageArgs): Promise<SubagentBatchPreflightResult> => {
  if (!env.USAGE_ENFORCEMENT_ENABLED) {
    return { ok: true };
  }

  const serviceTier = resolveEffectiveServiceTierForProvider({
    provider: fastModelInfo.provider,
    region: fastModelInfo.region,
    serviceTier: "standard",
  });
  const isByok = fastModelInfo.keySource === "byok";
  const unitCost = computeUsageUnitCost({
    actionType: "subagent",
    serviceTier,
    isByok,
  });
  const required = unitCost * subtaskCount;
  if (required <= 0) {
    return { ok: true };
  }

  const checkResult = await safeDb(
    async (tx) => await assertUsageAvailable({ tx, organizationId, required }),
  );

  // A DB failure during pre-flight is treated the same as insufficient
  // balance: fail closed rather than let a billing check we couldn't run
  // wave the batch through.
  if (Result.isError(checkResult)) {
    return {
      ok: false,
      message: "Unable to verify usage availability; try again.",
    };
  }

  const check = checkResult.value;
  if (check.ok) {
    return { ok: true };
  }

  return { ok: false, message: check.error.message };
};

type CreateSpawnSubagentsToolProps = {
  /** Lazily builds the (already depth+1, already projected) subagent toolset. */
  buildSubagentToolset: () => ChatToolMap;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  safeDb: SafeDb;
  userId: SafeId<"user">;
  /** The request's scope workspace, for subagent metering — may be null (global chat). */
  workspaceId: SafeId<"workspace"> | null;
  /** Metering sessionId. */
  threadId: SafeId<"chatThread">;
  /** Current delegation depth (0 at top level); subagents run at depth + 1. */
  delegationDepth: number;
  thirdPartyBoundary: ChatThirdPartyBoundary;
};

export const createSpawnSubagentsTool = (
  props: CreateSpawnSubagentsToolProps,
) => ({
  [SPAWN_SUBAGENTS_TOOL_NAME]: toolDefinition({
    name: SPAWN_SUBAGENTS_TOOL_NAME,
    description:
      "Delegate independent subtasks to parallel subagents. Use this when a " +
      "task splits into pieces that do not depend on each other's results — " +
      "each subagent runs its own read/write tool loop concurrently and " +
      "reports back a short result or an error. Prefer this over doing " +
      "independent work serially yourself; it is cheaper and faster. Do not " +
      "use it for a single sequential task, or when later steps depend on " +
      "an earlier subagent's output.",
    inputSchema: toTanStackToolSchema(spawnSubagentsInputSchema),
    outputSchema: toTanStackToolSchema(spawnSubagentsOutputSchema),
  }).server(async ({ subagents }, ctx) => {
    const tools = props.buildSubagentToolset();

    // Resolve the fast role's model info once for the whole batch; each
    // per-subagent `model` override is validated against it.
    const fastModelInfo = getTanStackTextModelInfoForRole(
      "fast",
      props.orgAIConfig,
      { organizationId: props.organizationId },
    );

    // Whole-batch pre-flight: dispatches nothing (no provider calls, no
    // usage events) when the org cannot afford every subtask in this call.
    const batchPreflight = await preflightSubagentBatchUsage({
      fastModelInfo,
      organizationId: props.organizationId,
      safeDb: props.safeDb,
      subtaskCount: subagents.length,
    });
    if (!batchPreflight.ok) {
      return {
        results: subagents.map((_sub, index) => ({
          index,
          status: "failed" as const,
          error: batchPreflight.message,
        })),
      };
    }

    const runOneSubagent = async (sub: SubagentSpec, index: number) => {
      try {
        const { text } = await runSubagent({
          organizationId: props.organizationId,
          orgAIConfig: props.orgAIConfig,
          role: "fast",
          modelId: resolveValidatedSubagentModelId({
            subModel: sub.model,
            modelInfo: fastModelInfo,
          }),
          system: buildSubagentSystemPrompt(sub.expectedOutput),
          messages: [
            buildSubagentUserMessage({ task: sub.task, context: sub.context }),
          ],
          tools,
          abortSignal:
            ctx?.abortSignal ??
            AbortSignal.timeout(SUBAGENT_FALLBACK_TIMEOUT_MS),
          maxSteps: SUBAGENT_MAX_STEPS,
          delegationDepth: props.delegationDepth + 1,
          metering: {
            safeDb: props.safeDb,
            userId: props.userId,
            workspaceId: props.workspaceId,
            serviceTier: "standard",
            feature: "subagent",
            sessionId: props.threadId,
            traceId: Bun.randomUUIDv7(),
          },
          thirdPartyBoundary: props.thirdPartyBoundary,
        });
        return { index, status: "completed" as const, result: text };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        return {
          index,
          status: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    };

    // The boundary holds cumulative mutable anonymization state
    // (`redactionMap`, `placeholderOffsets`), so concurrent subagents
    // sharing it would race on those maps. Run sequentially in
    // anonymized mode; parallelism is safe (and preserved) otherwise.
    if (props.thirdPartyBoundary.type === "anonymized") {
      const results: Awaited<ReturnType<typeof runOneSubagent>>[] = [];
      for (const [index, sub] of subagents.entries()) {
        // eslint-disable-next-line no-await-in-loop -- sequential by design: parallel subagents would race the anonymization boundary's shared mutable redaction state
        results.push(await runOneSubagent(sub, index));
      }
      return { results };
    }

    const results = await Promise.all(subagents.map(runOneSubagent));

    return { results };
  }),
});
