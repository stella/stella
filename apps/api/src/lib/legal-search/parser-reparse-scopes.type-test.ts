import {
  PARSER_REPARSE_FEATURES,
  PARSER_VERSION_SCOPES,
  type ParserReparseFeature,
  type ParserReparseScope,
  type ParserVersionScopes,
} from "./parser-reparse-scopes";

type DeclaredScopes = typeof PARSER_VERSION_SCOPES;
type DeclaredFeatures = typeof PARSER_REPARSE_FEATURES;

const declaredScopesCompile: DeclaredScopes = PARSER_VERSION_SCOPES;
const declaredFeaturesCompile: DeclaredFeatures = PARSER_REPARSE_FEATURES;

export const parserReparseDeclarationsCompile = {
  scopes: declaredScopesCompile,
  features: declaredFeaturesCompile,
};

const registeredFeatures = {
  citations: {
    table: "case_law",
    column: "citations",
    stored: true,
    backfilled: true,
  },
  pendingSummary: {
    table: "case_law",
    column: "summary",
    stored: true,
    backfilled: false,
  },
} as const satisfies Record<string, ParserReparseFeature>;

export const validAllScope = {
  source: {
    version: 1,
    scope: { type: "all", reason: "rebuild every parsed value" },
  },
} as const satisfies ParserVersionScopes<{ source: 1 }>;

export const mismatchedScopeVersion = {
  source: {
    // @ts-expect-error A scope version must equal its parser's literal version.
    version: 2,
    scope: { type: "all", reason: "rebuild every parsed value" },
  },
} as const satisfies ParserVersionScopes<{ source: 1 }>;

export const unregisteredFeatureScope = {
  type: "features",
  // @ts-expect-error A feature scope cannot name an unregistered feature.
  features: ["headnotes"],
} as const satisfies ParserReparseScope<typeof registeredFeatures>;

export const notBackfilledFeatureScope = {
  type: "features",
  // @ts-expect-error A feature scope can only name stored, backfilled features.
  features: ["pendingSummary"],
} as const satisfies ParserReparseScope<typeof registeredFeatures>;
