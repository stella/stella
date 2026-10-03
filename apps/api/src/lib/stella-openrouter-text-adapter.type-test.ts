import { expectTypeOf } from "bun:test";

import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import type { createManagedOpenRouterText } from "@/api/lib/stella-openrouter-text-adapter";

type ManagedRequestOptions = Parameters<typeof createManagedOpenRouterText>[0];

expectTypeOf<{
  model: "google/gemini-3.8-flash";
  apiKey: string;
}>().not.toExtend<ManagedRequestOptions>();
expectTypeOf<
  Pick<ManagedRequestOptions, "managedAIResidency">
>().toEqualTypeOf<{ managedAIResidency: ManagedAIResidency }>();
