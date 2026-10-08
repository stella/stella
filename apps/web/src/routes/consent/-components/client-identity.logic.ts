import type { VerifiedOAuthClientBrand } from "@stll/api-contract";

import type { OAuthConsentInfo } from "@/lib/oauth-provider";

/** Product and publisher names are proper nouns: never translated. */
const VERIFIED_CLIENT_IDENTITY = {
  stella: { name: "stella", publisher: "stella" },
  claude: { name: "Claude", publisher: "Anthropic" },
  claude_code: { name: "Claude Code", publisher: "Anthropic" },
  chatgpt: { name: "ChatGPT", publisher: "OpenAI" },
  codex: { name: "Codex", publisher: "OpenAI" },
  microsoft_copilot: { name: "Microsoft 365 Copilot", publisher: "Microsoft" },
  copilot_studio: { name: "Copilot Studio", publisher: "Microsoft" },
  gemini_enterprise: { name: "Gemini Enterprise", publisher: "Google" },
} as const satisfies Record<
  VerifiedOAuthClientBrand,
  { name: string; publisher: string }
>;

export type ConsentClientIdentity =
  | {
      type: "verified";
      brand: VerifiedOAuthClientBrand;
      name: string;
      publisher: string;
    }
  | { type: "verified_unbranded"; name: string }
  | { type: "unverified"; name: string };

/**
 * Who the consent screen says is asking. Only the server's verified brand
 * selects a product name, mark and publisher; the client's registered name is
 * shown as its own claim, so a client claiming a known product's name from an
 * unknown location reads as an unverified app with that name and no mark.
 */
export const resolveConsentClientIdentity = (
  info: OAuthConsentInfo | null | undefined,
  claimedName: string,
): ConsentClientIdentity => {
  if (!info || info.unverified) {
    return { type: "unverified", name: claimedName };
  }
  if (info.verifiedBrand === null) {
    return { type: "verified_unbranded", name: claimedName };
  }
  const identity = VERIFIED_CLIENT_IDENTITY[info.verifiedBrand];
  return {
    type: "verified",
    brand: info.verifiedBrand,
    name: identity.name,
    publisher: identity.publisher,
  };
};
