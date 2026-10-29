import { panic } from "better-result";

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

/** Evaluate a declared scope against the selectors present on one stored row. */
export const matchesParserReparseScope = <
  Registry extends Record<string, ParserReparseFeature>,
>(
  scope: ParserReparseScope<Registry>,
  matchesFeature: (feature: Registry[keyof Registry]) => boolean,
  registry: Registry,
): boolean => {
  switch (scope.type) {
    case "all":
      return true;
    case "features":
      return scope.features.some((feature) =>
        matchesFeature(registry[feature]),
      );
    default:
      scope satisfies never;
      return panic(`Unhandled parser re-parse scope: ${String(scope)}`);
  }
};

export const storedFeaturesForParserReparseScope = <
  Registry extends Record<string, ParserReparseFeature>,
>(
  scope: ParserReparseScope<Registry>,
  registry: Registry,
): readonly ParserReparseFeature[] => {
  switch (scope.type) {
    case "all":
      return [];
    case "features":
      return scope.features.map(
        (feature) =>
          registry[feature] ?? panic(`Unregistered parser feature: ${feature}`),
      );
    default:
      scope satisfies never;
      return panic(`Unhandled parser re-parse scope: ${String(scope)}`);
  }
};

export const PARSER_VERSION_SCOPES = {
  [ADAPTER_KEYS.CZ_REGIONAL]: {
    version: 16,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.CZ_NS]: {
    version: 21,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.CZ_NSS]: {
    version: 24,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.CZ_US]: {
    version: 32,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.SK_COURTS]: {
    version: 20,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.SK_US]: {
    version: 18,
    scope: {
      type: "all",
      reason:
        "Recompute paragraph text, anonymization and heading identities from stored markup, preserving empty title-run fonts alongside letter-spaced text handling.",
    },
  },
  [ADAPTER_KEYS.PL_COURTS]: {
    version: 17,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.PL_SN]: {
    version: 11,
    scope: {
      type: "all",
      reason:
        "Re-read stored Supreme Court responses to retain typed document-read outcomes and raw bodies when PDF decoding or parsing fails.",
    },
  },
  [ADAPTER_KEYS.PL_KIO]: {
    version: 11,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.PL_TK]: {
    version: 10,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.PL_NSA]: {
    version: 10,
    scope: {
      type: "all",
      reason:
        "Classify the thesis heading as publisher head matter when rebuilding the stored dataset sections; AST roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.PL_NCOURT]: {
    version: 16,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.AT_COURTS]: {
    version: 9,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.AT_VFGH]: {
    version: 9,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.AT_VWGH]: {
    version: 9,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.AT_BVWG]: {
    version: 9,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.AT_LVWG]: {
    version: 9,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.AT_ASYLGH]: {
    version: 9,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.AT_UBAS]: {
    version: 9,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.AT_UVS]: {
    version: 9,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.AT_VERG]: {
    version: 9,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.AT_UMSE]: {
    version: 9,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.AT_BKS]: {
    version: 9,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.AT_FINDOK]: {
    version: 11,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.EU_ECJ]: {
    version: 18,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.UK_FCL]: {
    version: 4,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.HU_BHGY]: {
    version: 22,
    scope: {
      type: "all",
      reason:
        "Reclassify closing certification, principle-summary and applied-legislation sections from stored Hungarian documents; AST roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.PL_KIS]: {
    version: 11,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.PL_UODO]: {
    version: 15,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.PL_UOKIK]: {
    version: 12,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
  [ADAPTER_KEYS.CZ_UOHS]: {
    version: 5,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage.",
    },
  },
} as const satisfies ParserVersionScopes<
  Pick<typeof PARSER_VERSIONS, AdapterKey>
>;
