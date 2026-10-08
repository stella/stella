/**
 * Which decision model answers for an organization.
 *
 * The org's own, from its AI config, when it has one; otherwise the
 * instance's, from the environment, unless the deployment requires every
 * org to bring its own keys. Null means no typed decision runs anywhere and
 * every `decide` call comes back undecided, which is the ordinary state of a
 * self-hosted instance without a decision model.
 */

import { panic, Result } from "better-result";

import { env } from "@/api/env";
import type {
  DecisionModelProvider,
  OrgAIConfig,
  OrgDecisionModelConfig,
} from "@/api/lib/ai-config";
import type { AIDataClass } from "@/api/lib/chat/ai-data-policy";
import { isManagedProviderAvailable } from "@/api/lib/chat/provider-data-policy";
import { ConfigurationError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { createOpenAIDecisionsClient } from "@/api/lib/workflow/decisions/openai-decisions";
import {
  createSystemOneClient,
  noul,
} from "@/api/lib/workflow/decisions/system-one";
import type { SystemOneClient } from "@/api/lib/workflow/decisions/system-one";
import { getSystemOneClient } from "@/api/lib/workflow/decisions/system-one-runtime";

type ResolvedDecisionModelConfig = OrgDecisionModelConfig & { apiKey: string };

/** One client constructor per provider; a provider without one cannot be added. */
const CLIENT_BY_PROVIDER = {
  typesafe: (config) =>
    createSystemOneClient({ apiKey: config.apiKey, model: config.modelId }),
  openai: (config) =>
    createOpenAIDecisionsClient({
      apiKey: config.apiKey,
      model: config.modelId,
      region: config.region,
    }),
} as const satisfies {
  [P in DecisionModelProvider]: (
    config: Extract<ResolvedDecisionModelConfig, { provider: P }>,
  ) => SystemOneClient;
};

const orgClient = (config: ResolvedDecisionModelConfig): SystemOneClient => {
  switch (config.provider) {
    case "typesafe":
      return CLIENT_BY_PROVIDER.typesafe(config);
    case "openai":
      return CLIENT_BY_PROVIDER.openai(config);
    default:
      config satisfies never;
      return panic("Unhandled decision model provider");
  }
};

/** Funding belongs to the resolved credential, including injected clients. */
export type DecisionModel = SystemOneClient & {
  keySource: "byok" | "instance";
};

/** Whether the instance itself carries a decision model an org may fall back on. */
export const hasInstanceDecisionModel = (dataClass: AIDataClass): boolean =>
  !env.REQUIRE_PERSONAL_AI_KEY &&
  env.TYPESAFE_API_KEY !== undefined &&
  isManagedProviderAvailable("typesafe", dataClass);

const DECISION_KEY_SINK = failureSink({
  event: "decision.model_key_missing",
  expected: [],
});

export const resolveDecisionModel = (
  orgAIConfig: OrgAIConfig | null | undefined,
  dataClass: AIDataClass,
): DecisionModel | null => {
  const decision = orgAIConfig?.decision ?? null;
  if (decision !== null) {
    const apiKey =
      decision.apiKey ??
      orgAIConfig?.providers.find((provider) => provider.provider === "openai")
        ?.apiKey;
    if (apiKey === undefined) {
      observeFailure(
        new ConfigurationError({
          message: "Configured OpenAI decision model has no organization key",
        }),
        { sink: DECISION_KEY_SINK, ctx: { source: "resolveDecisionModel" } },
      );
      return null;
    }
    return { ...orgClient({ ...decision, apiKey }), keySource: "byok" };
  }
  if (!hasInstanceDecisionModel(dataClass)) {
    return null;
  }
  const client = getSystemOneClient();
  return client === null ? null : { ...client, keySource: "instance" };
};

type DecisionModelProbeResult =
  | { valid: true }
  | { valid: false; error: string };

/**
 * Prove a candidate decision model answers before its key is stored: one
 * trivial question over a one-word state. A refused credential is reported
 * as such; every other failure carries the transport's own message, so a
 * wrong model id or an unreachable endpoint is not read as a bad key.
 */
type ProbeDecisionModelOptions = {
  config: ResolvedDecisionModelConfig;
  timeoutMs: number;
  createClient?: typeof orgClient | undefined;
};

export const probeDecisionModel = async ({
  config,
  timeoutMs,
  createClient = orgClient,
}: ProbeDecisionModelOptions): Promise<DecisionModelProbeResult> => {
  const asked = await createClient(config).ask({
    state: "probe",
    questions: { probe: noul("Is `state` the word probe?") },
    abortSignal: AbortSignal.timeout(timeoutMs),
  });
  if (Result.isOk(asked)) {
    return { valid: true };
  }
  const { kind, status, message } = asked.error;
  if (kind === "http" && (status === 401 || status === 403)) {
    return { valid: false, error: "The decision model rejected the API key" };
  }
  return { valid: false, error: message };
};
