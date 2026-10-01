import { panic } from "better-result";

import {
  isBYOKModelRoleSupported,
  REASONING_EFFORTS,
  supportsStreamingToolUse,
  TANSTACK_AI_PROVIDERS,
} from "@stll/ai-catalog";
import type { ReasoningEffort, TanStackAIProvider } from "@stll/ai-catalog";
import { CHAT_SEND_MODE, CHAT_SEND_MODES } from "@stll/anonymize-chat";
import { CHAT_RUN_MODE } from "@stll/api-contract";
import type { ChatRunMode } from "@stll/api-contract";

import { modelAcceptsDocumentAttachment } from "@/api/handlers/chat/attachment-modality";
import { TEXT_CSV_MIME_TYPE } from "@/api/handlers/chat/attachment-validation";
import { canHydrateFilePartAsPlainText } from "@/api/handlers/chat/upload-files";
import { isChatModelReasoningEffortAvailable } from "@/api/lib/chat-model-selection";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";
import { REASONING_ANSWERS } from "@/api/tests/helpers/provider-reasoning-answers";
import { cassetteFor } from "@/api/tests/helpers/provider-wire-cassette";
import type { ProviderWireCassette } from "@/api/tests/helpers/provider-wire-cassette";
import { wireSideModel } from "@/api/tests/helpers/provider-wire-contract";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// The discrete ways a chat turn's provider request can differ, as typed
// dimensions, and every combination of them the product can produce. A
// thread can switch its chat model between messages, so a request is built
// from history another provider, or another model, produced; the turn then
// carries its own attachment, reasoning effort and tool surface, under the
// organization's caching setting. A combination is excluded only where a
// production predicate says the product cannot produce it, and each
// exclusion names the predicate.

/** The models a provider's conversations run on: the model its corpus was
 *  recorded with, and another of its catalog models. */
const MODEL_SLOTS = ["recorded", "alternate"] as const;
type ModelSlot = (typeof MODEL_SLOTS)[number];

/** A provider and one of its models. */
export type ModelEndpoint = { provider: TanStackAIProvider; slot: ModelSlot };

/**
 * What the origin's history holds besides the call and its result: nothing
 * more, or the reasoning its model returned before the call (signed, where
 * the provider signs it: Anthropic, OpenAI, Gemini).
 */
const HISTORY_VARIANTS = ["plain", "reasoning"] as const;
export type HistoryVariant = (typeof HISTORY_VARIANTS)[number];

/**
 * A part the stored history holds that no model answer here produces: none,
 * or a completed structured output (the part policy lets a page send one
 * back, and the model reads it as text).
 */
const STORED_PARTS = ["none", "structured-output"] as const;
type StoredPart = (typeof STORED_PARTS)[number];

/** Whether the thread was compacted before the continuing turn, so its
 *  request starts from the stored summary. */
const COMPACTIONS = ["none", "compacted"] as const;
type Compaction = (typeof COMPACTIONS)[number];

/** The organization's prompt caching setting (`resolveCaching`). */
export const CACHING_SETTINGS = ["off", "on"] as const;
export type CachingSetting = (typeof CACHING_SETTINGS)[number];

/**
 * What the continuing turn's message attaches, by the part it reaches the
 * model as (`hydrateFilePart`): an image part, a PDF document part, a text
 * part a direct-text file becomes, or the text an office file is extracted
 * to.
 */
export const ATTACHMENTS = {
  none: undefined,
  image: { fileName: "scan.png", mimeType: "image/png" },
  pdf: { fileName: "brief.pdf", mimeType: PDF_MIME_TYPE },
  text: { fileName: "ledger.csv", mimeType: TEXT_CSV_MIME_TYPE },
  office: { fileName: "draft.docx", mimeType: DOCX_MIME_TYPE },
} as const satisfies Record<
  string,
  { fileName: string; mimeType: string } | undefined
>;
export type AttachmentKind = keyof typeof ATTACHMENTS;
const ATTACHMENT_KINDS = Object.keys(ATTACHMENTS).filter(
  (kind): kind is AttachmentKind => kind in ATTACHMENTS,
);

/** The thread's reasoning effort: none chosen, or one of the catalog's. */
export const EFFORT_CHOICES = ["default", ...REASONING_EFFORTS] as const;
export type EffortChoice = "default" | ReasoningEffort;

/**
 * The tools the turn declares: Stella's tools for a chat with no extra
 * sources, or with every source the send path can add (web search and URL
 * fetching, an organization's external tools listed lazily).
 */
export const TOOL_SURFACES = ["default", "extended"] as const;
export type ToolSurface = (typeof TOOL_SURFACES)[number];

/**
 * Which attempt answers the turn: the chat model, or the fallback the chat
 * attempt runs on the organization's reasoning model once the chat model
 * returns an empty completion (`shouldAttemptChatFallback`).
 */
const ATTEMPTS = ["primary", "fallback"] as const;
type Attempt = (typeof ATTEMPTS)[number];

/**
 * How the continuing turn's model is chosen: the organization's chat model
 * (switched here by the organization's setting), or the model the user
 * picked for the thread (`update-thread-model.ts`).
 */
const SELECTIONS = ["organization-default", "thread-pick"] as const;
type Selection = (typeof SELECTIONS)[number];

/** How the turn crosses the third-party boundary: as written, or
 *  anonymized (`createChatThirdPartyBoundary`). */
export const SEND_MODES = CHAT_SEND_MODES;
export type SendMode = (typeof SEND_MODES)[number];

/**
 * How the turn runs: as a chat turn, or as an agent run in a sandbox
 * (`CHAT_RUN_MODE`).
 */
const RUN_MODES = [
  "chat",
  ...Object.values(CHAT_RUN_MODE),
] as const satisfies readonly ("chat" | ChatRunMode)[];
type RunMode = (typeof RUN_MODES)[number];

/** One chat turn's combination of every dimension. */
export type ChatCombination = {
  attachment: AttachmentKind;
  attempt: Attempt;
  caching: CachingSetting;
  compaction: Compaction;
  effort: EffortChoice;
  history: HistoryVariant;
  origin: ModelEndpoint;
  runMode: RunMode;
  selection: Selection;
  sendMode: SendMode;
  stored: StoredPart;
  target: ModelEndpoint;
  tools: ToolSurface;
};

export const endpointKey = ({ provider, slot }: ModelEndpoint): string =>
  `${provider}/${slot}`;
export const combinationKey = (combination: ChatCombination): string =>
  `${endpointKey(combination.origin)} (${combination.history}, stored ${combination.stored}, ${combination.compaction}) -> ${endpointKey(combination.target)}; caching ${combination.caching}, attachment ${combination.attachment}, effort ${combination.effort}, tools ${combination.tools}, ${combination.attempt} attempt, ${combination.selection}, ${combination.sendMode}, ${combination.runMode} run`;

/** The model an endpoint names. */
export const modelOf = (
  cassettes: readonly ProviderWireCassette[],
  { provider, slot }: ModelEndpoint,
): string => {
  const recorded = cassetteFor(cassettes, provider, "tool-call").model;
  const models = {
    alternate: wireSideModel(provider, recorded),
    recorded,
  } as const satisfies Record<ModelSlot, string>;
  return models[slot];
};

/** The model the organization answers the reasoning role with when its
 *  chat model is `model`. */
export const reasoningModelOf = (
  provider: TanStackAIProvider,
  model: string,
): string => wireSideModel(provider, model);

type Predicate = (
  combination: ChatCombination,
  cassettes: readonly ProviderWireCassette[],
) => boolean;

const endpointPredicates = (
  side: "origin" | "target",
): Record<string, Predicate> => ({
  /** The send path refuses a chat turn with tools on such a model
   *  (`chatTurnRejectsStreamingTools`). */
  [`${side}: supportsStreamingToolUse`]: (combination, cassettes) =>
    supportsStreamingToolUse(modelOf(cassettes, combination[side])),
  /** The model picker offers the model for the chat role. */
  [`${side}: isBYOKModelRoleSupported`]: (combination, cassettes) =>
    isBYOKModelRoleSupported({
      modelId: modelOf(cassettes, combination[side]),
      provider: combination[side].provider,
      role: "chat",
    }),
});

/**
 * The production predicates that decide which combinations the product can
 * produce, by name.
 */
const PREDICATES: Readonly<Record<string, Predicate>> = {
  /** An agent run hands the turn to the Codex harness in a sandbox
   *  (`resolveStellaSandboxRun`), which builds the provider request itself:
   *  no request of the run leaves this process. */
  "runMode: resolveStellaSandboxRun": (combination) =>
    combination.runMode === "chat",
  /** An anonymized turn refuses an attachment it cannot extract to text
   *  (`canHydrateFilePartAsPlainText`). */
  "attachment: canHydrateFilePartAsPlainText": (combination) => {
    const attachment = ATTACHMENTS[combination.attachment];
    return (
      combination.sendMode !== CHAT_SEND_MODE.anonymized ||
      attachment === undefined ||
      canHydrateFilePartAsPlainText(attachment.mimeType)
    );
  },
  ...endpointPredicates("origin"),
  ...endpointPredicates("target"),
  /** The send path refuses a document attachment the model cannot read
   *  (`modelAcceptsDocumentAttachment`); an image and an extracted office
   *  file reach every model. */
  "attachment: modelAcceptsDocumentAttachment": (combination, cassettes) => {
    const attachment = ATTACHMENTS[combination.attachment];
    if (
      attachment === undefined ||
      (attachment.mimeType !== PDF_MIME_TYPE &&
        attachment.mimeType !== TEXT_CSV_MIME_TYPE)
    ) {
      return true;
    }
    return modelAcceptsDocumentAttachment({
      model: {
        modelId: modelOf(cassettes, combination.target),
        provider: combination.target.provider,
      },
      mimeType: attachment.mimeType,
    });
  },
  /** A fallback runs only on a reasoning model other than the chat model
   *  (`resolveFallbackTextModel`); the organization here answers the
   *  reasoning role from the provider's other model. */
  "attempt: resolveFallbackTextModel": (combination, cassettes) => {
    if (combination.attempt === "primary") {
      return true;
    }
    const model = modelOf(cassettes, combination.target);
    return reasoningModelOf(combination.target.provider, model) !== model;
  },
  /** The chat attempt drops a fallback model that cannot read the turn's
   *  document (`modelRejectsAnyDocument` in `streamChat`). */
  "attempt: the fallback model accepts the attachment": (
    combination,
    cassettes,
  ) => {
    const attachment = ATTACHMENTS[combination.attachment];
    if (
      combination.attempt === "primary" ||
      attachment === undefined ||
      (attachment.mimeType !== PDF_MIME_TYPE &&
        attachment.mimeType !== TEXT_CSV_MIME_TYPE)
    ) {
      return true;
    }
    return modelAcceptsDocumentAttachment({
      model: {
        modelId: reasoningModelOf(
          combination.target.provider,
          modelOf(cassettes, combination.target),
        ),
        provider: combination.target.provider,
      },
      mimeType: attachment.mimeType,
    });
  },
  /** A turn on a model the thread picked runs no fallback: the send path
   *  hands `streamChat` the pick as `devModelId`, and `streamChat` resolves
   *  a fallback only without one. */
  "attempt: streamChat resolves a fallback only without devModelId": (
    combination,
  ) =>
    combination.attempt === "primary" ||
    combination.selection === "organization-default",
  /** A reasoning effort rides on the thread's model pick
   *  (`resolveEffectiveChatModelSelection`). */
  "effort: resolveEffectiveChatModelSelection": (combination) =>
    combination.effort === "default" || combination.selection === "thread-pick",
  /** The model picker offers only the efforts the model accepts
   *  (`isChatModelReasoningEffortAvailable`). */
  "effort: isChatModelReasoningEffortAvailable": (combination, cassettes) =>
    combination.effort === "default" ||
    isChatModelReasoningEffortAvailable({
      modelId: modelOf(cassettes, combination.target),
      provider: combination.target.provider,
      reasoningEffort: combination.effort,
    }),
};

/** Every assignment of one value to each dimension of `dimensions`. */
const product = <Dimensions extends Record<string, readonly unknown[]>>(
  dimensions: Dimensions,
): { [Key in keyof Dimensions]: Dimensions[Key][number] }[] => {
  let assignments: Record<string, unknown>[] = [{}];
  for (const [name, values] of Object.entries(dimensions)) {
    const next: Record<string, unknown>[] = [];
    for (const assignment of assignments) {
      for (const value of values) {
        const extended: Record<string, unknown> = { ...assignment };
        extended[name] = value;
        next.push(extended);
      }
    }
    assignments = next;
  }
  return assignments.map((assignment) =>
    asTestRaw<{ [Key in keyof Dimensions]: Dimensions[Key][number] }>(
      assignment,
    ),
  );
};

/** Every provider's recorded model, and its alternate where the catalog
 *  offers a distinct one. */
export const enumerateEndpoints = (
  cassettes: readonly ProviderWireCassette[],
): ModelEndpoint[] =>
  TANSTACK_AI_PROVIDERS.flatMap((provider) =>
    MODEL_SLOTS.map((slot) => ({ provider, slot })),
  ).filter(
    (endpoint) =>
      endpoint.slot === "recorded" ||
      modelOf(cassettes, endpoint) !==
        modelOf(cassettes, { ...endpoint, slot: "recorded" }),
  );

/**
 * Every combination of the dimensions, split by what the product can
 * produce: the producible ones, and how many each predicate excludes (counted
 * rather than kept, as there are millions).
 */
export const enumerateChatCombinations = (
  cassettes: readonly ProviderWireCassette[],
): {
  excluded: ReadonlyMap<string, number>;
  included: ChatCombination[];
  total: number;
} => {
  const endpoints = enumerateEndpoints(cassettes);
  const included: ChatCombination[] = [];
  const excluded = new Map<string, number>();
  let total = 0;
  for (const origin of endpoints) {
    for (const target of endpoints) {
      const rest = product({
        attachment: ATTACHMENT_KINDS,
        attempt: ATTEMPTS,
        caching: CACHING_SETTINGS,
        compaction: COMPACTIONS,
        effort: EFFORT_CHOICES,
        history: HISTORY_VARIANTS,
        runMode: RUN_MODES,
        selection: SELECTIONS,
        sendMode: SEND_MODES,
        stored: STORED_PARTS,
        tools: TOOL_SURFACES,
      });
      for (const values of rest) {
        total += 1;
        const combination: ChatCombination = { ...values, origin, target };
        const refused = Object.entries(PREDICATES).find(
          ([, allows]) => !allows(combination, cassettes),
        )?.[0];
        if (refused === undefined) {
          included.push(combination);
        } else {
          excluded.set(refused, (excluded.get(refused) ?? 0) + 1);
        }
      }
    }
  }
  return { excluded, included, total };
};

/** The values one combination takes on each dimension. */
const dimensionsOf = (combination: ChatCombination): readonly string[] => [
  combination.origin.provider,
  combination.origin.slot,
  combination.history,
  combination.stored,
  combination.compaction,
  combination.target.provider,
  combination.target.slot,
  combination.caching,
  combination.attachment,
  combination.effort,
  combination.tools,
  combination.attempt,
  combination.selection,
  combination.sendMode,
  combination.runMode,
];

/**
 * A subset of `combinations` in which every combination of values of every
 * `strength` dimensions that some combination takes appears at least once (a
 * covering array: all-pairs at 2, all-triples at 3). Built greedily: each
 * step takes, from a fixed-seed sample of the candidates, the one covering the
 * most tuples not yet covered, or else the first combination holding the
 * first uncovered tuple, so it always ends and always yields the same set.
 */
const coveringArray = <Combination>(
  combinations: readonly Combination[],
  valuesOf: (combination: Combination) => readonly string[],
  strength: number,
): Combination[] => {
  const first = combinations[0];
  const width = first === undefined ? 0 : valuesOf(first).length;
  // Each dimension's values, by index.
  const indexes = Array.from(
    { length: width },
    () => new Map<string, number>(),
  );
  // Each combination as the index of its value on each dimension, packed
  // small: there can be hundreds of thousands.
  const vectors = combinations.map((combination) =>
    Uint8Array.from(valuesOf(combination), (value, dimension) => {
      const index = indexes[dimension] ?? panic("A dimension has values");
      let id = index.get(value);
      if (id === undefined) {
        id = index.size;
        index.set(value, id);
      }
      return id;
    }),
  );
  const sizes = indexes.map((index) => index.size);
  // Every set of `strength` dimensions, with the offset of its tuples.
  const groups: { dimensions: number[]; offset: number }[] = [];
  let tupleCount = 0;
  const choose = (start: number, picked: number[]) => {
    if (picked.length === strength) {
      groups.push({ dimensions: picked, offset: tupleCount });
      tupleCount += picked.reduce(
        (count, dimension) => count * (sizes[dimension] ?? 1),
        1,
      );
      return;
    }
    for (let dimension = start; dimension < width; dimension += 1) {
      choose(dimension + 1, [...picked, dimension]);
    }
  };
  choose(0, []);
  const tuplesOf = (vector: Uint8Array): number[] =>
    groups.map(({ dimensions, offset }) => {
      let id = 0;
      for (const dimension of dimensions) {
        id = id * (sizes[dimension] ?? 1) + (vector[dimension] ?? 0);
      }
      return offset + id;
    });
  // The tuples some combination takes, and the first combination taking each.
  const firstHolder = new Int32Array(tupleCount).fill(-1);
  for (const [position, vector] of vectors.entries()) {
    for (const tuple of tuplesOf(vector)) {
      if (firstHolder[tuple] === -1) {
        firstHolder[tuple] = position;
      }
    }
  }
  const uncovered = new Uint8Array(tupleCount);
  let remaining = 0;
  for (let tuple = 0; tuple < tupleCount; tuple += 1) {
    if (firstHolder[tuple] !== -1) {
      uncovered[tuple] = 1;
      remaining += 1;
    }
  }
  // A Park-Miller generator: fixed, so the cover is the same every run.
  let seed = 20_260_930;
  const nextIndex = (): number => {
    seed = (seed * 48_271) % 2_147_483_647;
    return seed % vectors.length;
  };
  const chosen: Combination[] = [];
  /** Chooses the combination at `position`; returns how many tuples it
   *  newly covers. */
  const take = (position: number): number => {
    const combination = combinations[position];
    const vector = vectors[position];
    if (combination === undefined || vector === undefined) {
      return panic("A chosen position names a combination");
    }
    chosen.push(combination);
    let newlyCovered = 0;
    for (const tuple of tuplesOf(vector)) {
      if (uncovered[tuple] === 1) {
        uncovered[tuple] = 0;
        newlyCovered += 1;
      }
    }
    return newlyCovered;
  };
  let scan = 0;
  while (remaining > 0) {
    let best = -1;
    let bestGain = 0;
    const samples = Math.min(COVERING_SAMPLES, vectors.length);
    for (let sample = 0; sample < samples; sample += 1) {
      const position =
        vectors.length <= COVERING_SAMPLES ? sample : nextIndex();
      let gain = 0;
      for (const tuple of tuplesOf(vectors[position] ?? new Uint8Array())) {
        gain += uncovered[tuple] ?? 0;
      }
      if (gain > bestGain) {
        best = position;
        bestGain = gain;
      }
    }
    if (best === -1) {
      while (uncovered[scan] !== 1) {
        scan += 1;
      }
      best = firstHolder[scan] ?? panic("An uncovered tuple has a holder");
    }
    remaining -= take(best);
  }
  return chosen;
};

/** How many candidates each step of `coveringArray` weighs. */
const COVERING_SAMPLES = 2000;

/** The chat combinations' all-pairs cover, which pull requests run. */
export const pairwiseChatCombinations = (
  combinations: readonly ChatCombination[],
): ChatCombination[] => coveringArray(combinations, dimensionsOf, 2);

/** The chat combinations' all-triples cover, which the nightly job runs. */
export const threeWiseChatCombinations = (
  combinations: readonly ChatCombination[],
): ChatCombination[] => coveringArray(combinations, dimensionsOf, 3);

/** The combinations a shard `index` of `count` runs: every `count`th. */
export const shardOf = <Combination>(
  combinations: readonly Combination[],
  shard: { count: number; index: number },
): Combination[] =>
  combinations.filter((_, position) => position % shard.count === shard.index);

/**
 * `cassette` as the recording of `model`: the same answers, served to
 * requests that name `model` in their body or path.
 */
export const cassetteForModel = (
  cassette: ProviderWireCassette,
  model: string,
): ProviderWireCassette => {
  if (cassette.model === model) {
    return cassette;
  }
  const spellings = [
    [cassette.model, model],
    [encodeURIComponent(cassette.model), encodeURIComponent(model)],
  ] as const;
  const renamed = (path: string): string => {
    let result = path;
    for (const [from, to] of spellings) {
      result = result.replaceAll(from, () => to);
    }
    return result;
  };
  return {
    ...cassette,
    model,
    exchanges: cassette.exchanges.map((exchange) => ({
      ...exchange,
      request: { ...exchange.request, path: renamed(exchange.request.path) },
    })),
  };
};

/** `provider`'s tool call answer, with what `history` adds. */
export const toolCallAnswerFor = ({
  cassette,
  history,
  provider,
}: {
  cassette: ProviderWireCassette;
  history: HistoryVariant;
  provider: TanStackAIProvider;
}): ProviderWireCassette => REASONING_ANSWERS[provider][history](cassette);

// --- Oracles beyond the published schemas -------------------------------------

/**
 * Keys that carry reasoning only the provider that wrote it can verify:
 * Anthropic's thinking `signature` and `redacted_thinking` data (Messages API,
 * "extended thinking": blocks are verified against the model that produced
 * them), Bedrock's `reasoningContent` signature and `redactedContent`
 * (Converse API, ReasoningContentBlock), OpenAI's reasoning
 * `encrypted_content` (Responses API, "reasoning items"), Gemini's
 * `thoughtSignature` (generateContent, "thought signatures"), and
 * OpenRouter's `reasoning_details` (its reasoning tokens guide).
 */
const PROVIDER_BOUND_REASONING_KEYS: ReadonlySet<string> = new Set([
  "encrypted_content",
  "reasoning_details",
  "redactedContent",
  "redacted_thinking",
  "signature",
  "thoughtSignature",
  "thought_signature",
]);

/**
 * Keys that set one provider's prompt caching: Anthropic's `cache_control`
 * (also accepted by OpenRouter, which forwards it) and Bedrock's `cachePoint`.
 */
const PROVIDER_CACHE_KEYS: Readonly<
  Record<string, readonly TanStackAIProvider[]>
> = {
  cache_control: ["anthropic", "openrouter"],
  cachePoint: ["bedrock"],
};

/** Every key in `body` with the JSON path it sits at. */
const keysOf = (body: unknown): { key: string; path: string }[] => {
  const found: { key: string; path: string }[] = [];
  const visit = (value: unknown, at: string) => {
    if (isUnknownArray(value)) {
      for (const [index, item] of value.entries()) {
        visit(item, `${at}[${String(index)}]`);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const path = `${at}.${key}`;
      found.push({ key, path });
      visit(child, path);
    }
  };
  visit(body, "body");
  return found;
};

/**
 * Where a request `target` was sent, continuing history `origin` produced,
 * carries what only another provider can read: reasoning bound to the
 * provider that wrote it (`foreign-reasoning`), or another provider's cache
 * settings (`foreign-cache-option`).
 */
export const findForeignRequestArtifacts = ({
  body,
  origin,
  target,
}: {
  body: unknown;
  origin: TanStackAIProvider;
  target: TanStackAIProvider;
}): string[] =>
  keysOf(body).flatMap(({ key, path }) => {
    if (PROVIDER_BOUND_REASONING_KEYS.has(key) && origin !== target) {
      return [
        `foreign-reasoning: ${target} was sent ${path}, reasoning ${origin} wrote`,
      ];
    }
    const cacheOwners = PROVIDER_CACHE_KEYS[key];
    if (cacheOwners !== undefined && !cacheOwners.includes(target)) {
      return [
        `foreign-cache-option: ${target} was sent ${path}, a cache setting of ${cacheOwners.join(", ")}`,
      ];
    }
    return [];
  });
