type TranscriptionDurationPrice = {
  kind: "audio-second";
  usdNumerator: number;
  secondsDenominator: number;
};

/** Where an organization's managed AI runs. */
export type TranscriptionResidency = "eu" | "us";
/** The provider endpoint a request is served from: the organization's
 *  region, or the global endpoint for a model its region does not serve. */
export type TranscriptionEndpoint = TranscriptionResidency | "global";

type TranscriptionRegionalAvailability =
  | { status: "available"; price: TranscriptionDurationPrice }
  | { status: "unavailable" | "unknown" };

type TranscriptionModelMetadata = {
  displayName: string;
  /** The company behind the model, shown beside its name. */
  provider: string;
  /** The global endpoint's price; each endpoint bills its own. */
  price: TranscriptionDurationPrice;
  languageClaim: string;
  /** Granularities supported by the cited evidence; word includes segments. */
  timestamps: "none" | "segment" | "word";
  vocabularyMechanism:
    "none" | "groq-prompt" | "azure-phrase-list" | "context-hint";
  diarization: "supported" | "unconfirmed";
  residency: Record<TranscriptionEndpoint, TranscriptionRegionalAvailability>;
  source: { url: string; checkedAt: string };
};

const perSecond = (
  usdNumerator: number,
  secondsDenominator: number,
): TranscriptionDurationPrice => ({
  kind: "audio-second",
  usdNumerator,
  secondsDenominator,
});

const at = (
  price: TranscriptionDurationPrice,
): TranscriptionRegionalAvailability => ({ status: "available", price });

const UNAVAILABLE: TranscriptionRegionalAvailability = {
  status: "unavailable",
};

const CHECKED_AT = "2026-11-16";

// Curated from public model pages and each OpenRouter endpoint's model list
// (`/api/v1/models?output_modalities=transcription` on openrouter.ai,
// eu.openrouter.ai and us.openrouter.ai). Only models with a zero data
// retention endpoint are offered; requests require one.
export const TRANSCRIPTION_MODELS = {
  "openai/whisper-large-v3-turbo": {
    displayName: "Whisper Large V3 Turbo",
    provider: "OpenAI",
    price: perSecond(1, 300_000),
    languageClaim: "99+ languages",
    timestamps: "none",
    vocabularyMechanism: "groq-prompt",
    diarization: "unconfirmed",
    residency: {
      eu: UNAVAILABLE,
      us: at(perSecond(1, 300_000)),
      global: at(perSecond(1, 300_000)),
    },
    source: {
      url: "https://openrouter.ai/openai/whisper-large-v3-turbo",
      checkedAt: CHECKED_AT,
    },
  },
  "openai/whisper-large-v3": {
    displayName: "Whisper Large V3",
    provider: "OpenAI",
    price: perSecond(3, 400_000),
    languageClaim: "99+ languages",
    timestamps: "word",
    vocabularyMechanism: "groq-prompt",
    diarization: "unconfirmed",
    residency: {
      eu: UNAVAILABLE,
      us: at(perSecond(3, 400_000)),
      global: at(perSecond(3, 400_000)),
    },
    source: {
      url: "https://openrouter.ai/openai/whisper-large-v3",
      checkedAt: CHECKED_AT,
    },
  },
  "nvidia/parakeet-tdt-0.6b-v3": {
    displayName: "Parakeet TDT 0.6B v3",
    provider: "NVIDIA",
    price: perSecond(1, 60_000),
    languageClaim: "All official EU languages",
    timestamps: "segment",
    vocabularyMechanism: "none",
    diarization: "unconfirmed",
    residency: {
      eu: UNAVAILABLE,
      us: UNAVAILABLE,
      global: at(perSecond(1, 60_000)),
    },
    source: {
      url: "https://openrouter.ai/nvidia/parakeet-tdt-0.6b-v3",
      checkedAt: CHECKED_AT,
    },
  },
  "microsoft/mai-transcribe-2": {
    displayName: "MAI-Transcribe 2",
    provider: "Microsoft",
    price: perSecond(1, 36_000),
    languageClaim: "60 languages",
    timestamps: "word",
    vocabularyMechanism: "azure-phrase-list",
    diarization: "supported",
    residency: {
      eu: UNAVAILABLE,
      us: UNAVAILABLE,
      global: at(perSecond(1, 36_000)),
    },
    source: {
      url: "https://openrouter.ai/microsoft/mai-transcribe-2",
      checkedAt: CHECKED_AT,
    },
  },
  "elevenlabs/scribe-v2": {
    displayName: "Scribe v2",
    provider: "ElevenLabs",
    price: perSecond(11, 180_000),
    languageClaim: "90+ languages",
    timestamps: "word",
    vocabularyMechanism: "none",
    diarization: "supported",
    residency: {
      eu: UNAVAILABLE,
      us: UNAVAILABLE,
      global: at(perSecond(11, 180_000)),
    },
    source: {
      url: "https://openrouter.ai/elevenlabs/scribe-v2",
      checkedAt: CHECKED_AT,
    },
  },
  "google/chirp-3": {
    displayName: "Chirp 3",
    provider: "Google",
    price: perSecond(1, 3750),
    languageClaim: "24 languages, 77+ in preview",
    timestamps: "none",
    vocabularyMechanism: "none",
    diarization: "unconfirmed",
    residency: {
      eu: UNAVAILABLE,
      us: UNAVAILABLE,
      global: at(perSecond(1, 3750)),
    },
    source: {
      url: "https://openrouter.ai/google/chirp-3",
      checkedAt: CHECKED_AT,
    },
  },
  "deepgram/nova-3": {
    displayName: "Nova-3",
    provider: "Deepgram",
    price: perSecond(43, 600_000),
    languageClaim: "Multilingual; language count not specified",
    timestamps: "none",
    vocabularyMechanism: "none",
    diarization: "unconfirmed",
    residency: {
      eu: UNAVAILABLE,
      us: UNAVAILABLE,
      global: at(perSecond(43, 600_000)),
    },
    source: {
      url: "https://openrouter.ai/deepgram/nova-3",
      checkedAt: CHECKED_AT,
    },
  },
  "assemblyai/universal-3-6-pro": {
    displayName: "Universal-3.6 Pro",
    provider: "AssemblyAI",
    price: perSecond(1, 12_000),
    languageClaim: "Multilingual; language count not specified",
    timestamps: "none",
    vocabularyMechanism: "none",
    diarization: "unconfirmed",
    residency: {
      eu: UNAVAILABLE,
      us: UNAVAILABLE,
      global: at(perSecond(1, 12_000)),
    },
    source: {
      url: "https://openrouter.ai/assemblyai/universal-3-6-pro",
      checkedAt: CHECKED_AT,
    },
  },
  "mistralai/voxtral-mini-transcribe": {
    displayName: "Voxtral Mini Transcribe",
    provider: "Mistral",
    price: perSecond(1, 20_000),
    languageClaim: "Not specified",
    timestamps: "none",
    vocabularyMechanism: "none",
    diarization: "unconfirmed",
    residency: {
      eu: at(perSecond(11, 200_000)),
      us: UNAVAILABLE,
      global: at(perSecond(1, 20_000)),
    },
    source: {
      url: "https://openrouter.ai/mistralai/voxtral-mini-transcribe",
      checkedAt: CHECKED_AT,
    },
  },
  "mistralai/voxtral-mini-transcribe-3-0": {
    displayName: "Voxtral Mini Transcribe 3.0",
    provider: "Mistral",
    price: perSecond(7, 120_000),
    languageClaim: "Not specified",
    timestamps: "none",
    vocabularyMechanism: "none",
    diarization: "unconfirmed",
    residency: {
      eu: at(perSecond(77, 1_200_000)),
      us: at(perSecond(77, 1_200_000)),
      global: at(perSecond(7, 120_000)),
    },
    source: {
      url: "https://openrouter.ai/mistralai/voxtral-mini-transcribe-3-0",
      checkedAt: CHECKED_AT,
    },
  },
  "mistralai/voxtral-small-transcribe-3-0": {
    displayName: "Voxtral Small Transcribe 3.0",
    provider: "Mistral",
    price: perSecond(1, 15_000),
    languageClaim: "Not specified",
    timestamps: "none",
    vocabularyMechanism: "none",
    diarization: "unconfirmed",
    residency: {
      eu: at(perSecond(11, 150_000)),
      us: at(perSecond(11, 150_000)),
      global: at(perSecond(1, 15_000)),
    },
    source: {
      url: "https://openrouter.ai/mistralai/voxtral-small-transcribe-3-0",
      checkedAt: CHECKED_AT,
    },
  },
  "openai/gpt-transcribe": {
    displayName: "GPT Transcribe",
    provider: "OpenAI",
    price: perSecond(3, 40_000),
    languageClaim: "Multilingual; language count not specified",
    timestamps: "none",
    vocabularyMechanism: "context-hint",
    diarization: "unconfirmed",
    // No zero data retention endpoint, so no endpoint offers it.
    residency: { eu: UNAVAILABLE, us: UNAVAILABLE, global: UNAVAILABLE },
    source: {
      url: "https://openrouter.ai/openai/gpt-transcribe",
      checkedAt: CHECKED_AT,
    },
  },
} as const satisfies Record<string, TranscriptionModelMetadata>;

export type TranscriptionModelId = keyof typeof TRANSCRIPTION_MODELS;
export type TranscriptionModel =
  (typeof TRANSCRIPTION_MODELS)[TranscriptionModelId];
export type TranscriptionVocabularyMechanism =
  TranscriptionModelMetadata["vocabularyMechanism"];

export const isTranscriptionModelId = (
  modelId: string,
): modelId is TranscriptionModelId =>
  Object.hasOwn(TRANSCRIPTION_MODELS, modelId);

const availabilityAt = (
  modelId: TranscriptionModelId,
  endpoint: TranscriptionEndpoint,
): TranscriptionRegionalAvailability =>
  TRANSCRIPTION_MODELS[modelId].residency[endpoint];

/**
 * The endpoint that serves a model for an organization: its own region when
 * that region offers the model, otherwise the global endpoint, but only when
 * the caller accepts a model outside the region. `undefined` when neither
 * serves it.
 */
export const transcriptionEndpointFor = (
  modelId: TranscriptionModelId,
  residency: TranscriptionResidency,
  { outsideRegion }: { outsideRegion: boolean },
): TranscriptionEndpoint | undefined => {
  if (availabilityAt(modelId, residency).status === "available") {
    return residency;
  }
  if (
    outsideRegion &&
    availabilityAt(modelId, "global").status === "available"
  ) {
    return "global";
  }
  return undefined;
};

/**
 * The model a caller gets when it names none: the cheapest one offered in
 * the organization's region at that region's price, or `undefined` when the
 * region offers none. Ties keep catalog order. A default never leaves the
 * region.
 */
export const defaultTranscriptionModelId = (
  residency: TranscriptionResidency,
): TranscriptionModelId | undefined => {
  let cheapest:
    | { modelId: TranscriptionModelId; price: TranscriptionDurationPrice }
    | undefined;
  for (const modelId of Object.keys(TRANSCRIPTION_MODELS)) {
    if (!isTranscriptionModelId(modelId)) {
      continue;
    }
    const regional = availabilityAt(modelId, residency);
    if (regional.status !== "available") {
      continue;
    }
    const { price } = regional;
    if (
      cheapest === undefined ||
      price.usdNumerator * cheapest.price.secondsDenominator <
        cheapest.price.usdNumerator * price.secondsDenominator
    ) {
      cheapest = { modelId, price };
    }
  }
  return cheapest?.modelId;
};

export const getTranscriptionModel = (modelId: string) =>
  Object.hasOwn(TRANSCRIPTION_MODELS, modelId) &&
  isTranscriptionModelId(modelId)
    ? TRANSCRIPTION_MODELS[modelId]
    : undefined;
