import type { FirstPartyModelProvider } from "@stll/ai-catalog";
import {
  BYOK_MODEL_OPTIONS,
  FIRST_PARTY_MODEL_PROVIDERS,
} from "@stll/ai-catalog";

/**
 * The discovery epoch is a reviewed baseline, not a rolling window. It never
 * advances automatically: every general-purpose model released from this date
 * onward must remain either offered or explicitly dispositioned below.
 */
export const MODEL_DISCOVERY_EPOCH = "2026-06-01";
const MODEL_DISCOVERY_EPOCH_MONTH = MODEL_DISCOVERY_EPOCH.slice(0, 7);
const ISO_RELEASE_DATE =
  /^\d{4}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?$/u;

export type UpstreamDiscoveryModel = {
  provider: FirstPartyModelProvider;
  modelId: string;
  releaseDate: string | null;
  status: string | null;
  toolCall: boolean | null;
  structuredOutput: boolean | null;
  outputModalities: readonly string[];
};

type DiscoveryModelKey = `${FirstPartyModelProvider}:${string}`;

type ModelGeneration = readonly [major: number, minor: number];

type ParsedModelFamily = {
  family: string;
  generation: ModelGeneration;
};

type FamilyParser = (modelId: string) => ParsedModelFamily | null;

const parseGeneration = (major: string, minor?: string): ModelGeneration => [
  Number(major),
  minor === undefined ? 0 : Number(minor),
];

// Version components are short; an eight-digit run is a release date suffix.
const MODEL_FAMILY_PARSERS = {
  anthropic: (modelId) => {
    const match =
      /^claude-(fable|haiku|opus|sonnet)-(\d{1,3})(?:[.-](\d{1,3}))?(?:-\d{8})?$/u.exec(
        modelId,
      );
    return match?.[1] !== undefined && match[2] !== undefined
      ? { family: match[1], generation: parseGeneration(match[2], match[3]) }
      : null;
  },
  google: (modelId) => {
    const match =
      /^gemini-(\d{1,3})(?:\.(\d{1,3}))?-(flash-lite|flash|pro)(?:-preview)?$/u.exec(
        modelId,
      );
    return match?.[3] !== undefined && match[1] !== undefined
      ? { family: match[3], generation: parseGeneration(match[1], match[2]) }
      : null;
  },
  mistral: (modelId) => {
    const match = /^mistral-(large|medium|small)-(\d{1,2})$/u.exec(modelId);
    return match?.[1] !== undefined && match[2] !== undefined
      ? { family: match[1], generation: parseGeneration(match[2]) }
      : null;
  },
  openai: (modelId) => {
    const match =
      /^gpt-(\d{1,3})(?:\.(\d{1,3}))?(?:-(?:astra|luna|sol|terra))?$/u.exec(
        modelId,
      );
    return match?.[1] !== undefined
      ? { family: "gpt", generation: parseGeneration(match[1], match[2]) }
      : null;
  },
} as const satisfies Record<FirstPartyModelProvider, FamilyParser>;

const KNOWN_NON_FAMILY_MODEL_PATTERNS = {
  anthropic: [] as const,
  google: [
    /^(?:deep-research|gemma|lyria|veo)-/u,
    /^gemini-(?:embedding|flash-latest|flash-lite-latest|omni-)/u,
    /^gemini-\d+(?:\.\d+)?-(?:computer-use|flash-image|flash-live|flash-tts|live-translate|pro-image)/u,
    /^gemini-\d+(?:\.\d+)?-(?:flash|pro)-preview-(?:customtools|tts)$/u,
    /^gemini-\d+(?:\.\d+)?-flash-lite-image$/u,
  ],
  mistral: [
    /^(?:codestral|devstral|glm|labs-|magistral|ministral|open-|pixtral|voxtral|zai-)/u,
    /^mistral-(?:embed|nemo)$/u,
    /^mistral-(?:large|medium|small)-(?:latest|\d{4})$/u,
  ],
  openai: [
    /^(?:chatgpt-image|gpt-image|gpt-realtime|o\d|text-embedding-)/u,
    /^gpt-(?:3\.5|4(?:\.1|o)?)(?:-|$)/u,
    /^gpt-\d+(?:\.\d+)?-(?:chat-latest|codex|mini|nano|pro)(?:-|$)/u,
    /^gpt-daybreak-/u,
  ],
} as const satisfies Record<FirstPartyModelProvider, readonly RegExp[]>;

export type GenerationExclusion = {
  reviewedOn: `${number}-${number}-${number}`;
  expiresOn: `${number}-${number}-${number}`;
  reason: string;
};

type GenerationExclusionKey = `${FirstPartyModelProvider}:${string}`;

// Keys are arbitrary upstream IDs; a missing entry means "not reviewed".
const NEWER_GENERATION_EXCLUSIONS: ReadonlyMap<
  GenerationExclusionKey,
  GenerationExclusion
> = new Map();

export type FindNewerGenerationModelsOptions = {
  upstreamIds: Readonly<Record<FirstPartyModelProvider, readonly string[]>>;
  offered?: Readonly<Record<FirstPartyModelProvider, readonly string[]>>;
  exclusions?: ReadonlyMap<GenerationExclusionKey, GenerationExclusion>;
  asOf: string;
};

export type GenerationGuardFailure =
  | {
      type: "newer-generation";
      provider: FirstPartyModelProvider;
      modelId: string;
    }
  | { type: "unparseable"; provider: FirstPartyModelProvider; modelId: string }
  | {
      type: "invalid-exclusion";
      provider: FirstPartyModelProvider;
      modelId: string;
    };

const compareGeneration = (left: ModelGeneration, right: ModelGeneration) =>
  left[0] - right[0] || left[1] - right[1];

const parseFamily = (
  provider: FirstPartyModelProvider,
  modelId: string,
): ParsedModelFamily | "known-non-family" | null => {
  const parsed = MODEL_FAMILY_PARSERS[provider](modelId);
  if (parsed !== null) {
    return parsed;
  }
  return KNOWN_NON_FAMILY_MODEL_PATTERNS[provider].some((pattern) =>
    pattern.test(modelId),
  )
    ? "known-non-family"
    : null;
};

export const findNewerGenerationModels = ({
  upstreamIds,
  offered = BYOK_MODEL_OPTIONS,
  exclusions = NEWER_GENERATION_EXCLUSIONS,
  asOf,
}: FindNewerGenerationModelsOptions): GenerationGuardFailure[] => {
  const failures: GenerationGuardFailure[] = [];

  for (const provider of FIRST_PARTY_MODEL_PROVIDERS) {
    const offeredGenerations = new Map<string, ModelGeneration>();
    for (const modelId of offered[provider]) {
      const parsed = parseFamily(provider, modelId);
      if (parsed === null) {
        failures.push({ type: "unparseable", provider, modelId });
        continue;
      }
      if (parsed === "known-non-family") {
        continue;
      }
      const current = offeredGenerations.get(parsed.family);
      if (
        current === undefined ||
        compareGeneration(parsed.generation, current) > 0
      ) {
        offeredGenerations.set(parsed.family, parsed.generation);
      }
    }

    for (const modelId of upstreamIds[provider]) {
      const parsed = parseFamily(provider, modelId);
      if (parsed === null) {
        failures.push({ type: "unparseable", provider, modelId });
        continue;
      }
      if (
        parsed === "known-non-family" ||
        offered[provider].includes(modelId)
      ) {
        continue;
      }
      const offeredGeneration = offeredGenerations.get(parsed.family);
      if (
        offeredGeneration === undefined ||
        compareGeneration(parsed.generation, offeredGeneration) <= 0
      ) {
        continue;
      }
      const exclusion = exclusions.get(`${provider}:${modelId}`);
      if (
        exclusion === undefined ||
        exclusion.reason.trim() === "" ||
        exclusion.reviewedOn > asOf ||
        exclusion.expiresOn < asOf
      ) {
        failures.push({
          type:
            exclusion === undefined ? "newer-generation" : "invalid-exclusion",
          provider,
          modelId,
        });
      }
    }
  }

  return failures.toSorted((left, right) =>
    `${left.provider}:${left.modelId}`.localeCompare(
      `${right.provider}:${right.modelId}`,
    ),
  );
};

/**
 * The only grounds on which a picker-relevant model may stay unoffered. The
 * picker offers every general-purpose first-party model; price, tier, and
 * product fit are the key holder's call and are not representable here.
 *
 * - `floating alias`: a pointer whose target moves, so it cannot carry fixed
 *   rates or capabilities.
 * - `duplicate alias`: another ID of a model the picker already offers.
 * - `third-party relay`: a model served through a provider that does not own
 *   it.
 */
type ReviewedExclusionCategory =
  | "floating alias"
  | "duplicate alias"
  | "third-party relay";
type DatedReviewReason =
  `${number}-${number}-${number}: ${ReviewedExclusionCategory}; ${string}`;

/**
 * Stable, general-purpose models intentionally not exposed in the picker.
 * Entries are exact and dated: a future ID can never inherit an exclusion.
 */
// oxlint-disable-next-line no-partial-record-satisfies/no-partial-record-satisfies -- DiscoveryModelKey is `${provider}:${string}`, an unbounded template-literal type; a total record is not constructible. Absence here means "no reviewed exclusion for this model ID" (the default, checked via `!== undefined` in findUnreviewedModels), not an unclassified union member.
const REVIEWED_MODEL_EXCLUSIONS = {
  "google:gemini-flash-latest":
    "2026-08-22: floating alias; do not offer or assign fixed-model metadata",
  "google:gemini-flash-lite-latest":
    "2026-08-22: floating alias; do not offer or assign fixed-model metadata",
  "mistral:zai-glm-5-2":
    "2026-08-28: third-party relay; GLM model served through the Mistral platform, not a Mistral model",
  "mistral:zai-glm-5-3":
    "2026-09-18: third-party relay; GLM model served through the Mistral platform, not a Mistral model",
  "openai:gpt-5.6-sol":
    "2026-08-28: duplicate alias; OpenAI's gpt-5.6 alias routes to Sol and is the offered picker ID",
  "openai:gpt-daybreak-blue-latest":
    "2026-09-28: floating alias; do not offer or assign fixed-model metadata",
  "openai:gpt-daybreak-red-latest":
    "2026-09-28: floating alias; do not offer or assign fixed-model metadata",
} as const satisfies Partial<Record<DiscoveryModelKey, DatedReviewReason>>;

export type FindUnreviewedModelsOptions = {
  upstream: readonly UpstreamDiscoveryModel[];
  offered: Readonly<Record<FirstPartyModelProvider, readonly string[]>>;
  reviewedExclusions?: Readonly<
    Partial<Record<DiscoveryModelKey, DatedReviewReason>>
  >;
};

/**
 * A model is picker-relevant when it is a newly released, provider-hosted,
 * general-purpose text model with the capabilities Stella's chat runtime
 * requires. Realtime/audio-output, embedding, media-generation, and deprecated
 * models stay outside this contract. Input modality and weight ownership do not
 * suppress discovery: those affect which roles a model can serve, not whether
 * maintainers must review it. Missing or malformed release dates fail closed,
 * and both `YYYY-MM` and `YYYY-MM-DD` values are compared at month precision,
 * because upstream metadata omissions must not make a new model invisible.
 */
export const isPickerRelevantUpstreamModel = (
  model: UpstreamDiscoveryModel,
): boolean =>
  (model.releaseDate === null ||
    !ISO_RELEASE_DATE.test(model.releaseDate) ||
    model.releaseDate.slice(0, 7) >= MODEL_DISCOVERY_EPOCH_MONTH) &&
  model.status !== "deprecated" &&
  model.toolCall === true &&
  model.structuredOutput === true &&
  model.outputModalities.length === 1 &&
  model.outputModalities.at(0) === "text";

/**
 * Returns every new picker-relevant upstream model that has received no
 * explicit repository decision. The nightly job fails on a non-empty result,
 * turning upstream launches into an exhaustive review queue instead of relying
 * on a maintainer to notice them.
 */
export const findUnreviewedModels = ({
  upstream,
  offered,
  reviewedExclusions = REVIEWED_MODEL_EXCLUSIONS,
}: FindUnreviewedModelsOptions): UpstreamDiscoveryModel[] => {
  const failures: UpstreamDiscoveryModel[] = [];

  for (const model of upstream) {
    if (!isPickerRelevantUpstreamModel(model)) {
      continue;
    }
    if (offered[model.provider].includes(model.modelId)) {
      continue;
    }
    const key: DiscoveryModelKey = `${model.provider}:${model.modelId}`;
    if (reviewedExclusions[key] !== undefined) {
      continue;
    }
    failures.push(model);
  }

  return failures.toSorted((left, right) => {
    const providerOrder = left.provider.localeCompare(right.provider);
    return providerOrder === 0
      ? left.modelId.localeCompare(right.modelId)
      : providerOrder;
  });
};
