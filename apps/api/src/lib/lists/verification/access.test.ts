import { expect, test } from "bun:test";
import * as v from "valibot";

import { envApiServerSchema } from "@/api/env-schema";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import {
  decideFeatureAccess,
  isFeatureEnabled,
} from "@/api/lib/auth/feature-access/policy";
import { toSafeId } from "@/api/lib/branded-types";
import {
  FEATURE_REGISTRY,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const memberGrant = {
  type: "member",
  organizationId: "org-a",
  email: "member@example.test",
} as const;
const organizationGrant = {
  type: "organization",
  organizationId: "org-a",
} as const;

test("the verification declaration uses invitation enrollment and the shared identity policy", () => {
  expect(FEATURE_REGISTRY[LIST_VERIFICATION_FEATURE_ID].enrolment).toBe(
    "invitation",
  );
  for (const grant of [memberGrant, organizationGrant]) {
    for (const organizationId of ["org-a", "org-b"]) {
      for (const email of ["member@example.test", "changed@example.test"]) {
        for (const emailVerified of [false, true]) {
          for (const membership of [false, true]) {
            const result = decideFeatureAccess({
              registry: FEATURE_REGISTRY,
              featureId: LIST_VERIFICATION_FEATURE_ID,
              grants: { [LIST_VERIFICATION_FEATURE_ID]: [grant] },
              organizationId,
              userId: "user-a",
              user: { email, emailVerified },
              membership,
            });
            expect(result.status).toBe(
              organizationId === "org-a" &&
                emailVerified &&
                membership &&
                (grant.type === "organization" || email === memberGrant.email)
                ? "enabled"
                : "hidden",
            );
            if (result.status === "enabled") {
              expect(result.proof).toMatchObject({
                featureId: LIST_VERIFICATION_FEATURE_ID,
                organizationId,
                userId: "user-a",
              });
            }
          }
        }
      }
    }
  }
});

test("parsed verification grants resolve against current identity and deny absent membership", async () => {
  const organizationId = toSafeId<"organization">("org-a");
  const { grants } = v.parse(
    envApiServerSchema.API_FEATURE_ACCESS_GRANTS,
    JSON.stringify({
      [LIST_VERIFICATION_FEATURE_ID]: [
        { ...memberGrant, email: " Member@Example.Test " },
      ],
    }),
  );
  for (const identity of [
    { email: memberGrant.email, emailVerified: true },
    { email: "changed@example.test", emailVerified: true },
    { email: memberGrant.email, emailVerified: false },
    null,
  ]) {
    const database = createScopedDbMock({}, { featureAccess: { identity } });
    const snapshot = await database.scopedDb(
      async (tx) =>
        await resolveFeatureAccessSnapshot({
          tx,
          organizationId,
          userId: "user-a",
          grants,
        }),
    );
    expect(
      isFeatureEnabled(snapshot, LIST_VERIFICATION_FEATURE_ID, {
        organizationId,
        userId: "user-a",
      }),
    ).toBe(identity?.email === memberGrant.email && identity.emailVerified);
    expect(
      isFeatureEnabled(snapshot, LIST_VERIFICATION_FEATURE_ID, {
        organizationId: "org-b",
        userId: "user-a",
      }),
    ).toBe(false);
    expect(
      isFeatureEnabled(snapshot, LIST_VERIFICATION_FEATURE_ID, {
        organizationId,
        userId: "user-b",
      }),
    ).toBe(false);
    expect(database.getCallCount()).toBe(1);
  }
});
