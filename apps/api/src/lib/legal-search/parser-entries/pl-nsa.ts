import type { ParserVersionScopes } from "../parser-reparse-scopes";

export const ADAPTER_KEYS = { PL_NSA: "pl-nsa" } as const;
export const PARSER_VERSIONS = { [ADAPTER_KEYS.PL_NSA]: 10 } as const;
export const SOURCE_FINGERPRINT_VERSIONS = {
  [ADAPTER_KEYS.PL_NSA]: 0,
} as const;
export const PARSER_VERSION_SCOPES = {
  [ADAPTER_KEYS.PL_NSA]: {
    version: PARSER_VERSIONS[ADAPTER_KEYS.PL_NSA],
    scope: {
      type: "all",
      reason:
        "Classify the thesis heading as publisher head matter when rebuilding the stored dataset sections; AST roles have no separate feature storage.",
    },
  },
} as const satisfies ParserVersionScopes<typeof PARSER_VERSIONS>;
