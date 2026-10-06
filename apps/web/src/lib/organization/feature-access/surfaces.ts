const LIST_VERIFICATION_FEATURE_ID = "list-verification";

const LEGAL_LISTS_FEATURE = {
  id: "legal-lists",
  requires: [],
  undeclared: {
    type: "deployment-and-enabled-for",
    key: "legalLists",
    featureIds: [LIST_VERIFICATION_FEATURE_ID],
  },
  routeImports: ["@/lib/workspaces/queries/legal-lists"],
} as const;

/** Declared policies require caller decisions; explicit fallbacks use server deployment availability. */
export const CALLER_FEATURE = {
  verification: {
    id: LIST_VERIFICATION_FEATURE_ID,
    // AVT reads list metadata and anchor facts as well as verification runs.
    requires: [LEGAL_LISTS_FEATURE],
    undeclared: { type: "hidden" },
    routeImports: ["@/features/avt/"],
  },
  legalLists: LEGAL_LISTS_FEATURE,
} as const;

export type CallerFeature =
  (typeof CALLER_FEATURE)[keyof typeof CALLER_FEATURE];
