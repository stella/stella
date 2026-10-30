import type { ParserVersionScopes } from "../parser-reparse-scopes";

export const ADAPTER_KEYS = { HU_BHGY: "hu-bhgy" } as const;
export const PARSER_VERSIONS = { [ADAPTER_KEYS.HU_BHGY]: 22 } as const;
export const SOURCE_FINGERPRINT_VERSIONS = {
  [ADAPTER_KEYS.HU_BHGY]: 0,
} as const;
export const PARSER_VERSION_SCOPES = {
  [ADAPTER_KEYS.HU_BHGY]: {
    version: PARSER_VERSIONS[ADAPTER_KEYS.HU_BHGY],
    scope: {
      type: "all",
      reason:
        "Reclassify closing certification, principle-summary and applied-legislation sections from stored Hungarian documents; AST roles have no separate feature storage.",
    },
  },
} as const satisfies ParserVersionScopes<typeof PARSER_VERSIONS>;
