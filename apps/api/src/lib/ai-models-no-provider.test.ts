import { isPanic } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";

import type { ModelRole, OrgAIConfig } from "@/api/lib/ai-models";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

// Reproduce a bring-your-own-key deployment: BYOK is forced and the
// instance has no platform provider key, so the request-path resolvers
// have no provider to fall back on. The global analytics/model tests set
// OPENAI_API_KEY, which masks this state, so the env is configured here
// before the module under test is dynamically imported.
const AI_PROVIDER_KEYS = [
  "AI_PROVIDER",
  "ANTHROPIC_API_KEY",
  "AZURE_API_KEY",
  "GOOGLE_AI_API_KEY_CH",
  "GOOGLE_AI_API_KEY_EU",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "HUGGINGFACE_API_KEY",
  "MISTRAL_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "USE_MOCK_AI",
];

for (const key of AI_PROVIDER_KEYS) {
  delete process.env[key];
}
process.env["REQUIRE_PERSONAL_AI_KEY"] = "true";

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

let aiModels: typeof import("@/api/lib/ai-models");

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
  if (!(thrown instanceof HandlerError)) {
    throw new Error("Expected a HandlerError, got: " + String(thrown));
  }
  expect(thrown.status).toBe(403);
};

describe("request-path provider resolution without a configured provider", () => {
  test("getModelInfoForRole throws a typed 403 for every role", () => {
    for (const role of MODEL_ROLES_UNDER_TEST) {
      expectTyped403(() => aiModels.getModelInfoForRole(role));
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
      expectTyped403(() =>
        aiModels.getModelForRole(role, null, {
          promptCachingEnabled: false,
          scopeKey: null,
          organizationId: null,
          serviceTier: "standard",
        }),
      );
    }
  });
});

describe("request-path provider resolution with valid BYOK config", () => {
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
