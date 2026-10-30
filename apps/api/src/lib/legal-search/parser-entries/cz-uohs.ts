import type { ParserVersionScopes } from "../parser-reparse-scopes";

export const ADAPTER_KEYS = { CZ_UOHS: "cz-uohs" } as const;
export const PARSER_VERSIONS = { [ADAPTER_KEYS.CZ_UOHS]: 6 } as const;
export const SOURCE_FINGERPRINT_VERSIONS = {
  [ADAPTER_KEYS.CZ_UOHS]: 0,
} as const;
export const PARSER_VERSION_SCOPES = {
  [ADAPTER_KEYS.CZ_UOHS]: {
    version: PARSER_VERSIONS[ADAPTER_KEYS.CZ_UOHS],
    scope: {
      type: "all",
      reason:
        "Re-read font-run segmentation after the shared PDF style mapping changed; Czech output remains plain text and footnote links, with no independent feature storage.",
    },
  },
} as const satisfies ParserVersionScopes<typeof PARSER_VERSIONS>;
