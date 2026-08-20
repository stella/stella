import type { AnthropicModelInputModalitiesByName } from "@tanstack/ai-anthropic";
import type { BedrockModelInputModalitiesByName } from "@tanstack/ai-bedrock";
import type { GeminiModelInputModalitiesByName } from "@tanstack/ai-gemini";
import type { OpenRouterModelInputModalitiesByName } from "@tanstack/ai-openrouter";

import type { TANSTACK_DOCUMENT_INPUT_MODEL_OPTIONS } from "./document-input-model-options";
import type { BYOK_MODEL_OPTIONS } from "./index";

type ModelInputModalitiesByName = Record<string, readonly string[]>;

type ModelWithInputModality<
  TModels extends ModelInputModalitiesByName,
  TModality extends string,
> = Extract<
  {
    [TModel in keyof TModels]: TModality extends TModels[TModel][number]
      ? TModel
      : never;
  }[keyof TModels],
  string
>;

type TanStackDocumentInputModelByProvider = {
  anthropic: ModelWithInputModality<
    AnthropicModelInputModalitiesByName,
    "document"
  >;
  bedrock: ModelWithInputModality<
    BedrockModelInputModalitiesByName,
    "document"
  >;
  google: ModelWithInputModality<GeminiModelInputModalitiesByName, "document">;
  openrouter: ModelWithInputModality<
    OpenRouterModelInputModalitiesByName,
    "document"
  >;
};

type BYOKModelIdByProvider = {
  [TProvider in keyof typeof BYOK_MODEL_OPTIONS]: (typeof BYOK_MODEL_OPTIONS)[TProvider][number];
};

type DocumentInputModelOptionsContract = {
  [TProvider in keyof TanStackDocumentInputModelByProvider]: readonly Extract<
    BYOKModelIdByProvider[TProvider],
    TanStackDocumentInputModelByProvider[TProvider]
  >[];
};

type DocumentInputModelOptions = typeof TANSTACK_DOCUMENT_INPUT_MODEL_OPTIONS;

type Assert<T extends true> = T;
type Extends<T, U> = [T] extends [U] ? true : false;

export type EveryDocumentInputOptionIsOfferedAndSupported = Assert<
  Extends<DocumentInputModelOptions, DocumentInputModelOptionsContract>
>;

export type NoDocumentInputProviderIsMissing = Assert<
  Extends<
    keyof DocumentInputModelOptionsContract,
    keyof DocumentInputModelOptions
  >
>;

export type NoUnknownDocumentInputProviderIsPresent = Assert<
  Extends<
    keyof DocumentInputModelOptions,
    keyof DocumentInputModelOptionsContract
  >
>;
