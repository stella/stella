/* oxlint-disable typescript/array-type, typescript/consistent-type-assertions, typescript/consistent-type-definitions, typescript/consistent-type-imports, typescript/no-unsafe-type-assertion */
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
  constructorType,
  forwardTypeAlias,
  full,
  functionParam,
  functionReturn,
  generic,
  importAlias,
  importTypeAlias,
  intersection,
  interfaceContainer,
  interfaceExtends,
  interfaceGeneric,
  interfaceMethod,
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
