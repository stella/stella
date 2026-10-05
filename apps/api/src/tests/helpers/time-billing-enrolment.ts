import { inArray } from "drizzle-orm";

import { user as authUser } from "@/api/db/auth-schema";
import { featureEnrolments } from "@/api/db/schema";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/auth/feature-access/policy";
import type { SafeId } from "@/api/lib/branded-types";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import type { TestDatabase } from "@/api/tests/security/test-utils";

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

type TimeBillingPrincipal = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
};

/** Enrol database fixture callers the way the self-serve toggle does. */
export const enrolTimeBilling = async (
  db: TestDatabase,
  principals: readonly TimeBillingPrincipal[],
) => {
  await db
    .update(authUser)
    .set({ emailVerified: true })
    .where(
      inArray(
        authUser.id,
        principals.map(({ userId }) => userId),
      ),
    );
  await db
    .insert(featureEnrolments)
    .values(
      principals.map((principal) => ({
        ...principal,
        featureId: "time-billing" as const,
      })),
    )
    .onConflictDoNothing();
};
