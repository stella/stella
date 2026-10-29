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
    version: 17,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Retain the listing court in quarantine fingerprints and require court provenance for repair candidates. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.CZ_NS]: {
    version: 21,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Retain the listing court in quarantine fingerprints and require court provenance for repair candidates.",
    },
  },
  [ADAPTER_KEYS.CZ_NSS]: {
    version: 25,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Retain the listing court in quarantine fingerprints and require court provenance for repair candidates.",
    },
  },
  [ADAPTER_KEYS.CZ_US]: {
    version: 33,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Retain the listing court in quarantine fingerprints and require court provenance for repair candidates. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.SK_COURTS]: {
    version: 21,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Retain the listing court in quarantine fingerprints and require court provenance for repair candidates. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.SK_US]: {
    version: 18,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Retain the listing court in quarantine fingerprints and require court provenance for repair candidates. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.PL_COURTS]: {
    version: 18,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Retain the listing court in quarantine fingerprints and require court provenance for repair candidates. Refresh the parser contract alongside required observations on every listing page; the existing publisher identity and text remain authoritative and no parser feature has separate storage.",
    },
  },
  [ADAPTER_KEYS.PL_SN]: {
    version: 10,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Retain the listing court in quarantine fingerprints and require court provenance for repair candidates.",
    },
  },
  [ADAPTER_KEYS.PL_KIO]: {
    version: 12,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Retain the listing court in quarantine fingerprints and require court provenance for repair candidates. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.PL_TK]: {
    version: 10,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Retain the listing court in quarantine fingerprints and require court provenance for repair candidates.",
    },
  },
  [ADAPTER_KEYS.PL_NSA]: {
    version: 11,
    scope: {
      type: "all",
      reason:
        "Classify the thesis heading as publisher head matter when rebuilding the stored dataset sections; AST roles have no separate feature storage. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.PL_NCOURT]: {
    version: 17,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Retain the listing court in quarantine fingerprints and require court provenance for repair candidates. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.AT_COURTS]: {
    version: 10,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.AT_VFGH]: {
    version: 10,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.AT_VWGH]: {
    version: 10,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.AT_BVWG]: {
    version: 10,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.AT_LVWG]: {
    version: 10,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.AT_ASYLGH]: {
    version: 10,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.AT_UBAS]: {
    version: 10,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.AT_UVS]: {
    version: 10,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.AT_VERG]: {
    version: 10,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.AT_UMSE]: {
    version: 10,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.AT_BKS]: {
    version: 10,
    scope: {
      type: "all",
      reason:
        "Reclassify publisher headings and trailing publisher metadata from stored RIS XML; AST roles have no separate feature storage. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.AT_FINDOK]: {
    version: 12,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Retain the listing court in quarantine fingerprints and require court provenance for repair candidates. Refresh the parser contract alongside required observations on every listing page; the existing publisher identity and text remain authoritative and no parser feature has separate storage.",
    },
  },
  [ADAPTER_KEYS.EU_ECJ]: {
    version: 18,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Retain the listing court in quarantine fingerprints and require court provenance for repair candidates.",
    },
  },
  [ADAPTER_KEYS.UK_FCL]: {
    version: 5,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Retain the listing court in quarantine fingerprints and require court provenance for repair candidates. Refresh the parser contract alongside required observations on every listing page; the existing publisher identity and text remain authoritative and no parser feature has separate storage.",
    },
  },
  [ADAPTER_KEYS.HU_BHGY]: {
    version: 23,
    scope: {
      type: "all",
      reason:
        "Reclassify closing certification, principle-summary and applied-legislation sections from stored Hungarian documents; AST roles have no separate feature storage. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.PL_KIS]: {
    version: 12,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Retain the listing court in quarantine fingerprints and require court provenance for repair candidates. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.PL_UODO]: {
    version: 16,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Retain the listing court in quarantine fingerprints and require court provenance for repair candidates. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.PL_UOKIK]: {
    version: 13,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Retain the listing court in quarantine fingerprints and require court provenance for repair candidates. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
  [ADAPTER_KEYS.CZ_UOHS]: {
    version: 6,
    scope: {
      type: "all",
      reason:
        "Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Retain the listing court in quarantine fingerprints and require court provenance for repair candidates. Recompute only document-qualified repair candidates from stored listing evidence; preserve quarantine keys and text. New listing evidence requires a re-crawl.",
    },
  },
} as const satisfies ParserVersionScopes<
  Pick<typeof PARSER_VERSIONS, AdapterKey>
>;
