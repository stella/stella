import type { FirstPartyModelProvider } from "@stll/ai-catalog";

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
type DatedReviewReason = `${number}-${number}-${number}: ${string}`;

/**
 * Stable, general-purpose models intentionally not exposed in the picker.
 * Entries are exact and dated: a future ID can never inherit an exclusion.
 */
// oxlint-disable-next-line no-partial-record-satisfies/no-partial-record-satisfies -- DiscoveryModelKey is `${provider}:${string}`, an unbounded template-literal type; a total record is not constructible. Absence here means "no reviewed exclusion for this model ID" (the default, checked via `!== undefined` in findUnreviewedModels), not an unclassified union member.
export const REVIEWED_MODEL_EXCLUSIONS = {
  "google:gemini-flash-latest":
    "2026-08-22: floating alias pointer; do not offer or assign fixed-model metadata",
  "google:gemini-flash-lite-latest":
    "2026-08-22: floating alias pointer; do not offer or assign fixed-model metadata",
  "mistral:zai-glm-5-2":
    "2026-08-28: third-party GLM model relayed through the Mistral platform; not a Mistral first-party model",
  "openai:gpt-5.6-sol":
    "2026-08-28: OpenAI's gpt-5.6 alias routes to Sol; offer the alias as the canonical picker ID",
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

  return failures.sort((left, right) => {
    const providerOrder = left.provider.localeCompare(right.provider);
    return providerOrder === 0
      ? left.modelId.localeCompare(right.modelId)
      : providerOrder;
  });
};
