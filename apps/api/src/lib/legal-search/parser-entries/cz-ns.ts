import type { ParserVersionScopes } from "../parser-reparse-scopes";

export const ADAPTER_KEYS = { CZ_NS: "cz-ns" } as const;
export const PARSER_VERSIONS = { [ADAPTER_KEYS.CZ_NS]: 21 } as const;
export const SOURCE_FINGERPRINT_VERSIONS = { [ADAPTER_KEYS.CZ_NS]: 0 } as const;
export const PARSER_VERSION_SCOPES = {
  [ADAPTER_KEYS.CZ_NS]: {
    version: PARSER_VERSIONS[ADAPTER_KEYS.CZ_NS],
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
} as const satisfies ParserVersionScopes<typeof PARSER_VERSIONS>;
