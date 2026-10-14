import { expectTypeOf, test } from "bun:test";

import type { resolveChatSandboxPlan } from "@/api/handlers/chat/chat-sandbox-plan";
import type { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type {
  AIDataClass,
  AIRequestPolicy,
} from "@/api/lib/chat/ai-data-policy";
import type {
  generateTanStackObjectForRole,
  generateTanStackTextForRole,
  resolveTanStackTextModel,
  streamTanStackObjectForRole,
  streamTanStackTextForRole,
} from "@/api/lib/tanstack-ai-generate";
import type {
  createTanStackTextAdapterFactory,
  getTanStackTextModelById,
  getTanStackTextModelForRole,
  getTanStackTextModelInfoForRole,
  getTanStackTextModelInfoById,
  requireTanStackAIAvailableForRole,
} from "@/api/lib/tanstack-ai-models";
import type { decide, decideMany } from "@/api/lib/workflow/decisions/decide";
import type {
  resolveDecisionModel,
  hasInstanceDecisionModel,
} from "@/api/lib/workflow/decisions/decision-model";

type GenerationOptions = [
  Parameters<typeof generateTanStackObjectForRole>[0],
  Parameters<typeof generateTanStackTextForRole>[0],
  Parameters<typeof streamTanStackObjectForRole>[0],
  Parameters<typeof streamTanStackTextForRole>[0],
  Parameters<typeof resolveTanStackTextModel>[0],
  Parameters<typeof getTanStackTextModelForRole>[2],
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
  Parameters<typeof decide>[0],
  Parameters<typeof decideMany>[0],
  Parameters<typeof createTanStackAIAnalyticsCallbacks>[0],
  Parameters<typeof requireTanStackAIAvailableForRole>[0],
  Parameters<typeof getTanStackTextModelInfoForRole>[2],
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
