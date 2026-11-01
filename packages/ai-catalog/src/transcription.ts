type TranscriptionDurationPrice = {
  kind: "audio-second";
  usdNumerator: number;
  secondsDenominator: number;
};

type TranscriptionRegionalAvailability =
  | { status: "available"; price: TranscriptionDurationPrice }
  | { status: "unavailable" | "unknown" };

type TranscriptionModelMetadata = {
  displayName: string;
  price: TranscriptionDurationPrice;
  languageClaim: string;
  /** Granularities supported by the cited evidence; word includes segments. */
  timestamps: "none" | "segment" | "word";
  vocabularyMechanism:
    "none" | "groq-prompt" | "azure-phrase-list" | "context-hint";
  diarization: "supported" | "unconfirmed";
  residency: Record<"eu" | "us", TranscriptionRegionalAvailability>;
  source: { url: string; checkedAt: string };
};

// Curated from public model pages; independent of the generated text-model rates.
export const TRANSCRIPTION_MODELS = {
  "openai/whisper-large-v3-turbo": {
    displayName: "Whisper Large V3 Turbo",
    price: {
      kind: "audio-second",
      usdNumerator: 3,
      secondsDenominator: 1_000_000,
    },
    languageClaim: "99+ languages",
    timestamps: "none",
    vocabularyMechanism: "groq-prompt",
    diarization: "unconfirmed",
    residency: { eu: { status: "unavailable" }, us: { status: "unknown" } },
    source: {
      url: "https://openrouter.ai/openai/whisper-large-v3-turbo",
      checkedAt: "2026-10-29",
    },
  },
  "openai/whisper-large-v3": {
    displayName: "Whisper Large V3",
    price: {
      kind: "audio-second",
      usdNumerator: 8,
      secondsDenominator: 1_000_000,
    },
    languageClaim: "99+ languages",
    timestamps: "word",
    vocabularyMechanism: "groq-prompt",
    diarization: "unconfirmed",
    residency: { eu: { status: "unavailable" }, us: { status: "unknown" } },
    source: {
      url: "https://openrouter.ai/openai/whisper-large-v3",
      checkedAt: "2026-10-29",
    },
  },
  "nvidia/parakeet-tdt-0.6b-v3": {
    displayName: "Parakeet TDT 0.6B v3",
    price: {
      kind: "audio-second",
      usdNumerator: 25,
      secondsDenominator: 1_000_000,
    },
    languageClaim: "All official EU languages",
    timestamps: "segment",
    vocabularyMechanism: "none",
    diarization: "unconfirmed",
    residency: { eu: { status: "unavailable" }, us: { status: "unknown" } },
    source: {
      url: "https://openrouter.ai/nvidia/parakeet-tdt-0.6b-v3",
      checkedAt: "2026-10-29",
    },
  },
  "microsoft/mai-transcribe-2": {
    displayName: "MAI-Transcribe 2",
    price: {
      kind: "audio-second",
      usdNumerator: 1,
      secondsDenominator: 36_000,
    },
    languageClaim: "60 languages",
    timestamps: "word",
    vocabularyMechanism: "azure-phrase-list",
    diarization: "supported",
    residency: { eu: { status: "unavailable" }, us: { status: "unknown" } },
    source: {
      url: "https://openrouter.ai/microsoft/mai-transcribe-2",
      checkedAt: "2026-10-29",
    },
  },
  "elevenlabs/scribe-v2": {
    displayName: "Scribe v2",
    price: {
      kind: "audio-second",
      usdNumerator: 61,
      secondsDenominator: 1_000_000,
    },
    languageClaim: "90+ languages",
    timestamps: "word",
    vocabularyMechanism: "none",
    diarization: "supported",
    residency: { eu: { status: "unavailable" }, us: { status: "unknown" } },
    source: {
      url: "https://openrouter.ai/elevenlabs/scribe-v2",
      checkedAt: "2026-10-29",
    },
  },
  "mistralai/voxtral-mini-transcribe": {
    displayName: "Voxtral Mini Transcribe",
    price: {
      kind: "audio-second",
      usdNumerator: 50,
      secondsDenominator: 1_000_000,
    },
    languageClaim: "Not specified",
    timestamps: "none",
    vocabularyMechanism: "none",
    diarization: "unconfirmed",
    residency: {
      eu: {
        status: "available",
        price: {
          kind: "audio-second",
          usdNumerator: 55,
          secondsDenominator: 1_000_000,
        },
      },
      us: { status: "unknown" },
    },
    source: {
      url: "https://openrouter.ai/mistralai/voxtral-mini-transcribe",
      checkedAt: "2026-10-29",
    },
  },
  "openai/gpt-transcribe": {
    displayName: "GPT Transcribe",
    price: {
      kind: "audio-second",
      usdNumerator: 75,
      secondsDenominator: 1_000_000,
    },
    languageClaim: "Multilingual; language count not specified",
    timestamps: "none",
    vocabularyMechanism: "context-hint",
    diarization: "unconfirmed",
    residency: { eu: { status: "unavailable" }, us: { status: "unknown" } },
    source: {
      url: "https://openrouter.ai/openai/gpt-transcribe",
      checkedAt: "2026-10-29",
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

export const getTranscriptionModel = (modelId: string) =>
  Object.hasOwn(TRANSCRIPTION_MODELS, modelId) &&
  isTranscriptionModelId(modelId)
    ? TRANSCRIPTION_MODELS[modelId]
    : undefined;
