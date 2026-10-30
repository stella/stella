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
  invoiceLinks: {
    id: "invoice-links",
    deployment: "invoiceLinks",
    requires: [],
    undeclared: { type: "hidden" },
    // Optional controls on a billing route; the invoice page remains available.
    routeImports: [],
  },
  aiMemory: {
    id: "ai-memory",
    requires: [],
    undeclared: { type: "hidden" },
    routeImports: [
      "@/routes/_protected.settings/-queries/memories",
      "@/routes/_protected.settings/-components/account/memory/",
    ],
  },
  verification: {
    id: LIST_VERIFICATION_FEATURE_ID,
    // AVT reads list metadata and anchor facts as well as verification runs.
    requires: [LEGAL_LISTS_FEATURE],
    undeclared: { type: "hidden" },
    routeImports: ["@/features/avt/"],
  },
  legalLists: LEGAL_LISTS_FEATURE,
} as const;

/**
 * Keys of the organization settings `deploymentFeatures` map. This module stays
 * import-free because a lint plugin reads it; access.logic.ts indexes the
 * settings map with these keys, so a key the contract lacks fails to compile.
 */
type WebDeploymentFeature = "legalLists" | "invoiceLinks";

export type CallerFeature =
  (typeof CALLER_FEATURE)[keyof typeof CALLER_FEATURE] & {
    deployment?: WebDeploymentFeature;
  };
