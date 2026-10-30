import type { ParserVersionScopes } from "../parser-reparse-scopes";

export const ADAPTER_KEYS = { CZ_NSS: "cz-nss" } as const;
export const PARSER_VERSIONS = { [ADAPTER_KEYS.CZ_NSS]: 25 } as const;
export const SOURCE_FINGERPRINT_VERSIONS = {
  [ADAPTER_KEYS.CZ_NSS]: 0,
} as const;
export const PARSER_VERSION_SCOPES = {
  [ADAPTER_KEYS.CZ_NSS]: {
    version: PARSER_VERSIONS[ADAPTER_KEYS.CZ_NSS],
    scope: {
      type: "all",
      reason:
        "Rebuild decision text, structure and paragraph identities from archived pages or registry originals; read current scalar metadata separately from related-record evidence and retain conflicting scalar values. Rebuild inline emphasis from retained PDF originals with the shared style mapper. Discovering an uncaptured original requires a normal re-crawl.",
    },
  },
} as const satisfies ParserVersionScopes<typeof PARSER_VERSIONS>;
