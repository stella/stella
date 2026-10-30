import type { ParserVersionScopes } from "../parser-reparse-scopes";

export const ADAPTER_KEYS = { AT_UBAS: "at-ubas" } as const;
export const PARSER_VERSIONS = { [ADAPTER_KEYS.AT_UBAS]: 9 } as const;
export const SOURCE_FINGERPRINT_VERSIONS = {
  [ADAPTER_KEYS.AT_UBAS]: 0,
} as const;
export const PARSER_VERSION_SCOPES = {
  [ADAPTER_KEYS.AT_UBAS]: {
    version: PARSER_VERSIONS[ADAPTER_KEYS.AT_UBAS],
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage.",
    },
  },
} as const satisfies ParserVersionScopes<typeof PARSER_VERSIONS>;
