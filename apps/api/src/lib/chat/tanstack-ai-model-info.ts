import type { TanStackAIProvider } from "@stll/ai-catalog";

import type { DataRegion } from "@/api/lib/ai-config";

export type TanStackTextProvider = TanStackAIProvider;

export type ResolvedTanStackTextModelInfo = {
  keySource: "byok" | "instance";
  provider: TanStackTextProvider;
  modelId: string;
  region?: DataRegion | undefined;
  availability: "available" | "unavailable";
};
