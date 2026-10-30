import type { ParserVersionScopes } from "../parser-reparse-scopes";

export const ADAPTER_KEYS = { UK_FCL: "uk-fcl" } as const;
export const PARSER_VERSIONS = { [ADAPTER_KEYS.UK_FCL]: 4 } as const;
export const SOURCE_FINGERPRINT_VERSIONS = {
  [ADAPTER_KEYS.UK_FCL]: 0,
} as const;
export const PARSER_VERSION_SCOPES = {
  [ADAPTER_KEYS.UK_FCL]: {
    version: PARSER_VERSIONS[ADAPTER_KEYS.UK_FCL],
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
} as const satisfies ParserVersionScopes<typeof PARSER_VERSIONS>;
