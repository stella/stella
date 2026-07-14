import type { ModelRole } from "@stll/ai-catalog";

const MODEL_ROLE_MAX_OUTPUT_TOKENS = {
  fast: 512,
  chat: 512,
  reasoning: 25_000,
  pdf: 512,
} as const satisfies Record<ModelRole, number>;

export const modelRoleMaxOutputTokens = (role: ModelRole) =>
  MODEL_ROLE_MAX_OUTPUT_TOKENS[role];
