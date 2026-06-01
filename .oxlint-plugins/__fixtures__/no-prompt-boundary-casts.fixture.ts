/* oxlint-disable typescript/array-type, typescript/consistent-indexed-object-style, typescript/consistent-type-assertions, typescript/consistent-type-definitions, typescript/consistent-type-imports, typescript/no-unsafe-type-assertion */
// Passive regression fixture for
// `no-prompt-boundary-casts/no-prompt-boundary-casts`.
//
// The disabled lines below must stay flagged. If the custom rule
// regresses, the disables become unused and fixture linting fails.

import type { ChatSafePrompt as ImportedChatSafePromptAlias } from "../../apps/api/src/handlers/chat/chat-prompt";

type ChatCacheStablePrefix = string & { readonly __brand: "cache" };
type ChatSafePrompt = string & { readonly __brand: "safe" };
type ChatUntrustedPromptSuffix = string & { readonly __brand: "untrusted" };
type ChatFullPrompt = string & { readonly __brand: "full" };
type ChatSafePromptAlias = ChatSafePrompt;
type ChatSafePromptTransitiveAlias = ChatSafePromptAlias;
type ChatSafePromptForwardAlias = ChatSafePromptForwardTarget;
type ChatSafePromptForwardTarget = ChatSafePrompt;
type ChatSafePromptImportType =
  import("../../apps/api/src/handlers/chat/chat-prompt").ChatSafePrompt;
type ChatSafePromptIndexedBox = {
  readonly id: string;
  readonly prompt: ChatSafePrompt;
};
type ChatSafePromptIndexedAlias = ChatSafePromptIndexedBox["prompt"];
type ChatSafePromptIndexedId = ChatSafePromptIndexedBox["id"];
type ChatSafePromptIndexedPromptKey = "prompt";
type ChatSafePromptIndexedIdKey = "id";
type ChatSafePromptIndexedPromptKeyAlias =
  ChatSafePromptIndexedBox[ChatSafePromptIndexedPromptKey];
type ChatSafePromptIndexedIdKeyAlias =
  ChatSafePromptIndexedBox[ChatSafePromptIndexedIdKey];
type ChatSafePromptTupleIndexedBox = [string, ChatSafePrompt];
type ChatSafePromptTupleIndexedString = ChatSafePromptTupleIndexedBox[0];
type ChatSafePromptTupleIndexedPrompt = ChatSafePromptTupleIndexedBox[1];
type ChatSafePromptTupleIndexedStringIndex = 0;
type ChatSafePromptTupleIndexedPromptIndex = 1;
type ChatSafePromptTupleIndexedStringKeyAlias =
  ChatSafePromptTupleIndexedBox[ChatSafePromptTupleIndexedStringIndex];
type ChatSafePromptTupleIndexedPromptKeyAlias =
  ChatSafePromptTupleIndexedBox[ChatSafePromptTupleIndexedPromptIndex];
type ChatSafePromptReadonlyTupleIndexedBox = readonly [string, ChatSafePrompt];
type ChatSafePromptReadonlyTupleIndexedString =
  ChatSafePromptReadonlyTupleIndexedBox[0];
type ChatSafePromptReadonlyTupleIndexedPrompt =
  ChatSafePromptReadonlyTupleIndexedBox[1];
type ChatSafePromptArrayIndexedPrompt = ChatSafePrompt[][0];
type ChatSafePromptNumericIndexedBox = {
  readonly 0: ChatSafePrompt;
  readonly 1: string;
  readonly prompt: ChatSafePrompt;
};
type ChatSafePromptNumericIndexedPrompt = ChatSafePromptNumericIndexedBox[0];
type ChatSafePromptNumericIndexedString = ChatSafePromptNumericIndexedBox[1];
type ChatSafePromptNumericStringIndexedPrompt =
  ChatSafePromptNumericIndexedBox["0"];
type ChatSafePromptNumericStringIndexedString =
  ChatSafePromptNumericIndexedBox["1"];
type ChatSafePromptIntersectionIndexedBox = {
  readonly prompt: ChatSafePrompt;
} & {
  readonly id: string;
};
type ChatSafePromptIntersectionIndexedPrompt =
  ChatSafePromptIntersectionIndexedBox["prompt"];
type ChatSafePromptIntersectionIndexedId =
  ChatSafePromptIntersectionIndexedBox["id"];
type ChatSafePromptStringIndexBox = {
  readonly [key: string]: ChatSafePrompt;
};
type ChatSafePromptStringIndexAlias = ChatSafePromptStringIndexBox["prompt"];
type ChatSafePromptStringIndexId = { readonly [key: string]: string }["id"];
type ChatSafePromptNumberIndexBox = {
  readonly [index: number]: ChatSafePrompt;
};
type ChatSafePromptNumberIndexAlias = ChatSafePromptNumberIndexBox[0];
type ChatSafePromptConditional = string extends string ? ChatSafePrompt : never;
type ChatSafePromptConditionalLabel = ChatSafePrompt extends string
  ? "safe"
  : "other";
type ChatSafePromptConditionalSelectedString<Prompt> =
  Prompt extends ChatSafePrompt ? string : ChatSafePrompt;
type ChatSafePromptConditionalSelectedStringAlias =
  ChatSafePromptConditionalSelectedString<ChatSafePrompt>;
type ChatSafePromptConditionalSelectedPrompt<Prompt> =
  Prompt extends ChatSafePrompt ? ChatSafePrompt : string;
type ChatSafePromptConditionalSelectedPromptAlias =
  ChatSafePromptConditionalSelectedPrompt<ChatSafePrompt>;
type ChatSafePromptMappedBox = {
  readonly [PromptKey in "prompt"]: ChatSafePrompt;
};
type ChatSafePromptGenericIndexedBox<Prompt> = {
  readonly id: string;
  readonly prompt: Prompt;
};
type ChatSafePromptGenericIndexedAlias =
  ChatSafePromptGenericIndexedBox<ChatSafePrompt>["prompt"];
type ChatSafePromptGenericIndexedId =
  ChatSafePromptGenericIndexedBox<ChatSafePrompt>["id"];
type ChatSafePromptDefaultGenericIndexedBox<Prompt = ChatSafePrompt> = {
  readonly id: string;
  readonly prompt: Prompt;
};
type ChatSafePromptDefaultGenericIndexedAlias =
  ChatSafePromptDefaultGenericIndexedBox["prompt"];
type ChatSafePromptDefaultGenericIndexedId =
  ChatSafePromptDefaultGenericIndexedBox["id"];
type ChatSafePromptRecordAlias = Record<"prompt", ChatSafePrompt>["prompt"];
type ChatSafePromptRecordStringAlias = Record<string, ChatSafePrompt>["id"];
type ChatSafePromptRecordNumberAlias = Record<number, ChatSafePrompt>[0];
type ChatSafePromptRecordNumberStringAlias = Record<
  number,
  ChatSafePrompt
>["0"];
type ChatSafePromptRecordId = Record<"id", string>["id"];
type ChatSafePromptRecordNumberId = Record<0, string>[0];
type ChatSafePromptRecordNumberStringId = Record<0, string>["0"];

declare module "external-prompt-types" {
  export type Box<Prompt> = Record<string, string> & {
    readonly unused?: Prompt;
  };
}

type ChatSafePromptExternalIndexedId =
  import("external-prompt-types").Box<ChatSafePrompt>["id"];

interface ChatSafePromptIndexedInterface {
  readonly id: string;
  readonly prompt: ChatSafePrompt;
}

interface ChatSafePromptInheritedGenericBase<Prompt> {
  readonly id: string;
  readonly prompt: Prompt;
}

interface ChatSafePromptInheritedGenericChild extends ChatSafePromptInheritedGenericBase<ChatSafePrompt> {
  readonly kind: "child";
}

type ChatSafePromptInheritedGenericAlias =
  ChatSafePromptInheritedGenericChild["prompt"];
type ChatSafePromptInheritedGenericId =
  ChatSafePromptInheritedGenericChild["id"];

type ChatSafePromptIndexedInterfaceAlias =
  ChatSafePromptIndexedInterface["prompt"];
type ChatSafePromptIndexedInterfaceId = ChatSafePromptIndexedInterface["id"];

interface ChatSafePromptInterface {
  readonly prompt: ChatSafePrompt;
}

interface ChatSafePromptMethodInterface {
  build(): ChatSafePrompt;
}

interface ChatSafePromptExtendedInterface extends ChatSafePromptInterface {
  readonly kind: "extended";
}

interface ChatSafePromptGenericInterface {
  readonly prompts: Array<ChatSafePrompt>;
}

declare const raw: string;
declare const unknownRaw: unknown;
declare const alreadySafe: ChatSafePrompt;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const cache = raw as ChatCacheStablePrefix;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const safe = raw as ChatSafePrompt;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const untrusted = raw as ChatUntrustedPromptSuffix;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const full = raw as ChatFullPrompt;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const union = raw as ChatSafePrompt | null;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const intersection = raw as ChatSafePrompt & { readonly extra: true };

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const typeAssertion = <ChatSafePrompt>raw;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const array = raw as ChatSafePrompt[];

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const generic = raw as Array<ChatSafePrompt>;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const tuple = raw as [ChatSafePrompt, string];

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const namedTuple = raw as [prompt: ChatSafePrompt];

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const objectContainer = raw as { readonly prompt: ChatSafePrompt };

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const functionReturn = (() => raw) as () => ChatSafePrompt;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const functionParam = ((prompt: string) => prompt) as (
  prompt: ChatSafePrompt,
) => string;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const objectFunctionProperty = raw as { readonly build: () => ChatSafePrompt };

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const objectMethodSignature = raw as { build(): ChatSafePrompt };

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const objectCallSignature = raw as { (prompt: ChatSafePrompt): string };

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const constructorType = raw as new (prompt: ChatSafePrompt) => object;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const objectConstructSignature = raw as {
  new (prompt: ChatSafePrompt): object;
};

// oxfmt-ignore
// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const parenthesized = raw as (ChatSafePrompt);

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const typeAlias = raw as ChatSafePromptAlias;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const transitiveTypeAlias = raw as ChatSafePromptTransitiveAlias;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const forwardTypeAlias = raw as ChatSafePromptForwardAlias;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const importAlias = raw as ImportedChatSafePromptAlias;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const importTypeAlias = raw as ChatSafePromptImportType;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessAlias = raw as ChatSafePromptIndexedAlias;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessLiteral = raw as {
  readonly id: string;
  readonly prompt: ChatSafePrompt;
}["prompt"];

const indexedAccessIdAlias = unknownRaw as ChatSafePromptIndexedId;

const indexedAccessIdLiteral = unknownRaw as {
  readonly id: string;
  readonly prompt: ChatSafePrompt;
}["id"];

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessPromptKeyAlias = raw as ChatSafePromptIndexedPromptKeyAlias;

const indexedAccessIdKeyAlias = unknownRaw as ChatSafePromptIndexedIdKeyAlias;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessArrayPrompt = raw as ChatSafePromptArrayIndexedPrompt;

const indexedAccessTupleString = unknownRaw as ChatSafePromptTupleIndexedString;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessTuplePrompt = raw as ChatSafePromptTupleIndexedPrompt;

const indexedAccessTupleStringKeyAlias =
  unknownRaw as ChatSafePromptTupleIndexedStringKeyAlias;

// oxfmt-ignore
// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessTuplePromptKeyAlias = raw as ChatSafePromptTupleIndexedPromptKeyAlias;

const indexedAccessReadonlyTupleString =
  unknownRaw as ChatSafePromptReadonlyTupleIndexedString;

// oxfmt-ignore
// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessReadonlyTuplePrompt = raw as ChatSafePromptReadonlyTupleIndexedPrompt;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessNumericPrompt = raw as ChatSafePromptNumericIndexedPrompt;

const indexedAccessNumericString =
  unknownRaw as ChatSafePromptNumericIndexedString;

// oxfmt-ignore
// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessNumericStringPrompt = raw as ChatSafePromptNumericStringIndexedPrompt;

const indexedAccessNumericStringString =
  unknownRaw as ChatSafePromptNumericStringIndexedString;

// oxfmt-ignore
// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessIntersectionPrompt = raw as ChatSafePromptIntersectionIndexedPrompt;

const indexedAccessIntersectionId =
  unknownRaw as ChatSafePromptIntersectionIndexedId;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessStringIndex = raw as ChatSafePromptStringIndexAlias;

const indexedAccessStringIndexId = unknownRaw as ChatSafePromptStringIndexId;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessNumberIndex = raw as ChatSafePromptNumberIndexAlias;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessInterfaceAlias = raw as ChatSafePromptIndexedInterfaceAlias;

const indexedAccessInterfaceId = unknownRaw as ChatSafePromptIndexedInterfaceId;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessGenericAlias = raw as ChatSafePromptGenericIndexedAlias;

const indexedAccessGenericId = unknownRaw as ChatSafePromptGenericIndexedId;

const indexedAccessExternalId = unknownRaw as ChatSafePromptExternalIndexedId;

// oxfmt-ignore
// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessDefaultGenericAlias = raw as ChatSafePromptDefaultGenericIndexedAlias;

const indexedAccessDefaultGenericId =
  unknownRaw as ChatSafePromptDefaultGenericIndexedId;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessRecordAlias = raw as ChatSafePromptRecordAlias;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessRecordStringAlias = raw as ChatSafePromptRecordStringAlias;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessRecordNumberAlias = raw as ChatSafePromptRecordNumberAlias;

// oxfmt-ignore
// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessRecordNumberStringAlias = raw as ChatSafePromptRecordNumberStringAlias;

const indexedAccessRecordId = unknownRaw as ChatSafePromptRecordId;

const indexedAccessRecordNumberId = unknownRaw as ChatSafePromptRecordNumberId;

const indexedAccessRecordNumberStringId =
  unknownRaw as ChatSafePromptRecordNumberStringId;

// oxfmt-ignore
// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const indexedAccessInheritedGenericAlias = raw as ChatSafePromptInheritedGenericAlias;

const indexedAccessInheritedGenericId =
  unknownRaw as ChatSafePromptInheritedGenericId;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const conditional = raw as ChatSafePromptConditional;

const conditionalLabel = unknownRaw as ChatSafePromptConditionalLabel;

const conditionalSelectedString =
  unknownRaw as ChatSafePromptConditionalSelectedStringAlias;

// oxfmt-ignore
// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const conditionalSelectedPrompt = raw as ChatSafePromptConditionalSelectedPromptAlias;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const mappedContainer = raw as ChatSafePromptMappedBox;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const mappedLiteral = raw as {
  readonly [PromptKey in "prompt"]: ChatSafePrompt;
};

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const interfaceContainer = raw as ChatSafePromptInterface;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const interfaceMethod = raw as ChatSafePromptMethodInterface;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const interfaceExtends = raw as ChatSafePromptExtendedInterface;

// oxlint-disable-next-line no-prompt-boundary-casts/no-prompt-boundary-casts
const interfaceGeneric = raw as ChatSafePromptGenericInterface;

const allowedUse = alreadySafe;

export const __noPromptBoundaryCastsFixture = {
  allowedUse,
  array,
  cache,
  conditional,
  conditionalLabel,
  conditionalSelectedPrompt,
  conditionalSelectedString,
  constructorType,
  forwardTypeAlias,
  full,
  functionParam,
  functionReturn,
  generic,
  indexedAccessDefaultGenericAlias,
  indexedAccessDefaultGenericId,
  indexedAccessExternalId,
  indexedAccessAlias,
  indexedAccessArrayPrompt,
  indexedAccessGenericAlias,
  indexedAccessGenericId,
  indexedAccessIdAlias,
  indexedAccessIdLiteral,
  indexedAccessIdKeyAlias,
  indexedAccessInheritedGenericAlias,
  indexedAccessInheritedGenericId,
  indexedAccessIntersectionId,
  indexedAccessIntersectionPrompt,
  indexedAccessInterfaceAlias,
  indexedAccessInterfaceId,
  indexedAccessLiteral,
  indexedAccessNumericPrompt,
  indexedAccessNumericString,
  indexedAccessNumericStringPrompt,
  indexedAccessNumericStringString,
  indexedAccessPromptKeyAlias,
  indexedAccessRecordAlias,
  indexedAccessRecordId,
  indexedAccessRecordNumberAlias,
  indexedAccessRecordNumberId,
  indexedAccessRecordNumberStringAlias,
  indexedAccessRecordNumberStringId,
  indexedAccessRecordStringAlias,
  indexedAccessReadonlyTuplePrompt,
  indexedAccessReadonlyTupleString,
  indexedAccessNumberIndex,
  indexedAccessStringIndex,
  indexedAccessStringIndexId,
  indexedAccessTuplePrompt,
  indexedAccessTuplePromptKeyAlias,
  indexedAccessTupleString,
  indexedAccessTupleStringKeyAlias,
  importAlias,
  importTypeAlias,
  intersection,
  interfaceContainer,
  interfaceExtends,
  interfaceGeneric,
  interfaceMethod,
  mappedContainer,
  mappedLiteral,
  namedTuple,
  objectCallSignature,
  objectConstructSignature,
  objectContainer,
  objectFunctionProperty,
  objectMethodSignature,
  parenthesized,
  safe,
  transitiveTypeAlias,
  tuple,
  typeAlias,
  typeAssertion,
  union,
  untrusted,
};
