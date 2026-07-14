import { describe, expect, test } from "bun:test";

import { MODEL_ROLES } from "@stll/ai-catalog";

import { modelRoleMaxOutputTokens } from "./ai-provider-canary-config";

describe("AI provider canary role budgets", () => {
  test("reserves reasoning capacity without inflating other role probes", () => {
    for (const role of MODEL_ROLES) {
      expect(modelRoleMaxOutputTokens(role)).toBe(
        role === "reasoning" ? 25_000 : 512,
      );
    }
  });
});
