/**
 * Lightweight provider key health-check. Calls the provider's
 * own auth/list-models endpoint (no token cost). Used pre-save
 * in BYOK flows so the user gets a green/red signal before
 * committing the config.
 */

const VALIDATION_TIMEOUT_MS = 5000;

export const PROVIDER_PROBE_VALUES = [
  "google",
  "openrouter",
  "openai",
  "anthropic",
] as const;

export type ProviderProbeValue = (typeof PROVIDER_PROBE_VALUES)[number];

export type ProviderProbeResult = { valid: boolean; error?: string };

type ProbeTarget = {
  url: string;
  init?: RequestInit;
};

const PROBE_TARGETS: Record<
  ProviderProbeValue,
  (apiKey: string) => ProbeTarget
> = {
  google: (apiKey) => ({
    url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
  }),
  anthropic: (apiKey) => ({
    url: "https://api.anthropic.com/v1/models",
    init: {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    },
  }),
  openai: (apiKey) => ({
    url: "https://api.openai.com/v1/models",
    init: { headers: { Authorization: `Bearer ${apiKey}` } },
  }),
  openrouter: (apiKey) => ({
    url: "https://openrouter.ai/api/v1/auth/key",
    init: { headers: { Authorization: `Bearer ${apiKey}` } },
  }),
};

const PROVIDER_LABELS: Record<ProviderProbeValue, string> = {
  google: "Google",
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

const extractDetail = async (response: Response): Promise<string | undefined> =>
  await response
    .clone()
    .json()
    .then((body: unknown) => {
      if (typeof body !== "object" || body === null) {
        return undefined;
      }
      if ("error" in body) {
        const { error } = body;
        if (typeof error === "string") {
          return error;
        }
        if (
          typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof error.message === "string"
        ) {
          return error.message;
        }
      }
      if ("message" in body && typeof body.message === "string") {
        return body.message;
      }
      return undefined;
    })
    .catch(() => undefined);

export const probeProvider = async (
  provider: ProviderProbeValue,
  apiKey: string,
): Promise<ProviderProbeResult> => {
  const signal = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
  const target = PROBE_TARGETS[provider](apiKey);
  const response = await fetch(target.url, { ...target.init, signal });

  if (response.ok) {
    return { valid: true };
  }

  const detail = await extractDetail(response);
  const label = PROVIDER_LABELS[provider];
  return {
    valid: false,
    error: detail
      ? `${label} rejected the key (HTTP ${response.status}): ${detail}`
      : `${label} rejected the key (HTTP ${response.status})`,
  };
};
