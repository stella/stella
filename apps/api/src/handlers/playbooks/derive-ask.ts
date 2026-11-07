import { panic, Result } from "better-result";
import * as v from "valibot";

import { chunk as chunkItems } from "@stll/concurrency/chunk";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import type { ScalarPropertyContent } from "@/api/db/schema-validators";
import { resolveCaching } from "@/api/lib/ai-config";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { OrgAIConfigStatus } from "@/api/lib/ai-config-loader-core";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { logger } from "@/api/lib/observability/logger";
import type { ModelActionAdmitter } from "@/api/lib/rate-limit/model-action-admission";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import type {
  PlaybookPositions,
  Position,
} from "@/api/lib/workflow/playbook-positions";
import {
  canonicalRulesInput,
  isTierStandard,
} from "@/api/lib/workflow/position-runtime";
import type { TierStandardPosition } from "@/api/lib/workflow/position-runtime";

// Auto-ASK derivation (save-time). A graded position with `ask.mode === "auto"`
// derives its extraction question from the issue and tier rules so run/review
// consume `derived` exactly like a manual ask. The position's check decides the
// content type: a tier match reads the clause's wording and a presence check
// reads whether there is any, so both store text; only a constraint compares a
// number or date, so only a constraint lets the model choose a type. Derivation
// is gated on a `rulesHash` over the grading inputs: unchanged inputs skip the
// LLM call and reuse the stored `derived`. Derivation never blocks a save — a
// failed or timed-out call persists with `derived` absent, and run/review fall
// back to a generic text ask over the issue.

const DERIVE_ASK_TIMEOUT_MS = 20_000;
// Bound the per-save fan-out so a first save of a large playbook (up to 200
// positions) cannot burst an unbounded number of external calls at once.
const DERIVE_ASK_CONCURRENCY = 4;

// The derive-ask task shares the verdict grading task so both playbook AI paths
// resolve to the same model.
const DERIVE_ASK_TASK = "pdf" as const;

export const DERIVE_CLAUSE_ASK_SYSTEM_PROMPT =
  "You turn a contract-review issue and its tiered rules into ONE extraction " +
  "question. A reviewer will judge the contract against every rule while seeing " +
  "only the answer to your question, so the question must ask for the contract's " +
  "own wording on every term the rules cover, naming each term. Never narrow it " +
  "to a single value. Ask WHAT the contract says, not whether it meets a rule, " +
  "and do not mention the rules, tiers, or grading. Ask for the wording to be " +
  "quoted verbatim and in full, at whatever length that takes, with no commentary " +
  "and nothing said about a term the contract does not address, and for no answer " +
  "at all when the contract does not address the issue. Write the question in " +
  "the language of the issue, in under 800 characters.";

export const DERIVE_CONSTRAINT_ASK_SYSTEM_PROMPT =
  "You turn a contract-review issue and its tiered rules into ONE extraction " +
  "question for reading a single value from a contract, plus that value's " +
  "content type. Return a concise question that captures WHAT to extract, not " +
  'how to grade it. Choose contentType "date" for a calendar date, "int" ' +
  'for a whole number or monetary amount, otherwise "text".';

/** Read by the structured-output role contract test. @public */
export const deriveClauseAskSchema = v.strictObject({
  question: v.pipe(v.string(), v.maxLength(1000)),
});

/** Read by the structured-output role contract test. @public */
export const deriveConstraintAskSchema = v.strictObject({
  question: v.pipe(v.string(), v.maxLength(1000)),
  contentType: v.picklist(["text", "date", "int"]),
});

export type DeriveClauseAskResult = v.InferOutput<typeof deriveClauseAskSchema>;
export type DeriveConstraintAskResult = v.InferOutput<
  typeof deriveConstraintAskSchema
>;

export const computeRulesHash = (position: TierStandardPosition): string =>
  hashSha256Hex(JSON.stringify(canonicalRulesInput(position)));

const buildDeriveAskUserMessage = (position: TierStandardPosition): string => {
  const { tiers } = position.standard;
  const lines = [`Issue: ${position.issue}`];
  if (tiers.acceptable.rules.length > 0) {
    lines.push("", "Acceptable rules:");
    for (const rule of tiers.acceptable.rules) {
      lines.push(`- ${rule.text}`);
    }
  }
  if (tiers.fallback.entries.length > 0) {
    lines.push("", "Fallback options:");
    for (const entry of tiers.fallback.entries) {
      lines.push(`- ${entry.text}`);
    }
  }
  if (tiers.notAcceptable.rules.length > 0) {
    lines.push("", "Not-acceptable rules:");
    for (const rule of tiers.notAcceptable.rules) {
      lines.push(`- ${rule.text}`);
    }
  }
  return lines.join("\n");
};

export type DeriveAskInput = {
  admission: ModelDispatchAdmission;
  system: string;
  prompt: string;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  promptCachingEnabled: boolean;
};

// The structured-output calls that derive one ask, one per shape. Injectable so
// callers (tests) can substitute them without a live model; the defaults run the
// real LLM task.
export type DeriveAskGenerate = {
  clause: (input: DeriveAskInput) => Promise<DeriveClauseAskResult>;
  constraint: (input: DeriveAskInput) => Promise<DeriveConstraintAskResult>;
};

const deriveAskAnalytics = ({
  admission,
  organizationId,
  orgAIConfig,
}: DeriveAskInput) =>
  createTanStackAIAnalyticsCallbacks({
    dataClass: "customer",
    feature: "playbook.derive-ask",
    modelTask: DERIVE_ASK_TASK,
    organizationId,
    orgAIConfig,
    modelTier: admission.modelTier,
    properties: { organization_id: organizationId },
    traceId: Bun.randomUUIDv7(),
  });

const deriveAskRequest = (
  {
    admission,
    system,
    prompt,
    organizationId,
    orgAIConfig,
    managedAIResidency,
    promptCachingEnabled,
  }: DeriveAskInput,
  analytics: ReturnType<typeof deriveAskAnalytics>,
) => ({
  userId: admission.userId,
  dataClass: "customer" as const,
  task: DERIVE_ASK_TASK,
  orgAIConfig,
  managedAIResidency,
  organizationId,
  admission,
  // DeriveAskInput carries no workspace id; playbook grading runs at
  // organization scope.
  tenantWorkspaceIds: [],
  analytics,
  caching: resolveCaching({
    promptCachingEnabled,
    task: DERIVE_ASK_TASK,
    scopeKey: null,
  }),
  serviceTier: "standard" as const,
  system,
  prompt,
  deadlineMs: DERIVE_ASK_TIMEOUT_MS,
});

const withDeriveAskRequest = async <TResult>(
  input: DeriveAskInput,
  generateObject: (
    request: ReturnType<typeof deriveAskRequest>,
  ) => Promise<TResult>,
): Promise<TResult> => {
  const aiAnalytics = deriveAskAnalytics(input);
  try {
    return await generateObject(deriveAskRequest(input, aiAnalytics));
  } catch (error) {
    // Boundary capture: the caller turns the failure into a `derived`-absent
    // save; capture telemetry here before it is swallowed there.
    aiAnalytics.captureError(error);
    throw error;
  }
};

const defaultDeriveAskGenerate: DeriveAskGenerate = {
  clause: async (input) =>
    await withDeriveAskRequest(
      input,
      async (request) =>
        await generateTanStackObjectForTask({
          ...request,
          outputSchema: deriveClauseAskSchema,
        }),
    ),
  constraint: async (input) =>
    await withDeriveAskRequest(
      input,
      async (request) =>
        await generateTanStackObjectForTask({
          ...request,
          outputSchema: deriveConstraintAskSchema,
        }),
    ),
};

export type DeriveAutoAsksDeps = {
  /** Admits the derivations of one save as one action, only when any runs. */
  admitModelAction: ModelActionAdmitter;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency | null;
  orgAIConfigStatus: OrgAIConfigStatus;
  promptCachingEnabled: boolean | null;
  // Test seam; defaults to the real structured-output call.
  generate?: DeriveAskGenerate;
};

// A graded position whose ask is `auto` and needs (re)derivation: no stored
// `derived`, or its `rulesHash` no longer matches the current grading inputs.
const needsDerivation = (
  position: TierStandardPosition,
  rulesHash: string,
): boolean => {
  if (position.ask.mode !== "auto") {
    return false;
  }
  return position.ask.derived?.rulesHash !== rulesHash;
};

type DerivedAsk = { question: string; content: ScalarPropertyContent };

const deriveAskForCheck = async (
  position: TierStandardPosition,
  input: Omit<DeriveAskInput, "system" | "prompt">,
  generate: DeriveAskGenerate,
): Promise<DerivedAsk> => {
  const prompt = buildDeriveAskUserMessage(position);
  const kind = position.check?.kind;
  switch (kind) {
    case undefined:
    case "presence": {
      const { question } = await generate.clause({
        ...input,
        system: DERIVE_CLAUSE_ASK_SYSTEM_PROMPT,
        prompt,
      });
      return { question, content: { version: 1, type: "text" } };
    }
    case "constraint": {
      const { question, contentType } = await generate.constraint({
        ...input,
        system: DERIVE_CONSTRAINT_ASK_SYSTEM_PROMPT,
        prompt,
      });
      return { question, content: { version: 1, type: contentType } };
    }
    default:
      kind satisfies never;
      return panic(`Unhandled position check: ${String(kind)}`);
  }
};

type DeriveOneOptions = {
  admission: ModelDispatchAdmission;
  deps: DeriveAutoAsksDeps & {
    managedAIResidency: ManagedAIResidency;
    promptCachingEnabled: boolean;
  };
  generate: DeriveAskGenerate;
  position: TierStandardPosition;
  rulesHash: string;
};

const deriveOne = async ({
  admission,
  deps,
  generate,
  position,
  rulesHash,
}: DeriveOneOptions): Promise<Position> => {
  const derived = await Result.tryPromise({
    try: async () =>
      await deriveAskForCheck(
        position,
        {
          admission,
          organizationId: deps.organizationId,
          orgAIConfig: deps.orgAIConfig,
          managedAIResidency: deps.managedAIResidency,
          promptCachingEnabled: deps.promptCachingEnabled,
        },
        generate,
      ),
    catch: (error) => error,
  });

  if (Result.isError(derived)) {
    // Never block a save on the derivation call: persist with `derived` absent
    // (dropping any now-stale value) so run/review fall back to a generic ask.
    logger.warn("Playbook auto-ASK derivation failed", {
      organization_id: deps.organizationId,
      feature: "playbook.derive-ask",
    });
    return { ...position, ask: { mode: "auto" } };
  }

  return {
    ...position,
    ask: {
      mode: "auto",
      derived: { ...derived.value, rulesHash },
    },
  };
};

// Derive (or refresh) the auto asks in a positions payload before it is
// persisted. Positions that are not graded, not `auto`, or whose grading inputs
// are unchanged pass through untouched. Bounded concurrency caps the per-save
// external-call fan-out.
export const deriveAutoAsks = async (
  positions: PlaybookPositions,
  deps: DeriveAutoAsksDeps,
): Promise<PlaybookPositions> => {
  const generate = deps.generate ?? defaultDeriveAskGenerate;
  const pending: {
    index: number;
    position: TierStandardPosition;
    hash: string;
  }[] = [];
  for (const [index, position] of positions.items.entries()) {
    // A reference standard has no rules to derive an ASK from; its grading
    // reads the target document against the pinned passages instead.
    if (!isTierStandard(position)) {
      continue;
    }
    const hash = computeRulesHash(position);
    if (needsDerivation(position, hash)) {
      pending.push({ index, position, hash });
    }
  }

  if (pending.length === 0) {
    return positions;
  }

  const items = [...positions.items];

  // A stored config that did not decrypt, or an org barred from the instance
  // provider, reads as `orgAIConfig: null`, which would resolve to the
  // instance provider: the org's derivations would run on the shared key and
  // be metered there. Make no call instead, and persist as a failed derivation
  // does (`derived` absent, dropping any stale value), so the save is kept and
  // the next one derives once the config is usable.
  if (
    deps.orgAIConfigStatus !== ORG_AI_CONFIG_STATUS.ok ||
    deps.managedAIResidency === null ||
    deps.promptCachingEnabled === null
  ) {
    logger.warn("Playbook auto-ASK derivation skipped: AI config unusable", {
      organization_id: deps.organizationId,
      feature: "playbook.derive-ask",
      status: deps.orgAIConfigStatus,
    });
    for (const { index, position } of pending) {
      items[index] = { ...position, ask: { mode: "auto" } };
    }
    return { version: 3, items };
  }

  const readyDeps = {
    ...deps,
    managedAIResidency: deps.managedAIResidency,
    promptCachingEnabled: deps.promptCachingEnabled,
  };
  const admitted = await deps.admitModelAction(async ({ admission }) => {
    for (const chunk of chunkItems(pending, DERIVE_ASK_CONCURRENCY)) {
      const derived = await Promise.all(
        chunk.map(async ({ index, position, hash }) => ({
          index,
          position: await deriveOne({
            admission,
            deps: readyDeps,
            generate,
            position,
            rulesHash: hash,
          }),
        })),
      );
      for (const { index, position } of derived) {
        items[index] = position;
      }
    }
  });
  if (Result.isError(admitted)) {
    // A refused action is a skipped derivation: the save keeps its positions
    // with `derived` absent, like a failed call.
    logger.warn("Playbook auto-ASK derivation not admitted", {
      organization_id: deps.organizationId,
      feature: "playbook.derive-ask",
    });
    for (const { index, position } of pending) {
      items[index] = { ...position, ask: { mode: "auto" } };
    }
  }

  return { version: 3, items };
};
