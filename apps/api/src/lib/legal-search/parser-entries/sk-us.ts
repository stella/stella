import type { ParserVersionScopes } from "../parser-reparse-scopes";

export const ADAPTER_KEYS = { SK_US: "sk-us" } as const;
export const PARSER_VERSIONS = { [ADAPTER_KEYS.SK_US]: 17 } as const;
export const SOURCE_FINGERPRINT_VERSIONS = { [ADAPTER_KEYS.SK_US]: 0 } as const;
export const PARSER_VERSION_SCOPES = {
  [ADAPTER_KEYS.SK_US]: {
    version: PARSER_VERSIONS[ADAPTER_KEYS.SK_US],
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
} as const satisfies ParserVersionScopes<typeof PARSER_VERSIONS>;
