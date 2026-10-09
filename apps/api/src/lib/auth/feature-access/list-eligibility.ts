import type {
  legalListFactDetails,
  legalListItemSources,
} from "@/api/db/schema";
import type { FeatureAccessRequirement } from "@/api/lib/auth/feature-access/requirements";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";

// Shared list reads remain available while resolving caller-specific fields.
export const LIST_VERIFICATION_DISCOVERY_FEATURE_ACCESS = {
  featureId: LIST_VERIFICATION_FEATURE_ID,
  type: "conditional",
  usesFeature: () => false,
  projectInputSchema: (schemas) => schemas,
} as const satisfies FeatureAccessRequirement;

export const projectListFactDetails = <
  T extends Pick<typeof legalListFactDetails.$inferSelect, "scoring">,
>(
  details: T | null,
  accessStatus: "available" | "unavailable",
) => {
  if (details === null) {
    return null;
  }
  const { scoring, ...common } = details;
  return { ...common, ...(accessStatus === "available" ? { scoring } : {}) };
};

export const projectListItemSource = <
  T extends Pick<
    typeof legalListItemSources.$inferSelect,
    "verificationStatus" | "verifiedBy" | "verifiedAt"
  >,
>(
  source: T,
  accessStatus: "available" | "unavailable",
) => {
  const { verificationStatus, verifiedBy, verifiedAt, ...common } = source;
  return {
    ...common,
    ...(accessStatus === "available"
      ? { verificationStatus, verifiedBy, verifiedAt }
      : {}),
  };
};
