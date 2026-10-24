import { expectTypeOf, test } from "bun:test";

import type { resolveChatSandboxPlan } from "@/api/handlers/chat/chat-sandbox-plan";
import type { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type {
  AIDataClass,
  AIRequestPolicy,
} from "@/api/lib/chat/ai-data-policy";
import type {
  generateTanStackObjectForTask,
  generateTanStackTextForTask,
  resolveTanStackTextModel,
  streamTanStackObjectForTask,
  streamTanStackTextForTask,
} from "@/api/lib/tanstack-ai-generate";
import type {
  createTanStackTextAdapterFactory,
  getStructuredOutputFallbackModelId,
  getTanStackTextModelById,
  getTanStackTextModelForTask,
  getTanStackTextModelInfoById,
  getTanStackTextModelInfoForTask,
  isModelSelectionAvailableForTask,
  requireTanStackAIAvailableForTask,
} from "@/api/lib/tanstack-ai-models";
import type { decide, decideMany } from "@/api/lib/workflow/decisions/decide";
import type {
  hasInstanceDecisionModel,
  resolveDecisionModel,
} from "@/api/lib/workflow/decisions/decision-model";

type GenerationOptions = [
  Parameters<typeof generateTanStackObjectForTask>[0],
  Parameters<typeof generateTanStackTextForTask>[0],
  Parameters<typeof streamTanStackObjectForTask>[0],
  Parameters<typeof streamTanStackTextForTask>[0],
  Parameters<typeof resolveTanStackTextModel>[0],
  Parameters<typeof getStructuredOutputFallbackModelId>[0],
  Parameters<typeof getTanStackTextModelForTask>[2],
  Parameters<typeof getTanStackTextModelById>[2],
  Parameters<typeof resolveChatSandboxPlan>[0],
];

test("generation entries require a request policy", () => {
  expectTypeOf<GenerationOptions>().toExtend<AIRequestPolicy[]>();
  expectTypeOf<undefined>().not.toExtend<GenerationOptions[number]>();
});

type FactoryOptions = Parameters<typeof createTanStackTextAdapterFactory>[0];

test("adapter entries require the applicable request policy", () => {
  expectTypeOf<FactoryOptions>().toExtend<{ dataClass: AIDataClass }>();
  expectTypeOf<
    Exclude<FactoryOptions, { apiKey: string }>
  >().toExtend<AIRequestPolicy>();
});

type ClassifiedOptions = [
  Parameters<typeof isModelSelectionAvailableForTask>[0],
  Parameters<typeof decide>[0],
  Parameters<typeof decideMany>[0],
  Parameters<typeof createTanStackAIAnalyticsCallbacks>[0],
  Parameters<typeof requireTanStackAIAvailableForTask>[0],
  Parameters<typeof getTanStackTextModelInfoForTask>[2],
  Parameters<typeof getTanStackTextModelInfoById>[3],
];

test("decision and metadata entries require a data class", () => {
  expectTypeOf<ClassifiedOptions>().toExtend<{ dataClass: AIDataClass }[]>();
});

type DataClassArguments = [
  Parameters<typeof resolveDecisionModel>[1],
  Parameters<typeof hasInstanceDecisionModel>[0],
];

test("positional metadata entries require a data class", () => {
  expectTypeOf<DataClassArguments>().toExtend<AIDataClass[]>();
  expectTypeOf<DataClassArguments[number]>().toEqualTypeOf<AIDataClass>();
  expectTypeOf<undefined>().not.toExtend<DataClassArguments[number]>();
});
