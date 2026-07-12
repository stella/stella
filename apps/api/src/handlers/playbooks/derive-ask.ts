import { Result } from "better-result";
import * as v from "valibot";

import type { PropertyContent } from "@/api/db/schema-validators";
import type { GradedPosition } from "@/api/handlers/playbooks/position-runtime";
import type {
  PlaybookPositions,
  Position,
} from "@/api/handlers/playbooks/positions";
import { resolveCaching } from "@/api/lib/ai-config";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";

// Auto-ASK derivation (save-time). A graded position with `ask.mode === "auto"`
// derives its extraction question + content type from the issue and tier rules
// so run/review consume `derived` exactly like a manual ask. Derivation is
// gated on a `rulesHash` over the grading inputs: unchanged inputs skip the LLM
// call and reuse the stored `derived`. Derivation never blocks a save — a failed
// or timed-out call persists with `derived` absent, and run/review fall back to
// a generic text ask over the issue.

const DERIVE_ASK_TIMEOUT_MS = 20_000;
// Bound the per-save fan-out so a first save of a large playbook (up to 200
// positions) cannot burst an unbounded number of external calls at once.
const DERIVE_ASK_CONCURRENCY = 4;

// The derive-ask task shares the verdict grading role so both playbook AI paths
// resolve to the same model.
const DERIVE_ASK_ROLE = "pdf" as const;

const DERIVE_ASK_SYSTEM_PROMPT =
  "You turn a contract-review issue and its tiered rules into ONE extraction " +
  "question for reading a single value from a contract, plus that value's " +
  "content type. Return a concise question that captures WHAT to extract, not " +
  'how to grade it. Choose contentType "date" for a calendar date, "int" ' +
  'for a whole number or monetary amount, otherwise "text".';

const deriveAskSchema = v.strictObject({
  question: v.pipe(v.string(), v.maxLength(1000)),
  contentType: v.picklist(["text", "date", "int"]),
});

export type DeriveAskResult = v.InferOutput<typeof deriveAskSchema>;

const contentForType = (
  contentType: DeriveAskResult["contentType"],
): PropertyContent => ({ version: 1, type: contentType });

// The canonical grading inputs the derived question depends on, in stored order.
// Ideal language is deliberately excluded: it drives FIX, not what to extract.
const canonicalRulesInput = (position: GradedPosition) => ({
  issue: position.issue,
  acceptableRuleTexts: position.tiers.acceptable.rules.map((rule) => rule.text),
  fallbackTexts: position.tiers.fallback.entries.map((entry) => entry.text),
  notAcceptableRuleTexts: position.tiers.notAcceptable.rules.map(
    (rule) => rule.text,
  ),
  check: position.check ?? null,
});

export const computeRulesHash = (position: GradedPosition): string =>
  new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(canonicalRulesInput(position)))
    .digest("hex");

const buildDeriveAskUserMessage = (position: GradedPosition): string => {
  const { tiers } = position;
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

// The structured-output call that derives one ask. Injectable so callers (tests)
// can substitute it without a live model; the default runs the real LLM task.
export type DeriveAskGenerate = (input: {
  system: string;
  prompt: string;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
}) => Promise<DeriveAskResult>;

// Not destructured in the parameter: the ownership-id lint rule needs the
// branded type visible on the binding, which the aliased object type hides.
const defaultDeriveAskGenerate: DeriveAskGenerate = async (input) => {
  const { system, prompt, organizationId, orgAIConfig, promptCachingEnabled } =
    input;
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    feature: "playbook.derive-ask",
    modelRole: DERIVE_ASK_ROLE,
    orgAIConfig,
    properties: { organization_id: organizationId },
    traceId: Bun.randomUUIDv7(),
  });

  try {
    return await generateTanStackObjectForRole({
      role: DERIVE_ASK_ROLE,
      orgAIConfig,
      organizationId,
      analytics: aiAnalytics,
      caching: resolveCaching({
        promptCachingEnabled,
        role: DERIVE_ASK_ROLE,
        scopeKey: null,
      }),
      serviceTier: "standard",
      system,
      prompt,
      abortSignal: AbortSignal.timeout(DERIVE_ASK_TIMEOUT_MS),
      outputSchema: deriveAskSchema,
    });
  } catch (error) {
    // Boundary capture: the caller turns the failure into a `derived`-absent
    // save; capture telemetry here before it is swallowed there.
    aiAnalytics.captureError(error);
    throw error;
  }
};

export type DeriveAutoAsksDeps = {
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  // Test seam; defaults to the real structured-output call.
  generate?: DeriveAskGenerate;
};

// A graded position whose ask is `auto` and needs (re)derivation: no stored
// `derived`, or its `rulesHash` no longer matches the current grading inputs.
const needsDerivation = (
  position: GradedPosition,
  rulesHash: string,
): boolean => {
  if (position.ask.mode !== "auto") {
    return false;
  }
  return position.ask.derived?.rulesHash !== rulesHash;
};

const deriveOne = async (
  position: GradedPosition,
  rulesHash: string,
  deps: DeriveAutoAsksDeps,
  generate: DeriveAskGenerate,
): Promise<Position> => {
  const derived = await Result.tryPromise({
    try: async () =>
      await generate({
        system: DERIVE_ASK_SYSTEM_PROMPT,
        prompt: buildDeriveAskUserMessage(position),
        organizationId: deps.organizationId,
        orgAIConfig: deps.orgAIConfig,
        promptCachingEnabled: deps.promptCachingEnabled,
      }),
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
      derived: {
        question: derived.value.question,
        content: contentForType(derived.value.contentType),
        rulesHash,
      },
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
  const pending: { index: number; position: GradedPosition; hash: string }[] =
    [];
  for (const [index, position] of positions.items.entries()) {
    if (position.mode !== "graded") {
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
  for (
    let cursor = 0;
    cursor < pending.length;
    cursor += DERIVE_ASK_CONCURRENCY
  ) {
    const chunk = pending.slice(cursor, cursor + DERIVE_ASK_CONCURRENCY);
    // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop -- sequential chunk drain bounds the per-save derive-ask fan-out
    const derived = await Promise.all(
      chunk.map(async ({ index, position, hash }) => ({
        index,
        position: await deriveOne(position, hash, deps, generate),
      })),
    );
    for (const { index, position } of derived) {
      items[index] = position;
    }
  }

  return { version: 2, items };
};
