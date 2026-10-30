import type { ParserVersionScopes } from "../parser-reparse-scopes";

export const ADAPTER_KEYS = { PL_COURTS: "pl-courts" } as const;
export const PARSER_VERSIONS = { [ADAPTER_KEYS.PL_COURTS]: 18 } as const;
export const SOURCE_FINGERPRINT_VERSIONS = {
  [ADAPTER_KEYS.PL_COURTS]: 0,
} as const;
export const PARSER_VERSION_SCOPES = {
  [ADAPTER_KEYS.PL_COURTS]: {
    version: PARSER_VERSIONS[ADAPTER_KEYS.PL_COURTS],
    scope: {
      type: "all",
      reason:
        "Re-read printed title order and opening, operative and signature roles from stored source; roles and block ordering have no independent feature storage.",
    },
  },
} as const satisfies ParserVersionScopes<typeof PARSER_VERSIONS>;
