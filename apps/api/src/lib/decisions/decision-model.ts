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

/** One client constructor per provider; a provider without one cannot be added. */
const CLIENT_BY_PROVIDER = {
  typesafe: (config) =>
    createSystemOneClient({ apiKey: config.apiKey, model: config.modelId }),
} as const satisfies Record<
  DecisionModelProvider,
  (config: OrgDecisionModelConfig) => SystemOneClient
>;

const orgClient = (config: OrgDecisionModelConfig): SystemOneClient =>
  CLIENT_BY_PROVIDER[config.provider](config);

/** Funding belongs to the resolved credential, including injected clients. */
export type DecisionModel = SystemOneClient & {
  keySource: "byok" | "instance";
};

/** Whether the instance itself carries a decision model an org may fall back on. */
export const hasInstanceDecisionModel = (): boolean =>
  !env.REQUIRE_PERSONAL_AI_KEY && getSystemOneClient() !== null;

export const resolveDecisionModel = (
  orgAIConfig: OrgAIConfig | null | undefined,
): DecisionModel | null => {
  const decision = orgAIConfig?.decision ?? null;
  if (decision !== null) {
    return { ...orgClient(decision), keySource: "byok" };
  }
  const client = hasInstanceDecisionModel() ? getSystemOneClient() : null;
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
  if (kind === "http" && (status === 401 || status === 403)) {
    return { valid: false, error: "The decision model rejected the API key" };
  }
  return { valid: false, error: message };
};
