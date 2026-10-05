const LEGAL_LISTS_FEATURE = {
  id: "legal-lists",
  requires: [],
  routeImports: ["@/lib/workspaces/queries/legal-lists"],
} as const;

/** Feature ids name the server's policy decisions; undeclared ids are hidden. */
export const CALLER_FEATURE = {
  verification: {
    id: "list-verification",
    // AVT reads list metadata and anchor facts as well as verification runs.
    requires: [LEGAL_LISTS_FEATURE.id],
    routeImports: ["@/features/avt/"],
  },
  legalLists: LEGAL_LISTS_FEATURE,
} as const;

export type CallerFeature =
  (typeof CALLER_FEATURE)[keyof typeof CALLER_FEATURE];
