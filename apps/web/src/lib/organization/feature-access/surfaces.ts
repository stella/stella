const LEGAL_LISTS_FEATURE = {
  id: "legal-lists",
  requires: [],
  undeclared: { type: "deployment", key: "legalLists" },
  routeImports: ["@/lib/workspaces/queries/legal-lists"],
} as const;

/** Declared policies require caller decisions; explicit fallbacks use server deployment availability. */
export const CALLER_FEATURE = {
  verification: {
    id: "list-verification",
    // AVT reads list metadata and anchor facts as well as verification runs.
    requires: [LEGAL_LISTS_FEATURE],
    undeclared: { type: "hidden" },
    routeImports: ["@/features/avt/"],
  },
  legalLists: LEGAL_LISTS_FEATURE,
} as const;

export type CallerFeature =
  (typeof CALLER_FEATURE)[keyof typeof CALLER_FEATURE];
