import {
  ADAPTER_KEYS,
  type AdapterKey,
  type PARSER_VERSIONS,
} from "./ingestion-constants";

/**
 * `parser-reparse-scopes.ts` owns stored parser decisions that can be targeted
 * independently during replay.
 *
 * This registry intentionally starts empty: no parser feature value has
 * dedicated storage yet. A feature may be added only with its table and
 * column (plus a JSONB path when applicable), and an explicit backfill state.
 * `PARSER_VERSION_SCOPES` declares what a re-parse at a version recomputes:
 * either every parser-owned value, with a reason, or named features whose
 * values are already stored and backfilled.
 */
export const PARSER_REPARSE_FEATURES = {} as const satisfies Record<
  string,
  ParserReparseFeature
>;

export type ParserReparseFeature = {
  table: string;
  column: string;
  jsonbPath?: readonly [string, ...string[]];
  stored: boolean;
  backfilled: boolean;
};

type StoredBackfilledFeature<
  Registry extends Record<string, ParserReparseFeature>,
> = {
  [Feature in keyof Registry]: Registry[Feature] extends {
    stored: true;
    backfilled: true;
  }
    ? Feature
    : never;
}[keyof Registry] &
  string;

export type ParserReparseScope<
  Registry extends Record<string, ParserReparseFeature> =
    typeof PARSER_REPARSE_FEATURES,
> =
  | { type: "all"; reason: string }
  | {
      type: "features";
      features: readonly [
        StoredBackfilledFeature<Registry>,
        ...StoredBackfilledFeature<Registry>[],
      ];
    };

export type ParserVersionScopes<
  Versions extends Record<string, number>,
  Registry extends Record<string, ParserReparseFeature> =
    typeof PARSER_REPARSE_FEATURES,
> = {
  [Key in keyof Versions]: {
    version: Versions[Key];
    scope: ParserReparseScope<Registry>;
  };
};

export const PARSER_VERSION_SCOPES = {
  [ADAPTER_KEYS.CZ_REGIONAL]: {
    version: 13,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.CZ_NS]: {
    version: 18,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.CZ_NSS]: {
    version: 20,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.CZ_US]: {
    version: 25,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.SK_COURTS]: {
    version: 16,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.SK_US]: {
    version: 11,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.PL_COURTS]: {
    version: 13,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.PL_SN]: {
    version: 6,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.PL_KIO]: {
    version: 6,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.PL_TK]: {
    version: 7,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.PL_NSA]: {
    version: 8,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.PL_NCOURT]: {
    version: 12,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.AT_COURTS]: {
    version: 8,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.AT_VFGH]: {
    version: 8,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.AT_VWGH]: {
    version: 8,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.AT_BVWG]: {
    version: 8,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.AT_LVWG]: {
    version: 8,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.AT_ASYLGH]: {
    version: 8,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.AT_UBAS]: {
    version: 8,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.AT_UVS]: {
    version: 8,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.AT_VERG]: {
    version: 8,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.AT_UMSE]: {
    version: 8,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.AT_BKS]: {
    version: 8,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.AT_FINDOK]: {
    version: 9,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.EU_ECJ]: {
    version: 15,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.HU_BHGY]: {
    version: 18,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.PL_KIS]: {
    version: 8,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.PL_UODO]: {
    version: 12,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.PL_UOKIK]: {
    version: 10,
    scope: {
      type: "all",
      reason: "scope declarations start with this contract",
    },
  },
  [ADAPTER_KEYS.CZ_UOHS]: {
    version: 2,
    scope: {
      type: "all",
      reason: "the source's first parser; there are no stored rows to narrow",
    },
  },
} as const satisfies ParserVersionScopes<
  Pick<typeof PARSER_VERSIONS, AdapterKey>
>;
