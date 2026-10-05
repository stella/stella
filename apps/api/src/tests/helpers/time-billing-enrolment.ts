import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/auth/feature-access/policy";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";

export const enrolledTimeBillingSnapshot = (principal: {
  userId: string;
  organizationId: string;
}) => {
  const featureId = "time-billing";
  return createFeatureAccessSnapshot({
    ...principal,
    decisions: new Map([
      [
        featureId,
        decideFeatureAccess({
          ...principal,
          registry: FEATURE_REGISTRY,
          featureId,
          membership: true,
          user: { email: "billing@example.test", emailVerified: true },
          grants: {},
          enrolments: [{ ...principal, featureId }],
        }),
      ],
    ]),
  });
};

/** Opt a billing behavior fixture into the caller's own feature enrolment. */
export const withTimeBillingEnrolment = <
  T extends {
    session: { activeOrganizationId: string };
    user: { id: string };
  },
>(
  context: T,
) => {
  const principal = {
    userId: context.user.id,
    organizationId: context.session.activeOrganizationId,
  };
  return {
    ...context,
    featureAccessSnapshot: enrolledTimeBillingSnapshot(principal),
  };
};
