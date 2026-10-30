import type { ParserVersionScopes } from "../parser-reparse-scopes";

export const ADAPTER_KEYS = { SK_COURTS: "sk-courts" } as const;
export const PARSER_VERSIONS = { [ADAPTER_KEYS.SK_COURTS]: 20 } as const;
export const SOURCE_FINGERPRINT_VERSIONS = {
  [ADAPTER_KEYS.SK_COURTS]: 0,
} as const;
export const PARSER_VERSION_SCOPES = {
  [ADAPTER_KEYS.SK_COURTS]: {
    version: PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS],
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
} as const satisfies ParserVersionScopes<typeof PARSER_VERSIONS>;
