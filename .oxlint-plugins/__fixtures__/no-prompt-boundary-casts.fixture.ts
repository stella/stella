/* oxlint-disable typescript/no-unsafe-type-assertion */
// Passive regression fixture for
// `no-prompt-boundary-casts/no-prompt-boundary-casts`.
//
// The disabled lines below must stay flagged. If the custom rule
// regresses, the disables become unused and fixture linting fails.

type ChatCacheStablePrefix = string & { readonly __brand: "cache" };
type ChatSafePrompt = string & { readonly __brand: "safe" };
type ChatUntrustedPromptSuffix = string & { readonly __brand: "untrusted" };
type ChatFullPrompt = string & { readonly __brand: "full" };

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

const allowedUse = alreadySafe;

export const __noPromptBoundaryCastsFixture = {
  allowedUse,
  cache,
  full,
  safe,
  untrusted,
};
