import type { ParserVersionScopes } from "../parser-reparse-scopes";

export const ADAPTER_KEYS = { PL_KIS: "pl-kis" } as const;
export const PARSER_VERSIONS = { [ADAPTER_KEYS.PL_KIS]: 12 } as const;
export const SOURCE_FINGERPRINT_VERSIONS = {
  [ADAPTER_KEYS.PL_KIS]: 0,
} as const;
export const PARSER_VERSION_SCOPES = {
  [ADAPTER_KEYS.PL_KIS]: {
    version: PARSER_VERSIONS[ADAPTER_KEYS.PL_KIS],
    scope: {
      type: "all",
      reason:
        "Re-read printed title order and opening, operative and signature roles from stored source; preserve inline bold and italic emphasis in PDFs.",
    },
  },
} as const satisfies ParserVersionScopes<typeof PARSER_VERSIONS>;
