import { panic } from "better-result";

import type { VerifiedOAuthClientBrand } from "@stll/api-contract";

import type { OAuthConsentInfo } from "@/lib/oauth-provider";

/** Product and publisher names are proper nouns: never translated. */
const VERIFIED_CLIENT_IDENTITY = {
  stella: { name: "stella", publisher: "stella" },
  claude: { name: "Claude", publisher: "Anthropic" },
  claude_code: { name: "Claude Code", publisher: "Anthropic" },
  chatgpt: { name: "ChatGPT", publisher: "OpenAI" },
  codex: { name: "Codex", publisher: "OpenAI" },
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
  | { type: "unverified"; name: string }
  | { type: "unknown"; name: string };

/**
 * Who the consent screen says is asking. Only the server's verified brand
 * selects a product name, mark and publisher; otherwise the client's
 * registered name is shown as its own claim, so a client claiming a known
 * product's name from an unknown location reads as an unverified app with that
 * name and no mark. `fallbackName` stands in for a client that registered none.
 */
export const resolveConsentClientIdentity = (
  info: OAuthConsentInfo | null | undefined,
  fallbackName: string,
): ConsentClientIdentity => {
  if (!info) {
    return { type: "unknown", name: fallbackName };
  }
  const { client } = info;
  switch (client.type) {
    case "verified": {
      const identity = VERIFIED_CLIENT_IDENTITY[client.brand];
      return {
        type: "verified",
        brand: client.brand,
        name: identity.name,
        publisher: identity.publisher,
      };
    }
    case "verified_unbranded":
      return { type: "verified_unbranded", name: client.name ?? fallbackName };
    case "unverified":
      return { type: "unverified", name: client.name ?? fallbackName };
    default:
      client satisfies never;
      return panic("Unhandled consent client presentation");
  }
};
