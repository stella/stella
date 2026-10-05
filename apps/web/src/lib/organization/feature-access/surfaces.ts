/** Feature ids name the server's policy decisions; undeclared ids are hidden. */
export const CALLER_FEATURE = {
  verification: {
    id: "list-verification",
    routeImports: ["@/features/avt/"],
  },
  legalLists: {
    id: "legal-lists",
    routeImports: ["@/lib/workspaces/queries/legal-lists"],
  },
} as const;

export type CallerFeature =
  (typeof CALLER_FEATURE)[keyof typeof CALLER_FEATURE];
