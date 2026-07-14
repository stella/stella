import { chat, toolDefinition } from "@tanstack/ai";
import type { Tool } from "@tanstack/ai";
import * as v from "valibot";

import { DEFAULT_MODELS } from "@stll/ai-catalog";
import type { ModelRole } from "@stll/ai-catalog";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { CachingDecision, OrgAIConfig } from "@/api/lib/ai-config";
import { nullUnionStrategyForTanStackProvider } from "@/api/lib/provider-safe-json-schema";
import {
  abortControllerFromSignal,
  generateTanStackObjectForRole,
  generateTanStackTextForRole,
  mergeGenerationOptions,
  resolveTanStackTextModel,
} from "@/api/lib/tanstack-ai-generate";
import type { TanStackTextProvider } from "@/api/lib/tanstack-ai-models";
import { projectSchemaInputJsonSchema } from "@/api/lib/tanstack-ai-schema";

const CANARY_PROVIDERS = [
  "google",
  "openrouter",
  "openai",
  "anthropic",
  "bedrock",
  "mistral",
] as const satisfies readonly TanStackTextProvider[];

type CanaryProvider = (typeof CANARY_PROVIDERS)[number];

const CANARY_ROLE = "fast" satisfies ModelRole;
const MAX_OUTPUT_TOKENS = 64;
const PROBE_TIMEOUT_MS = 20_000;
const SYNTHETIC_PROMPT = "Reply with exactly OK.";
const TOOL_PROMPT = "Do not call any tool. Reply with exactly OK.";

const NO_CACHING = {
  enabled: false,
  reason: "org-disabled",
} as const satisfies CachingDecision;

const CANARY_CACHING = {
  enabled: true,
  ttl: "5m",
  scopeKey: "stella-synthetic-provider-canary",
} as const satisfies CachingDecision;

const structuredOutputSchema = v.strictObject({ ok: v.literal(true) });

const strictTool = toolDefinition({
  name: "canary_closed_tool",
  description: "Synthetic no-op tool with a closed input schema.",
  inputSchema: toTanStackToolSchema(
    v.strictObject({ value: v.literal("canary") }),
  ),
}).client();

const openMapTool = toolDefinition({
  name: "canary_open_map_tool",
  description: "Synthetic no-op tool with a free-form map input.",
  inputSchema: toTanStackToolSchema(
    v.strictObject({ values: v.record(v.string(), v.unknown()) }),
  ),
}).client();

type Probe = {
  name: string;
  run: (context: CanaryContext, signal: AbortSignal) => Promise<void>;
};

type CanaryContext = {
  config: OrgAIConfig;
  provider: CanaryProvider;
};

const probes = [
  {
    name: "text",
    run: async ({ config }, signal) => {
      const output = await generateTanStackTextForRole({
        abortSignal: signal,
        caching: NO_CACHING,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        organizationId: null,
        orgAIConfig: config,
        prompt: SYNTHETIC_PROMPT,
        role: CANARY_ROLE,
        serviceTier: "standard",
      });
      requireNonEmptyText(output);
    },
  },
  {
    name: "structured-output",
    run: async ({ config }, signal) => {
      await generateTanStackObjectForRole({
        abortSignal: signal,
        caching: NO_CACHING,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        organizationId: null,
        orgAIConfig: config,
        outputSchema: structuredOutputSchema,
        prompt: "Return an object whose ok field is true.",
        role: CANARY_ROLE,
        serviceTier: "standard",
      });
    },
  },
  {
    name: "strict-tool-schema",
    run: async (context, signal) => {
      await runToolSchemaProbe(context, strictTool, signal);
    },
  },
  {
    name: "open-map-tool-schema",
    run: async (context, signal) => {
      await runToolSchemaProbe(context, openMapTool, signal);
    },
  },
  {
    name: "prompt-caching",
    run: async ({ config }, signal) => {
      const output = await generateTanStackTextForRole({
        abortSignal: signal,
        caching: CANARY_CACHING,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        organizationId: null,
        orgAIConfig: config,
        prompt: SYNTHETIC_PROMPT,
        role: CANARY_ROLE,
        serviceTier: "standard",
        system: "This is a synthetic provider-contract canary.",
      });
      requireNonEmptyText(output);
    },
  },
] as const satisfies readonly Probe[];

const runToolSchemaProbe = async (
  { config, provider }: CanaryContext,
  tool: Tool,
  signal: AbortSignal,
): Promise<void> => {
  const model = resolveTanStackTextModel({
    organizationId: null,
    orgAIConfig: config,
    role: CANARY_ROLE,
  });
  const inputSchema = projectSchemaInputJsonSchema(tool.inputSchema, {
    nullUnionStrategy: nullUnionStrategyForTanStackProvider(provider),
  });
  const projectedTool = {
    ...tool,
    ...(inputSchema === undefined ? {} : { inputSchema }),
  };

  const output = await chat({
    adapter: model.adapter,
    abortController: abortControllerFromSignal(signal),
    messages: [{ role: "user", content: TOOL_PROMPT }],
    modelOptions: mergeGenerationOptions({
      caching: NO_CACHING,
      model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      serviceTier: "standard",
      temperature: 0,
    }),
    stream: false,
    tools: [projectedTool],
  });
  requireNonEmptyText(output);
};

const requireNonEmptyText = (output: string): void => {
  if (output.trim().length === 0) {
    throw new TypeError("Provider returned no text.");
  }
};

const modelSelections = (provider: CanaryProvider) => ({
  fast: { provider, modelId: DEFAULT_MODELS[provider].fast },
  chat: { provider, modelId: DEFAULT_MODELS[provider].chat },
  reasoning: { provider, modelId: DEFAULT_MODELS[provider].reasoning },
  pdf: { provider, modelId: DEFAULT_MODELS[provider].pdf },
});

const createCanaryConfig = (
  provider: CanaryProvider,
  apiKey: string,
): OrgAIConfig => {
  switch (provider) {
    case "google":
    case "openrouter":
    case "openai":
    case "anthropic":
    case "bedrock":
    case "mistral":
      return {
        providers: [{ provider, apiKey }],
        overrideModels: modelSelections(provider),
      };
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
};

const parseProvider = (args: string[]): CanaryProvider => {
  const providerFlagIndex = args.indexOf("--provider");
  const value = args.at(providerFlagIndex + 1);
  if (providerFlagIndex !== -1) {
    switch (value) {
      case "google":
      case "openrouter":
      case "openai":
      case "anthropic":
      case "bedrock":
      case "mistral":
        return value;
      case undefined:
        break;
    }
  }

  throw new TypeError(
    `Pass --provider followed by one of: ${CANARY_PROVIDERS.join(", ")}.`,
  );
};

const errorSummary = (error: unknown, signal: AbortSignal): string => {
  if (signal.aborted) {
    return "timeout";
  }

  const status = providerStatus(error);
  return status === null ? "provider error" : `provider HTTP ${status}`;
};

const providerStatus = (error: unknown): number | null => {
  if (!isRecord(error)) {
    return null;
  }
  for (const key of ["status", "statusCode"] as const) {
    const value = error[key];
    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const run = async (): Promise<void> => {
  const provider = parseProvider(Bun.argv.slice(2));
  const apiKey = process.env["AI_CANARY_API_KEY"];
  if (!apiKey) {
    throw new TypeError(`No canary credential is configured for ${provider}.`);
  }

  const context = {
    config: createCanaryConfig(provider, apiKey),
    provider,
  } satisfies CanaryContext;
  const failures = await runProbes(context, 0, 0);

  if (failures > 0) {
    throw new TypeError(
      `${failures} provider capability probe${failures === 1 ? "" : "s"} failed.`,
    );
  }
};

const runProbes = async (
  context: CanaryContext,
  index: number,
  failures: number,
): Promise<number> => {
  const probe = probes.at(index);
  if (!probe) {
    return failures;
  }

  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    await probe.run(context, signal);
    console.log(`[ai-canary] ${context.provider}/${probe.name}: passed`);
    return await runProbes(context, index + 1, failures);
  } catch (error) {
    console.error(
      `[ai-canary] ${context.provider}/${probe.name}: failed (${errorSummary(error, signal)})`,
    );
    return await runProbes(context, index + 1, failures + 1);
  }
};

if (import.meta.main) {
  await run().catch((error: unknown) => {
    // Never print provider errors: bodies can echo request content or headers.
    const message =
      error instanceof TypeError ? error.message : "Canary failed.";
    console.error(`[ai-canary] ${message}`);
    process.exitCode = 1;
  });
}
