import { isPanic } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";

import type { ModelRole, OrgAIConfig } from "@/api/lib/ai-models";
import type * as AIModels from "@/api/lib/ai-models";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const MODEL_ROLES_UNDER_TEST = [
  "fast",
  "chat",
  "reasoning",
  "pdf",
] as const satisfies readonly ModelRole[];

const createOpenAIOrgConfig = (): OrgAIConfig => ({
  providers: [
    {
      apiKey: "org-openai-secret",
      provider: "openai",
    },
  ],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-5.4-mini" },
    fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    reasoning: { provider: "openai", modelId: "gpt-5.4" },
    pdf: { provider: "openai", modelId: "gpt-5.4" },
  },
});

let aiModels: typeof AIModels;

beforeAll(async () => {
  aiModels = await import("@/api/lib/ai-models");
});

const expectTyped403 = (run: () => unknown): void => {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }

  expect(isPanic(thrown)).toBe(false);
  expect(thrown).toBeInstanceOf(HandlerError);
  if (thrown instanceof HandlerError) {
    expect(thrown.status).toBe(403);
  }
};

const expectModelInfoForRoleTyped403 = (role: ModelRole): void => {
  expectTyped403(() => aiModels.getModelInfoForRole(role));
};

const expectModelForRoleTyped403 = (role: ModelRole): void => {
  expectTyped403(() =>
    aiModels.getModelForRole(role, null, {
      promptCachingEnabled: false,
      scopeKey: null,
      organizationId: null,
      serviceTier: "standard",
    }),
  );
};

describe("no-provider model resolution", () => {
  test("getModelInfoForRole throws a typed 403 for every role", () => {
    for (const role of MODEL_ROLES_UNDER_TEST) {
      expectModelInfoForRoleTyped403(role);
    }
  });

  test("getModelInfoById throws a typed 403 when no provider override is given", () => {
    expectTyped403(() => aiModels.getModelInfoById("gpt-5.4-mini"));
  });

  test("getModelById throws a typed 403 when no provider override is given", () => {
    expectTyped403(() =>
      aiModels.getModelById("gpt-5.4-mini", null, {
        promptCachingEnabled: false,
        scopeKey: null,
        organizationId: null,
        serviceTier: "standard",
        role: "chat",
      }),
    );
  });

  test("getModelForRole throws a typed 403 for every role", () => {
    for (const role of MODEL_ROLES_UNDER_TEST) {
      expectModelForRoleTyped403(role);
    }
  });

  test("getModelInfoForRole resolves byok for every role", () => {
    const orgConfig = createOpenAIOrgConfig();
    for (const role of MODEL_ROLES_UNDER_TEST) {
      const info = aiModels.getModelInfoForRole(role, orgConfig);
      expect(info.keySource).toBe("byok");
      expect(info.provider).toBe("openai");
      expect(info.modelId).toBe(orgConfig.overrideModels[role].modelId);
    }
  });
});
