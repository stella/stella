import type {
  OpenRouterConfig,
  OpenRouterTextModelOptions,
} from "@tanstack/ai-openrouter";
import { panic, Result } from "better-result";

import { BYOK_MODEL_OPTIONS, getModelRate } from "@stll/ai-catalog";
import type { AIProvider } from "@stll/ai-catalog";
import { AI_FAILURE_CODES } from "@stll/api-contract";
import { classifyFailure } from "@stll/errors";
import { fetchWithTimeout, type FetchWithTimeoutInit } from "@stll/fetch";

import type { DecisionModelProvider } from "@/api/lib/ai-config";
import type {
  AIDataClass,
  ManagedAIResidency,
} from "@/api/lib/chat/ai-data-policy";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

type ManagedProvider = AIProvider | DecisionModelProvider | "agent_sandbox";

type ProviderDataPolicy =
  | { status: "unsupported" }
  | {
      status: "supported";
      serverURLs: Record<
        ManagedAIResidency,
        NonNullable<OpenRouterConfig["serverURL"]>
      >;
      provider: NonNullable<OpenRouterTextModelOptions["provider"]>;
    };

const MANAGED_EU_ORIGIN = "https://eu.openrouter.ai";
const MANAGED_US_ORIGIN = "https://us.openrouter.ai";
const MANAGED_PUBLIC_ORIGIN = "https://openrouter.ai";
const MANAGED_PROVIDER_REQUEST_TIMEOUT_MS = 16 * 60 * 1000;
const MANAGED_PROVIDER_ORIGINS = [
  MANAGED_EU_ORIGIN,
  MANAGED_US_ORIGIN,
] as const;

const MANAGED_OPENROUTER_POLICY = {
  status: "supported",
  serverURLs: {
    eu: `${MANAGED_EU_ORIGIN}/api/v1`,
    us: `${MANAGED_US_ORIGIN}/api/v1`,
  } satisfies Record<
    ManagedAIResidency,
    `${(typeof MANAGED_PROVIDER_ORIGINS)[number]}/api/v1`
  >,
  provider: { dataCollection: "deny", zdr: true },
} as const satisfies ProviderDataPolicy;

export const fetchManagedProviderCatalog = async (
  url: string,
  init: FetchWithTimeoutInit,
) => {
  const target = restrictOutboundUrl({
    rawUrl: url,
    hostPolicy: { type: "exact-origin", origins: MANAGED_PROVIDER_ORIGINS },
    pathPrefixes: ["/api/v1/models"],
  });
  if (target === null) {
    return panic("Managed catalog target is outside the provider policy.");
  }
  return await fetchWithTimeout(target, { ...init, redirect: "error" });
};

export const PROVIDER_DATA_POLICY = {
  byok: { status: "unchanged" },
  public_corpus: {
    ...MANAGED_OPENROUTER_POLICY,
    managedAIResidency: "eu",
  },
  customer: {
    google: { status: "unsupported" },
    openrouter: MANAGED_OPENROUTER_POLICY,
    // Generative and decision requests use the org credential under BYOK.
    openai: { status: "unsupported" },
    azure_foundry: { status: "unsupported" },
    anthropic: { status: "unsupported" },
    bedrock: { status: "unsupported" },
    mistral: { status: "unsupported" },
    openai_compatible: { status: "unsupported" },
    huggingface: { status: "unsupported" },
    typesafe: { status: "unsupported" },
    agent_sandbox: { status: "unsupported" },
  },
} as const satisfies {
  byok: { status: "unchanged" };
  public_corpus: Extract<ProviderDataPolicy, { status: "supported" }> & {
    managedAIResidency: "eu";
  };
  customer: Record<ManagedProvider, ProviderDataPolicy>;
};

export const MANAGED_PROVIDER_UNAVAILABLE_CODE =
  AI_FAILURE_CODES.managed_provider_unavailable;

export const managedProviderUnavailable = (
  provider: string,
  cause?: unknown,
): HandlerError<503> =>
  classifyFailure(
    new HandlerError({
      status: 503,
      code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
      cause,
      message: `Managed AI is not available for provider "${provider}" with the configured request policy. Configure an organization AI key or contact your administrator.`,
    }),
    "model_unavailable",
  );

export const fetchManagedOpenRouterCompletion = async (completion: Request) => {
  const euEndpoint = `${MANAGED_EU_ORIGIN}/api/v1/chat/completions`;
  const usEndpoint = `${MANAGED_US_ORIGIN}/api/v1/chat/completions`;
  const publicEndpoint = `${MANAGED_PUBLIC_ORIGIN}/api/v1/chat/completions`;
  const regionalEndpoint =
    completion.url === euEndpoint ? euEndpoint : usEndpoint;
  const endpoint =
    completion.url === publicEndpoint ? publicEndpoint : regionalEndpoint;
  if (endpoint !== completion.url) {
    return Result.err(managedProviderUnavailable("openrouter"));
  }
  // Manual mode exposes redirects without forwarding the request body.
  const fetched = await Result.tryPromise({
    try: async () =>
      await fetchWithTimeout(endpoint, {
        method: completion.method,
        headers: completion.headers,
        body: completion.body,
        signal: completion.signal,
        timeoutMs: MANAGED_PROVIDER_REQUEST_TIMEOUT_MS,
        redirect: "manual",
      }),
    catch: (error) => error,
  });
  if (Result.isError(fetched)) {
    return fetched;
  }
  const response = fetched.value;
  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    const cancelled = await Result.tryPromise(
      async () => await response.body?.cancel(),
    );
    return Result.err(
      managedProviderUnavailable(
        "openrouter",
        Result.isError(cancelled) ? cancelled.error : undefined,
      ),
    );
  }
  return Result.ok(response);
};

/**
 * Where audio goes: the organization's region, or the global endpoint for a
 * model its region does not serve, which a member chose knowing it leaves
 * the region. Every endpoint gets the same zero-retention provider policy.
 */
export const MANAGED_TRANSCRIPTION_URLS = {
  eu: `${MANAGED_EU_ORIGIN}/api/v1/audio/transcriptions`,
  us: `${MANAGED_US_ORIGIN}/api/v1/audio/transcriptions`,
  global: `${MANAGED_PUBLIC_ORIGIN}/api/v1/audio/transcriptions`,
} as const satisfies Record<ManagedAIResidency | "global", string>;

const TRANSCRIPTION_ORIGINS = [
  ...MANAGED_PROVIDER_ORIGINS,
  MANAGED_PUBLIC_ORIGIN,
] as const;

/** Audio requests go only to a known transcription endpoint and refuse
 *  redirects. */
export const fetchManagedOpenRouterTranscription = async (
  input: string | URL,
  init: FetchWithTimeoutInit,
) => {
  const target = restrictOutboundUrl({
    rawUrl: String(input),
    hostPolicy: { type: "exact-origin", origins: TRANSCRIPTION_ORIGINS },
    pathPrefixes: ["/api/v1/audio/transcriptions"],
  });
  if (
    target === null ||
    !Object.values(MANAGED_TRANSCRIPTION_URLS).some(
      (url) => url === target.href,
    )
  ) {
    return panic("Transcription target is outside the provider policy.");
  }
  return await fetchWithTimeout(target, { ...init, redirect: "error" });
};

const ELEVENLABS_DEFAULT_ORIGIN = "https://api.elevenlabs.io";
const ELEVENLABS_US_ORIGIN = "https://api.us.elevenlabs.io";
const ELEVENLABS_EU_ORIGIN = "https://api.eu.residency.elevenlabs.io";
const ELEVENLABS_TRANSCRIPTION_ORIGINS = [
  ELEVENLABS_DEFAULT_ORIGIN,
  ELEVENLABS_US_ORIGIN,
  ELEVENLABS_EU_ORIGIN,
] as const;

/** The ElevenLabs environments a deployment key can belong to. */
export type ElevenLabsEnvironment = "default" | "us" | "eu";

// A key works only on its own environment's origin.
const ELEVENLABS_ORIGINS = {
  default: ELEVENLABS_DEFAULT_ORIGIN,
  us: ELEVENLABS_US_ORIGIN,
  eu: ELEVENLABS_EU_ORIGIN,
} as const satisfies Record<
  ElevenLabsEnvironment,
  (typeof ELEVENLABS_TRANSCRIPTION_ORIGINS)[number]
>;

/**
 * Where ElevenLabs transcription goes. With zero retention ElevenLabs keeps
 * neither the audio nor the transcript beyond the request; an account
 * without it cannot ask for it.
 */
export const elevenLabsTranscriptionUrl = (
  environment: ElevenLabsEnvironment,
  zeroRetention: boolean,
) =>
  `${ELEVENLABS_ORIGINS[environment]}/v1/speech-to-text${zeroRetention ? "?enable_logging=false" : ""}`;

const ELEVENLABS_TRANSCRIPTION_URLS: ReadonlySet<string> = new Set(
  (["default", "us", "eu"] as const).flatMap((environment) => [
    elevenLabsTranscriptionUrl(environment, true),
    elevenLabsTranscriptionUrl(environment, false),
  ]),
);

/** Audio goes only to the transcription URL of a known ElevenLabs
 *  environment, and redirects are refused. */
export const fetchElevenLabsTranscription = async (
  input: string | URL,
  init: FetchWithTimeoutInit,
) => {
  const target = restrictOutboundUrl({
    rawUrl: String(input),
    hostPolicy: {
      type: "exact-origin",
      origins: ELEVENLABS_TRANSCRIPTION_ORIGINS,
    },
    pathPrefixes: ["/v1/speech-to-text"],
  });
  if (target === null || !ELEVENLABS_TRANSCRIPTION_URLS.has(target.href)) {
    return panic("Transcription target is outside the provider policy.");
  }
  return await fetchWithTimeout(target, { ...init, redirect: "error" });
};

const ELEVENLABS_TRANSCRIPTS_PATH = "/v1/speech-to-text/transcripts/";
// The ids ElevenLabs issues; anything else could escape the path.
const ELEVENLABS_TRANSCRIPT_ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** Where ElevenLabs deletes a transcript it kept, or `null` for an id it
 *  would not issue. */
export const elevenLabsTranscriptUrl = (
  environment: ElevenLabsEnvironment,
  transcriptionId: string,
) =>
  ELEVENLABS_TRANSCRIPT_ID.test(transcriptionId)
    ? `${ELEVENLABS_ORIGINS[environment]}${ELEVENLABS_TRANSCRIPTS_PATH}${transcriptionId}`
    : null;

/** A kept transcript is deleted only at the transcript URL of a known
 *  ElevenLabs environment, and redirects are refused. */
export const deleteElevenLabsTranscript = async (
  input: string | URL,
  init: FetchWithTimeoutInit,
) => {
  const target = restrictOutboundUrl({
    rawUrl: String(input),
    hostPolicy: {
      type: "exact-origin",
      origins: ELEVENLABS_TRANSCRIPTION_ORIGINS,
    },
    pathPrefixes: [ELEVENLABS_TRANSCRIPTS_PATH],
  });
  if (
    target === null ||
    target.search !== "" ||
    !ELEVENLABS_TRANSCRIPT_ID.test(
      target.pathname.slice(ELEVENLABS_TRANSCRIPTS_PATH.length),
    )
  ) {
    return panic("Transcript deletion target is outside the provider policy.");
  }
  return await fetchWithTimeout(target, {
    ...init,
    method: "DELETE",
    redirect: "error",
  });
};

export const isManagedProviderAvailable = (
  provider: ManagedProvider,
  dataClass: AIDataClass,
): boolean =>
  dataClass === "public_corpus" ||
  PROVIDER_DATA_POLICY.customer[provider].status === "supported";

export const checkManagedProviderAvailable = (
  provider: ManagedProvider,
  dataClass: AIDataClass,
): Result<void, HandlerError<503>> =>
  isManagedProviderAvailable(provider, dataClass)
    ? Result.ok(undefined)
    : Result.err(managedProviderUnavailable(provider));

export const withoutModelVariant = (model: string): string => {
  const variantStart = model.indexOf(":", model.lastIndexOf("/") + 1);
  return variantStart === -1 ? model : model.slice(0, variantStart);
};

const OPENROUTER_AUTO_MODEL_ID = "openrouter/auto";
const GLOBAL_ONLY_OPENROUTER_VARIANT = /:(?:batch|online)(?=:|$)/u;

/** Reject unsafe selections before normalizing pure routing hints. */
export const assertManagedOpenRouterModel = (
  modelId: string,
): Result<void, HandlerError<503>> => {
  const catalog: readonly string[] = BYOK_MODEL_OPTIONS.openrouter;
  if (
    modelId === OPENROUTER_AUTO_MODEL_ID ||
    GLOBAL_ONLY_OPENROUTER_VARIANT.test(modelId)
  ) {
    return Result.err(managedProviderUnavailable("openrouter"));
  }
  const model = withoutModelVariant(modelId);
  if (!catalog.includes(model) || getModelRate(model) === undefined) {
    return Result.err(managedProviderUnavailable("openrouter"));
  }
  return Result.ok(undefined);
};
