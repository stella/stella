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
    version: 15,
    scope: {
      type: "all",
      reason:
        "running headers, soft hyphens, misplaced opening quotes, title lines and paragraph numbers are recomputed from the stored decision, and none of them has feature storage of its own",
    },
  },
  [ADAPTER_KEYS.CZ_NS]: {
    version: 20,
    scope: {
      type: "all",
      reason:
        "running headers, page numbers, soft hyphens, captions and paragraph numbers are recomputed from the stored print page, and none of them has feature storage of its own",
    },
  },
  [ADAPTER_KEYS.CZ_NSS]: {
    version: 22,
    scope: {
      type: "all",
      reason:
        "page furniture, page-break cuts, letter-spaced words, layout tables, list numbers, subsection headings, separate opinions and paragraph numbers are recomputed from the stored page, and none of them has feature storage of its own",
    },
  },
  [ADAPTER_KEYS.CZ_US]: {
    version: 31,
    scope: {
      type: "all",
      reason:
        "the record card's affected constitutional and other provisions are read one listed act per value, so the stored provision lists are recomputed from the stored card; paragraph text, ruling roles, separate-opinion headings, letter-spaced words and paragraph numbers are recomputed from the stored page, and none of them has feature storage of its own",
    },
  },
  [ADAPTER_KEYS.SK_COURTS]: {
    version: 19,
    scope: {
      type: "all",
      reason:
        "paragraph text and block boundaries are recomputed from the stored PDF (a line the layout wrapped inside a sentence no longer opens a numbered point or a signature), a decision title set over several lines is one heading, and repeated section headings get unique anchors; paragraphs have no feature storage of their own",
    },
  },
  [ADAPTER_KEYS.SK_US]: {
    version: 16,
    scope: {
      type: "all",
      reason:
        "paragraph text, paragraph numbers and anonymization markers are recomputed from stored markup before whitespace trimming, including unpainted non-breaking-space redaction runs; letter-spaced words and section markers include uneven chunks witnessed by intact words in the decision; none has feature storage of its own",
    },
  },
  [ADAPTER_KEYS.PL_COURTS]: {
    version: 17,
    scope: {
      type: "all",
      reason:
        "Re-read printed title order and opening, operative and signature roles from stored source; roles and block ordering have no independent feature storage.",
    },
  },
  [ADAPTER_KEYS.PL_SN]: {
    version: 10,
    scope: {
      type: "all",
      reason:
        "Re-read printed title order and opening, operative and signature roles from stored source; preserve inline bold and italic emphasis in PDFs.",
    },
  },
  [ADAPTER_KEYS.PL_KIO]: {
    version: 11,
    scope: {
      type: "all",
      reason:
        "Re-read printed title order and opening, operative and signature roles from stored source; roles and block ordering have no independent feature storage.",
    },
  },
  [ADAPTER_KEYS.PL_TK]: {
    version: 9,
    scope: {
      type: "all",
      reason:
        "Re-read Tribunal exports with collapsed whitespace, attached superscripts, linked footnotes and named dissent authors.",
    },
  },
  [ADAPTER_KEYS.PL_NSA]: {
    version: 9,
    scope: {
      type: "all",
      reason:
        "Rejoin sentences split across paragraphs, drop page numbers after the closing rule and join marked superscript article numbers.",
    },
  },
  [ADAPTER_KEYS.PL_NCOURT]: {
    version: 16,
    scope: {
      type: "all",
      reason:
        "Re-read printed title order and opening, operative and signature roles from stored source; roles and block ordering have no independent feature storage.",
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
    version: 10,
    scope: {
      type: "all",
      reason:
        "Revalidate document AST identities across the complete parser output.",
    },
  },
  [ADAPTER_KEYS.EU_ECJ]: {
    version: 17,
    scope: {
      type: "all",
      reason:
        "paragraph numbers, headings, roles and page anchors of the oldest layout, the operative-part heading, the case number and the court all change together in the document AST and the row, which have no feature storage of their own",
    },
  },
  [ADAPTER_KEYS.UK_FCL]: {
    version: 3,
    scope: {
      type: "all",
      reason:
        "Read the stated judgment type and ECLI availability from the stored XML envelope.",
    },
  },
  [ADAPTER_KEYS.HU_BHGY]: {
    version: 21,
    scope: {
      type: "all",
      reason:
        "move range markers between blocks are skipped as positions, so paragraph text and footnotes in the document AST are recomputed, and neither has feature storage of its own",
    },
  },
  [ADAPTER_KEYS.PL_KIS]: {
    version: 11,
    scope: {
      type: "all",
      reason:
        "Re-read printed title order and opening, operative and signature roles from stored source; preserve inline bold and italic emphasis in PDFs.",
    },
  },
  [ADAPTER_KEYS.PL_UODO]: {
    version: 14,
    scope: {
      type: "all",
      reason:
        "Revalidate document AST identities across the complete parser output.",
    },
  },
  [ADAPTER_KEYS.PL_UOKIK]: {
    version: 12,
    scope: {
      type: "all",
      reason:
        "Re-read printed title order and opening, operative and signature roles from stored source; preserve inline bold and italic emphasis in PDFs.",
    },
  },
  [ADAPTER_KEYS.CZ_UOHS]: {
    version: 4,
    scope: {
      type: "all",
      reason:
        "paragraph numbers are recomputed from the stored document and have no feature storage of their own",
    },
  },
} as const satisfies ParserVersionScopes<
  Pick<typeof PARSER_VERSIONS, AdapterKey>
>;
