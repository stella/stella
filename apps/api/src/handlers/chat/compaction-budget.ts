/**
 * Per-thread compaction budget: resolves the chat model the next send would
 * use, maps it through the catalog's documented context window, and derives
 * the compaction trigger plus the proportionally-scaled preserved tail.
 *
 * Split from `compaction.ts` (pure token math) so that module stays free of
 * provider/model-resolution dependencies. Used by both the send path (to gate
 * and drive checkpointing) and the read path (to size the context meter), so a
 * thread's meter denominator matches the trigger its next send will apply.
 */
import { getContextWindowTokens } from "@stll/ai-catalog";

import {
  resolveCompactionTriggerTokens,
  resolvePreserveTokensForTrigger,
} from "@/api/handlers/chat/compaction";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { SafeId } from "@/api/lib/branded-types";
import { getTanStackTextModelInfoForRole } from "@/api/lib/tanstack-ai-models";

export type ChatCompactionBudget = {
  triggerTokens: number;
  preserveTokens: number;
};

type ResolveChatCompactionBudgetOptions = {
  /** Dev-only model override (`body.devModelId`); absent on the read path. */
  devModelId?: string | undefined;
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
};

/**
 * Trigger + preserve budget for a thread, keyed off the resolved chat model's
 * context window. Never throws: an unconfigured/unsupported chat model degrades
 * to the historical default trigger so compaction and the meter keep working.
 */
export const resolveChatCompactionBudget = (
  options: ResolveChatCompactionBudgetOptions,
): ChatCompactionBudget => {
  const triggerTokens = resolveCompactionTriggerTokens(
    resolveChatContextWindowTokens(options),
  );
  return {
    triggerTokens,
    preserveTokens: resolvePreserveTokensForTrigger(triggerTokens),
  };
};

const resolveChatContextWindowTokens = (
  options: ResolveChatCompactionBudgetOptions,
): number | undefined => {
  const modelId = resolveChatModelId(options);
  return modelId === undefined ? undefined : getContextWindowTokens(modelId);
};

const resolveChatModelId = ({
  devModelId,
  orgAIConfig,
  organizationId,
}: ResolveChatCompactionBudgetOptions): string | undefined => {
  if (devModelId) {
    return devModelId;
  }

  try {
    return getTanStackTextModelInfoForRole("chat", orgAIConfig, {
      organizationId,
    }).modelId;
  } catch {
    // Boundary: `getTanStackTextModelInfoForRole` throws for an
    // unconfigured/role-unsupported chat model (e.g. BYOK not set up). Budget
    // resolution is best-effort — fall back to the default trigger via an
    // undefined window rather than failing the send or the meter.
    return undefined;
  }
};
