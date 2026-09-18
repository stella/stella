/**
 * Which decision model answers for an organization.
 *
 * The org's own, from its AI config, when it has one; otherwise the
 * instance's, from the environment, unless the deployment requires every
 * org to bring its own keys. Null means no typed decision runs anywhere and
 * every `decide` call comes back undecided, which is the ordinary state of a
 * self-hosted instance without a decision model.
 */

import { Result } from "better-result";

import { env } from "@/api/env";
import type {
  DecisionModelProvider,
  OrgAIConfig,
  OrgDecisionModelConfig,
} from "@/api/lib/ai-config";
import { createSystemOneClient, noul } from "@/api/lib/decisions/system-one";
import type { SystemOneClient } from "@/api/lib/decisions/system-one";
import { getSystemOneClient } from "@/api/lib/decisions/system-one-runtime";

/** Clients keep no connection; the cache only spares rebuilding one per call. */
const ORG_CLIENT_CACHE_MAX = 64;
const orgClients = new Map<string, SystemOneClient>();

/** One client constructor per provider; a provider without one cannot be added. */
const CLIENT_BY_PROVIDER = {
  typesafe: (config) =>
    createSystemOneClient({ apiKey: config.apiKey, model: config.modelId }),
} as const satisfies Record<
  DecisionModelProvider,
  (config: OrgDecisionModelConfig) => SystemOneClient
>;

const orgClient = (config: OrgDecisionModelConfig): SystemOneClient => {
  const key = [config.provider, config.modelId, config.apiKey].join("|");
  const cached = orgClients.get(key);
  if (cached !== undefined) {
    return cached;
  }
  if (orgClients.size >= ORG_CLIENT_CACHE_MAX) {
    const oldest = orgClients.keys().next().value;
    if (oldest !== undefined) {
      orgClients.delete(oldest);
    }
  }
  const client = CLIENT_BY_PROVIDER[config.provider](config);
  orgClients.set(key, client);
  return client;
};

/** Whether the instance itself carries a decision model an org may fall back on. */
export const hasInstanceDecisionModel = (): boolean =>
  !env.REQUIRE_PERSONAL_AI_KEY && getSystemOneClient() !== null;

export const resolveDecisionModel = (
  orgAIConfig: OrgAIConfig | null | undefined,
): SystemOneClient | null => {
  const decision = orgAIConfig?.decision ?? null;
  if (decision !== null) {
    return orgClient(decision);
  }
  return hasInstanceDecisionModel() ? getSystemOneClient() : null;
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
export const probeDecisionModel = async (
  config: OrgDecisionModelConfig,
  timeoutMs: number,
): Promise<DecisionModelProbeResult> => {
  const asked = await orgClient(config).ask({
    state: "probe",
    questions: { probe: noul("Is `state` the word probe?") },
    abortSignal: AbortSignal.timeout(timeoutMs),
  });
  if (Result.isOk(asked)) {
    return { valid: true };
  }
  const { kind, status, message } = asked.error;
  if (
    kind === "unconfigured" ||
    (kind === "http" && (status === 401 || status === 403))
  ) {
    return { valid: false, error: "The decision model rejected the API key" };
  }
  return { valid: false, error: message };
};
