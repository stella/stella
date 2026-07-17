import { isDeepStrictEqual } from "node:util";

import { chat, EventType, maxIterations, toolDefinition } from "@tanstack/ai";
import type { Tool } from "@tanstack/ai";
import * as v from "valibot";

import {
  DEFAULT_MODELS,
  isBYOKModelRoleSupported,
  isBYOKProviderRoleSupported,
  MODEL_ROLES,
} from "@stll/ai-catalog";
import type { ModelRole } from "@stll/ai-catalog";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { CachingDecision, OrgAIConfig } from "@/api/lib/ai-config";
import { providerSafeJsonSchemaOptionsForTanStackProvider } from "@/api/lib/provider-safe-json-schema";
import {
  abortControllerFromSignal,
  generateTanStackObjectForRole,
  generateTanStackTextForRole,
  mergeGenerationOptions,
  resolveTanStackTextModel,
} from "@/api/lib/tanstack-ai-generate";
import { projectSchemaInputJsonSchema } from "@/api/lib/tanstack-ai-schema";

import {
  CANARY_TIERS,
  CANARY_PROVIDERS,
  modelRoleMaxOutputTokens,
  weeklyCanaryRotation,
} from "./ai-provider-canary-config";
import type {
  CanaryProvider,
  WeeklyCanaryRotation,
} from "./ai-provider-canary-config";
import {
  createWeeklyToolShapeDefinition,
  WEEKLY_TOOL_RESULT,
} from "./ai-provider-canary-weekly";

const CAPABILITY_ROLE = "fast" satisfies ModelRole;
const TOOL_CALL_ROLE = "chat" satisfies ModelRole;
const MAX_OUTPUT_TOKENS = 64;
const CAPABILITY_PROBE_TIMEOUT_MS = 20_000;
const MODEL_ROLE_PROBE_TIMEOUT_MS = 30_000;
const TOOL_ROUND_TRIP_PROBE_TIMEOUT_MS = 45_000;
const MILLISECONDS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const SYNTHETIC_PROMPT = "Reply with exactly OK.";
const TOOL_SCHEMA_PROMPT = "Do not call any tool. Reply with exactly OK.";
const TOOL_ROUND_TRIP_NAME = "canary_round_trip";
const TOOL_ROUND_TRIP_VALUE = "stella-canary";
const TOOL_ROUND_TRIP_COUNT = 7;
const TOOL_ROUND_TRIP_RESULT = "stella-tool-round-trip-ok";
// JSON Schema patterns have no regex flag channel. OpenAI strict Structured
// Outputs supports `pattern`; `a^` cannot match any string.
// eslint-disable-next-line require-unicode-regexp
const NEVER_MATCH_PATTERN = /a^/;
const TOOL_ROUND_TRIP_PROMPT_PREFIX =
  `Call ${TOOL_ROUND_TRIP_NAME} exactly once with value "${TOOL_ROUND_TRIP_VALUE}" ` +
  `and count ${TOOL_ROUND_TRIP_COUNT}.`;
const TOOL_ROUND_TRIP_PROMPT_SUFFIX =
  "Then reply with only the confirmation value returned by the tool.";
const NULL_WIDENING_CANARY_PROVIDERS = new Set<CanaryProvider>([
  "mistral",
  "openai",
]);

export const toolRoundTripPromptForProvider = (
  provider: CanaryProvider,
): string => {
  if (NULL_WIDENING_CANARY_PROVIDERS.has(provider)) {
    return `${TOOL_ROUND_TRIP_PROMPT_PREFIX} Set optionalNote to null. ${TOOL_ROUND_TRIP_PROMPT_SUFFIX}`;
  }

  return `${TOOL_ROUND_TRIP_PROMPT_PREFIX} Do not include optionalNote. ${TOOL_ROUND_TRIP_PROMPT_SUFFIX}`;
};

const SAFE_CANARY_ERROR_MESSAGES = new Set([
  "Canary resolved an unexpected provider model.",
  "Provider did not execute the canary tool exactly once.",
  "Provider adapter preserved a synthetic null tool argument.",
  "Provider generated an unexpected optional tool argument.",
  "Provider returned unexpected canary tool arguments.",
  "Provider did not return the canary tool result.",
  "Provider did not execute the weekly canary tool exactly once.",
  "Provider returned unexpected weekly canary tool arguments.",
  "Provider did not return the weekly canary tool result.",
  "Provider returned no text.",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const SAFE_PROVIDER_CODES = new Set([
  "aborted",
  "api_error",
  "authentication_error",
  "billing_error",
  "error",
  "incomplete",
  "invalid_prompt",
  "invalid_request",
  "invalid_request_error",
  "not_found_error",
  "overloaded_error",
  "parse-error",
  "permission_error",
  "provider_error",
  "rate_limit_error",
  "rate_limit_exceeded",
  "refusal",
  "server_error",
  "timeout",
  "timeout_error",
]);

type CanaryRunStage =
  | "before-tool-call"
  | "after-tool-call"
  | "after-tool-result";

const providerCode = (error: unknown, depth = 0): string | null => {
  if (!isRecord(error)) {
    return null;
  }
  const code = error["code"];
  if (typeof code === "string" && SAFE_PROVIDER_CODES.has(code)) {
    return code;
  }

  if (depth >= 3) {
    return null;
  }
  for (const key of ["rawEvent", "error", "cause"] as const) {
    const nestedCode = providerCode(error[key], depth + 1);
    if (nestedCode !== null) {
      return nestedCode;
    }
  }
  return null;
};

const providerStatus = (error: unknown, depth = 0): number | null => {
  if (!isRecord(error)) {
    return null;
  }
  for (const key of ["status", "statusCode", "code"] as const) {
    const value = error[key];
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 100 &&
      value <= 599
    ) {
      return value;
    }
  }

  if (depth >= 3) {
    return null;
  }
  for (const key of ["rawEvent", "error", "cause"] as const) {
    const nestedStatus = providerStatus(error[key], depth + 1);
    if (nestedStatus !== null) {
      return nestedStatus;
    }
  }
  return null;
};

export class CanaryProviderRunError extends TypeError {
  readonly code: string | null;
  readonly stage: CanaryRunStage;
  readonly status: number | null;

  constructor(event: unknown, stage: CanaryRunStage) {
    super("Provider stream failed.");
    this.name = "CanaryProviderRunError";
    this.code = providerCode(event);
    this.stage = stage;
    this.status = providerStatus(event);
  }
}

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

export const toolRoundTripInputSchema = v.strictObject({
  count: v.literal(TOOL_ROUND_TRIP_COUNT),
  // Strict adapters require every provider-facing property and widen this
  // optional string with null. The provider is asked for that synthetic null;
  // the adapter must remove it before the server validates and executes the
  // tool because null is deliberately invalid in this application schema.
  optionalNote: v.optional(v.pipe(v.string(), v.regex(NEVER_MATCH_PATTERN))),
  value: v.literal(TOOL_ROUND_TRIP_VALUE),
});

// Mistral rejects `pattern` in strict tool schemas. Its adapter widens every
// optional enum with null, so an empty enum becomes `[null]` on the wire: one
// deterministic omission marker and no non-null value for the model to choose.
const MISTRAL_TOOL_ROUND_TRIP_JSON_SCHEMA = {
  type: "object",
  properties: {
    count: { type: "number", enum: [TOOL_ROUND_TRIP_COUNT] },
    optionalNote: { type: "string", enum: [] },
    value: { type: "string", enum: [TOOL_ROUND_TRIP_VALUE] },
  },
  required: ["count", "value"],
  additionalProperties: false,
} as const;

const toolRoundTripStandardSchema = toTanStackToolSchema(
  toolRoundTripInputSchema,
);

const MISTRAL_TOOL_ROUND_TRIP_INPUT_SCHEMA = {
  ...toolRoundTripStandardSchema,
  "~standard": {
    ...toolRoundTripStandardSchema["~standard"],
    jsonSchema: {
      ...toolRoundTripStandardSchema["~standard"].jsonSchema,
      input: () => MISTRAL_TOOL_ROUND_TRIP_JSON_SCHEMA,
    },
  },
} as const;

export const toolRoundTripInputSchemaForProvider = (
  provider: CanaryProvider,
) => {
  if (provider === "mistral") {
    return MISTRAL_TOOL_ROUND_TRIP_INPUT_SCHEMA;
  }

  return toolRoundTripStandardSchema;
};

const toolRoundTripOutputSchema = v.strictObject({
  confirmation: v.literal(TOOL_ROUND_TRIP_RESULT),
});

type ProbeBase = {
  timeoutMs: number;
  run: (context: CanaryContext, signal: AbortSignal) => Promise<void>;
};

type CapabilityProbe = ProbeBase & {
  type: "capability";
  name: string;
};

type ModelRoleProbe = ProbeBase & {
  type: "model-role";
  role: ModelRole;
};

type Probe = CapabilityProbe | ModelRoleProbe;

type CanaryContext = {
  config: OrgAIConfig;
  provider: CanaryProvider;
};

type WeeklyCanaryContext = CanaryContext & {
  rotatedConfig: OrgAIConfig;
  rotation: WeeklyCanaryRotation;
};

const modelRoleProbes = MODEL_ROLES.map(
  (role) =>
    ({
      type: "model-role",
      role,
      timeoutMs: MODEL_ROLE_PROBE_TIMEOUT_MS,
      run: async (context, signal) => {
        await runModelRoleProbe({ context, role, signal });
      },
    }) satisfies ModelRoleProbe,
);

const capabilityProbes = [
  {
    type: "capability",
    name: "structured-output",
    timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS,
    run: async ({ config }, signal) => {
      await generateTanStackObjectForRole({
        abortSignal: signal,
        caching: NO_CACHING,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        organizationId: null,
        orgAIConfig: config,
        outputSchema: structuredOutputSchema,
        prompt: "Return an object whose ok field is true.",
        role: CAPABILITY_ROLE,
        serviceTier: "standard",
      });
    },
  },
  {
    type: "capability",
    name: "strict-tool-schema",
    timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS,
    run: async (context, signal) => {
      await runToolProbe({
        context,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        prompt: TOOL_SCHEMA_PROMPT,
        role: CAPABILITY_ROLE,
        signal,
        tool: strictTool,
      });
    },
  },
  {
    type: "capability",
    name: "open-map-tool-schema",
    timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS,
    run: async (context, signal) => {
      await runToolProbe({
        context,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        prompt: TOOL_SCHEMA_PROMPT,
        role: CAPABILITY_ROLE,
        signal,
        tool: openMapTool,
      });
    },
  },
  {
    type: "capability",
    name: "tool-call-round-trip",
    timeoutMs: TOOL_ROUND_TRIP_PROBE_TIMEOUT_MS,
    run: async (context, signal) => {
      await runToolCallRoundTripProbe({ context, signal });
    },
  },
  {
    type: "capability",
    name: "prompt-caching",
    timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS,
    run: async ({ config }, signal) => {
      const output = await generateTanStackTextForRole({
        abortSignal: signal,
        caching: CANARY_CACHING,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        organizationId: null,
        orgAIConfig: config,
        prompt: SYNTHETIC_PROMPT,
        role: CAPABILITY_ROLE,
        serviceTier: "standard",
        system: "This is a synthetic provider-contract canary.",
      });
      requireNonEmptyText(output);
    },
  },
] as const satisfies readonly CapabilityProbe[];

const probes = [
  ...modelRoleProbes,
  ...capabilityProbes,
] satisfies readonly Probe[];

type RunModelRoleProbeOptions = {
  context: CanaryContext;
  role: ModelRole;
  signal: AbortSignal;
};

const runModelRoleProbe = async ({
  context: { config, provider },
  role,
  signal,
}: RunModelRoleProbeOptions): Promise<void> => {
  const model = resolveTanStackTextModel({
    organizationId: null,
    orgAIConfig: config,
    role,
  });
  if (
    model.provider !== provider ||
    model.modelId !== DEFAULT_MODELS[provider][role]
  ) {
    throw new TypeError("Canary resolved an unexpected provider model.");
  }

  const output = await generateTanStackTextForRole({
    abortSignal: signal,
    caching: NO_CACHING,
    maxOutputTokens: modelRoleMaxOutputTokens(role),
    organizationId: null,
    orgAIConfig: config,
    prompt: SYNTHETIC_PROMPT,
    role,
    serviceTier: "standard",
  });
  requireNonEmptyText(output);
};

type RunWeeklyModelRoleProbeOptions = {
  context: WeeklyCanaryContext;
  role: ModelRole;
  signal: AbortSignal;
};

const runWeeklyModelRoleProbe = async ({
  context: { provider, rotatedConfig, rotation },
  role,
  signal,
}: RunWeeklyModelRoleProbeOptions): Promise<void> => {
  const model = resolveTanStackTextModel({
    organizationId: null,
    orgAIConfig: rotatedConfig,
    role,
  });
  if (model.provider !== provider || model.modelId !== rotation.modelId) {
    throw new TypeError("Canary resolved an unexpected provider model.");
  }

  const output = await generateTanStackTextForRole({
    abortSignal: signal,
    caching: NO_CACHING,
    maxOutputTokens: modelRoleMaxOutputTokens(role),
    organizationId: null,
    orgAIConfig: rotatedConfig,
    prompt: SYNTHETIC_PROMPT,
    role,
    serviceTier: "standard",
  });
  requireNonEmptyText(output);
};

type RunToolCallRoundTripProbeOptions = {
  context: CanaryContext;
  signal: AbortSignal;
};

const runToolCallRoundTripProbe = async ({
  context,
  signal,
}: RunToolCallRoundTripProbeOptions): Promise<void> => {
  const observedInputs: unknown[] = [];
  const tool = toolDefinition({
    name: TOOL_ROUND_TRIP_NAME,
    description:
      "Call exactly once with the value and count requested by the user.",
    inputSchema: toolRoundTripInputSchemaForProvider(context.provider),
    outputSchema: toTanStackToolSchema(toolRoundTripOutputSchema),
  }).server((input) => {
    observedInputs.push(input);
    return { confirmation: TOOL_ROUND_TRIP_RESULT };
  });

  const output = await runToolProbe({
    context,
    maxOutputTokens: modelRoleMaxOutputTokens(TOOL_CALL_ROLE),
    prompt: toolRoundTripPromptForProvider(context.provider),
    role: TOOL_CALL_ROLE,
    signal,
    tool,
  });

  if (observedInputs.length !== 1) {
    throw new TypeError(
      "Provider did not execute the canary tool exactly once.",
    );
  }
  const observedInput = observedInputs.at(0);
  if (
    !isRecord(observedInput) ||
    observedInput["count"] !== TOOL_ROUND_TRIP_COUNT ||
    observedInput["value"] !== TOOL_ROUND_TRIP_VALUE
  ) {
    throw new TypeError("Provider returned unexpected canary tool arguments.");
  }
  if ("optionalNote" in observedInput) {
    if (observedInput["optionalNote"] === null) {
      throw new TypeError(
        "Provider adapter preserved a synthetic null tool argument.",
      );
    }
    throw new TypeError(
      "Provider generated an unexpected optional tool argument.",
    );
  }
  if (output.trim() !== TOOL_ROUND_TRIP_RESULT) {
    throw new TypeError("Provider did not return the canary tool result.");
  }
};

type RunWeeklyToolShapeProbeOptions = {
  context: WeeklyCanaryContext;
  signal: AbortSignal;
};

const runWeeklyToolShapeProbe = async ({
  context,
  signal,
}: RunWeeklyToolShapeProbeOptions): Promise<void> => {
  const observedInputs: unknown[] = [];
  const { expectedInput, prompt, tool } = createWeeklyToolShapeDefinition(
    context.rotation.toolShape,
    observedInputs,
  );
  const output = await runToolProbe({
    context: { config: context.rotatedConfig, provider: context.provider },
    maxOutputTokens: modelRoleMaxOutputTokens(TOOL_CALL_ROLE),
    prompt,
    role: TOOL_CALL_ROLE,
    signal,
    tool,
  });

  if (observedInputs.length !== 1) {
    throw new TypeError(
      "Provider did not execute the weekly canary tool exactly once.",
    );
  }
  if (!isDeepStrictEqual(observedInputs.at(0), expectedInput)) {
    throw new TypeError(
      "Provider returned unexpected weekly canary tool arguments.",
    );
  }
  if (output.trim() !== WEEKLY_TOOL_RESULT) {
    throw new TypeError("Provider did not return the weekly canary tool result.");
  }
};

type RunToolProbeOptions = {
  context: CanaryContext;
  maxOutputTokens: number;
  prompt: string;
  role: ModelRole;
  signal: AbortSignal;
  tool: Tool;
};

const runToolProbe = async ({
  context: { config, provider },
  maxOutputTokens,
  prompt,
  role,
  signal,
  tool,
}: RunToolProbeOptions): Promise<string> => {
  const model = resolveTanStackTextModel({
    organizationId: null,
    orgAIConfig: config,
    role,
  });
  const inputSchema = projectSchemaInputJsonSchema(
    tool.inputSchema,
    providerSafeJsonSchemaOptionsForTanStackProvider(provider),
  );
  const projectedTool = {
    ...tool,
    ...(inputSchema === undefined ? {} : { inputSchema }),
  };

  const stream = chat({
    adapter: model.adapter,
    abortController: abortControllerFromSignal(signal),
    agentLoopStrategy: maxIterations(2),
    messages: [{ role: "user", content: prompt }],
    modelOptions: mergeGenerationOptions({
      caching: NO_CACHING,
      model,
      maxOutputTokens,
      serviceTier: "standard",
      temperature: 0,
    }),
    stream: true,
    tools: [projectedTool],
  });
  let output = "";
  let stage: CanaryRunStage = "before-tool-call";
  for await (const chunk of stream) {
    if (chunk.type === EventType.TEXT_MESSAGE_CONTENT && chunk.delta) {
      output += chunk.delta;
    }
    if (chunk.type === EventType.TOOL_CALL_END) {
      stage = "after-tool-call";
    }
    if (chunk.type === EventType.TOOL_CALL_RESULT) {
      stage = "after-tool-result";
    }
    if (chunk.type === EventType.RUN_ERROR) {
      throw new CanaryProviderRunError(chunk, stage);
    }
  }
  requireNonEmptyText(output);
  return output;
};

const requireNonEmptyText = (output: string): void => {
  if (output.trim().length === 0) {
    throw new TypeError("Provider returned no text.");
  }
};

const modelSelections = (
  provider: CanaryProvider,
  rotatedModelId?: string,
) => {
  const modelIdForRole = (role: ModelRole) =>
    rotatedModelId !== undefined &&
    isBYOKModelRoleSupported({ modelId: rotatedModelId, provider, role })
      ? rotatedModelId
      : DEFAULT_MODELS[provider][role];

  return {
    fast: { provider, modelId: modelIdForRole("fast") },
    chat: { provider, modelId: modelIdForRole("chat") },
    reasoning: { provider, modelId: modelIdForRole("reasoning") },
    pdf: { provider, modelId: modelIdForRole("pdf") },
  };
};

type CreateCanaryConfigOptions = {
  apiKey: string;
  provider: CanaryProvider;
  rotatedModelId?: string;
};

const createCanaryConfig = ({
  apiKey,
  provider,
  rotatedModelId,
}: CreateCanaryConfigOptions): OrgAIConfig => {
  switch (provider) {
    case "google":
    case "openrouter":
    case "openai":
    case "anthropic":
    case "bedrock":
    case "mistral":
      return {
        providers: [{ provider, apiKey }],
        overrideModels: modelSelections(provider, rotatedModelId),
      };
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
};

const flagValue = (args: string[], flag: string): string | undefined => {
  const flagIndex = args.indexOf(flag);
  return flagIndex === -1 ? undefined : args.at(flagIndex + 1);
};

const parseProvider = (args: string[]): CanaryProvider => {
  const value = flagValue(args, "--provider");
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

  throw new TypeError(
    `Pass --provider followed by one of: ${CANARY_PROVIDERS.join(", ")}.`,
  );
};

type CanaryRunArgs =
  | { provider: CanaryProvider; tier: "daily" }
  | { provider: CanaryProvider; rotationIndex: number; tier: "weekly" };

const parseCanaryRunArgs = (args: string[]): CanaryRunArgs => {
  const provider = parseProvider(args);
  const tierValue = flagValue(args, "--tier") ?? "daily";
  if (tierValue === "daily") {
    return { provider, tier: "daily" };
  }
  if (tierValue !== "weekly") {
    throw new TypeError(
      `Pass --tier followed by one of: ${CANARY_TIERS.join(", ")}.`,
    );
  }

  const rotationValue = flagValue(args, "--rotation-index");
  const rotationIndex =
    rotationValue === undefined
      ? Math.floor(Date.now() / MILLISECONDS_PER_WEEK)
      : Number(rotationValue);
  if (!Number.isSafeInteger(rotationIndex) || rotationIndex < 0) {
    throw new TypeError(
      "Pass --rotation-index followed by a non-negative integer.",
    );
  }

  return { provider, rotationIndex, tier: "weekly" };
};

export const errorSummary = (error: unknown, signal: AbortSignal): string => {
  if (signal.aborted) {
    return "timeout";
  }

  if (error instanceof CanaryProviderRunError) {
    if (error.status !== null) {
      return `provider HTTP ${error.status}`;
    }
    const stage = error.stage.replaceAll("-", " ");
    return error.code === null
      ? `provider stream error ${stage}`
      : `provider stream error ${stage} (${error.code})`;
  }

  if (
    error instanceof TypeError &&
    SAFE_CANARY_ERROR_MESSAGES.has(error.message)
  ) {
    return error.message;
  }

  const status = providerStatus(error);
  return status === null ? "provider error" : `provider HTTP ${status}`;
};

const probeLabel = (context: CanaryContext, probe: Probe): string => {
  if (probe.type === "capability") {
    return probe.name;
  }

  return `role-${probe.role}:${DEFAULT_MODELS[context.provider][probe.role]}`;
};

const run = async (): Promise<void> => {
  const args = parseCanaryRunArgs(Bun.argv.slice(2));
  const { provider } = args;
  const apiKey = process.env["AI_CANARY_API_KEY"];
  if (!apiKey) {
    throw new TypeError(`No canary credential is configured for ${provider}.`);
  }

  const context = {
    config: createCanaryConfig({ apiKey, provider }),
    provider,
  } satisfies CanaryContext;
  let failures = await runProbes(context, 0, 0);

  if (args.tier === "weekly") {
    const rotation = weeklyCanaryRotation({
      provider,
      rotationIndex: args.rotationIndex,
    });
    const weeklyContext = {
      ...context,
      rotatedConfig: createCanaryConfig({
        apiKey,
        provider,
        rotatedModelId: rotation.modelId,
      }),
      rotation,
    } satisfies WeeklyCanaryContext;
    console.log(
      `[ai-canary] ${provider}/weekly-rotation-${rotation.rotationIndex}: ` +
        `${rotation.modelId}, roles=${rotation.modelRoles.join(",")}, ` +
        `tool-shape=${rotation.toolShape}`,
    );
    failures = await runWeeklyCanaryProbes(weeklyContext, 0, failures);
  }

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

  const label = probeLabel(context, probe);
  if (
    probe.type === "model-role" &&
    !isBYOKProviderRoleSupported({
      provider: context.provider,
      role: probe.role,
    })
  ) {
    console.log(
      `[ai-canary] ${context.provider}/${label}: skipped (unsupported role)`,
    );
    return await runProbes(context, index + 1, failures);
  }

  const signal = AbortSignal.timeout(probe.timeoutMs);
  try {
    await probe.run(context, signal);
    console.log(`[ai-canary] ${context.provider}/${label}: passed`);
    return await runProbes(context, index + 1, failures);
  } catch (error) {
    console.error(
      `[ai-canary] ${context.provider}/${label}: failed (${errorSummary(error, signal)})`,
    );
    return await runProbes(context, index + 1, failures + 1);
  }
};

const runWeeklyCanaryProbes = async (
  context: WeeklyCanaryContext,
  index: number,
  failures: number,
): Promise<number> => {
  const role = context.rotation.modelRoles.at(index);
  if (role !== undefined) {
    const label = `weekly-role-${role}:${context.rotation.modelId}`;
    const signal = AbortSignal.timeout(MODEL_ROLE_PROBE_TIMEOUT_MS);
    try {
      await runWeeklyModelRoleProbe({ context, role, signal });
      console.log(`[ai-canary] ${context.provider}/${label}: passed`);
      return await runWeeklyCanaryProbes(context, index + 1, failures);
    } catch (error) {
      console.error(
        `[ai-canary] ${context.provider}/${label}: failed (${errorSummary(error, signal)})`,
      );
      return await runWeeklyCanaryProbes(context, index + 1, failures + 1);
    }
  }

  if (index !== context.rotation.modelRoles.length) {
    return failures;
  }

  const label =
    `weekly-tool-${context.rotation.toolShape}:` + context.rotation.modelId;
  const signal = AbortSignal.timeout(TOOL_ROUND_TRIP_PROBE_TIMEOUT_MS);
  try {
    await runWeeklyToolShapeProbe({ context, signal });
    console.log(`[ai-canary] ${context.provider}/${label}: passed`);
    return failures;
  } catch (error) {
    console.error(
      `[ai-canary] ${context.provider}/${label}: failed (${errorSummary(error, signal)})`,
    );
    return failures + 1;
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
