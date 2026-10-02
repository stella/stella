export const MANAGED_AI_RESIDENCIES = ["eu", "us"] as const;
export type ManagedAIResidency = (typeof MANAGED_AI_RESIDENCIES)[number];
export const DEFAULT_MANAGED_AI_RESIDENCY =
  "eu" as const satisfies ManagedAIResidency;

export type AIDataClass = "customer" | "public_corpus";
export type AIRequestPolicy =
  | { dataClass: "customer"; managedAIResidency: ManagedAIResidency }
  | { dataClass: "public_corpus" };
