import type { SafeId } from "@/api/lib/branded-types";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import {
  CITATION_CHECK_FEATURE_ID,
  FEATURE_REGISTRY,
} from "@/api/lib/feature-access/registry";

/** A principal whose organization holds the citation-check grant. */
export const grantedCitationCheckSnapshot = (principal: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
}) =>
  createFeatureAccessSnapshot({
    ...principal,
    decisions: new Map([
      [
        CITATION_CHECK_FEATURE_ID,
        decideFeatureAccess({
          ...principal,
          registry: FEATURE_REGISTRY,
          featureId: CITATION_CHECK_FEATURE_ID,
          grants: {
            [CITATION_CHECK_FEATURE_ID]: [
              {
                type: "organization",
                organizationId: principal.organizationId,
              },
            ],
          },
          user: { email: "member@example.test", emailVerified: true },
          membership: true,
        }),
      ],
    ]),
  });
