/**
 * Per-thread compaction budget: resolves the chat model the next send would
 * use, maps it through the catalog's documented context window, and derives
 * the compaction trigger plus the proportionally-scaled preserved tail.
 *
 * Kept out of the chat slice so the background compactor resolves a thread's
 * budget the same way its sends do. Used by the send path (to gate
 * checkpointing), the read path (to size the context meter), and the compactor,
 * so a thread's meter denominator matches the trigger its next send applies.
 */
import { getContextWindowTokens } from "@stll/ai-catalog";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { SafeId } from "@/api/lib/branded-types";
import { decodeChatModelSelection } from "@/api/lib/chat-model-selection";
import {
  resolveCompactionTriggerTokens,
  resolvePreserveTokensForTrigger,
} from "@/api/lib/chat/compaction-tokens";
import { getTanStackTextModelInfoForRole } from "@/api/lib/tanstack-ai-models";

export type ChatCompactionBudget = {
  triggerTokens: number;
  preserveTokens: number;
};

type ResolveChatCompactionBudgetOptions = {
  /**
   * Effective chat model override for this turn/read — the dev override
   * (`body.devModelId`) or a validated thread-level selection, already
   * resolved by `resolveEffectiveChatModelId`. Absent when neither applies
   * (org/instance chat-role default).
   */
  chatModelOverride?: string | undefined;
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
  chatModelOverride,
  orgAIConfig,
  organizationId,
}: ResolveChatCompactionBudgetOptions): string | undefined => {
  if (chatModelOverride) {
    return (
      decodeChatModelSelection(chatModelOverride)?.modelId ?? chatModelOverride
    );
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
