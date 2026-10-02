import type { AnthropicModelInputModalitiesByName } from "@tanstack/ai-anthropic";
import type { BedrockModelInputModalitiesByName } from "@tanstack/ai-bedrock";
import type { GeminiModelInputModalitiesByName } from "@tanstack/ai-gemini";
import type { MistralModelInputModalitiesByName } from "@tanstack/ai-mistral";
import type { OpenRouterModelInputModalitiesByName } from "@tanstack/ai-openrouter";
import { expectTypeOf } from "bun:test";

import type {
  BYOKModelIdByProvider,
  CHAT_PDF_ATTACHMENT_MODEL_OPTIONS,
} from "./index";

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
  mistral: ModelWithInputModality<
    MistralModelInputModalitiesByName,
    "document"
  >;
  openrouter: ModelWithInputModality<
    OpenRouterModelInputModalitiesByName,
    "document"
  >;
};

type TanStackModelInputModalitiesByProvider = {
  anthropic: AnthropicModelInputModalitiesByName;
  bedrock: BedrockModelInputModalitiesByName;
  google: GeminiModelInputModalitiesByName;
  mistral: MistralModelInputModalitiesByName;
  openrouter: OpenRouterModelInputModalitiesByName;
};

// OpenAI is deliberately outside this adapter-derived proof: its current
// metadata omits document input, while the dated source corrections cover
// Responses API `input_file` support for the offered models.

type AdapterDocumentInputModelOptions =
  typeof CHAT_PDF_ATTACHMENT_MODEL_OPTIONS;

// Unlike `toExtend`, this counts an empty (`never`) provider set as covered.
type Extends<T, U> = [T] extends [U] ? true : false;

type EveryKnownDocumentInputOptionIsSupported = {
  [TProvider in keyof TanStackDocumentInputModelByProvider]: Extends<
    Extract<
      AdapterDocumentInputModelOptions[TProvider][number],
      keyof TanStackModelInputModalitiesByProvider[TProvider]
    >,
    TanStackDocumentInputModelByProvider[TProvider]
  >;
}[keyof TanStackDocumentInputModelByProvider];

type EveryOfferedTanStackDocumentModelIsIncluded = {
  [TProvider in keyof TanStackDocumentInputModelByProvider]: Extends<
    Extract<
      BYOKModelIdByProvider[TProvider],
      TanStackDocumentInputModelByProvider[TProvider]
    >,
    AdapterDocumentInputModelOptions[TProvider][number]
  >;
}[keyof TanStackDocumentInputModelByProvider];

expectTypeOf<EveryKnownDocumentInputOptionIsSupported>().toEqualTypeOf<true>();

expectTypeOf<EveryOfferedTanStackDocumentModelIsIncluded>().toEqualTypeOf<true>();
