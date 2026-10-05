import { expect, test } from "bun:test";

import { featureIsEnabled } from "@/queries/feature-access.logic";

test("feature navigation requires the current member's server decision", () => {
  const principal = { organizationId: "organization_a", userId: "member_a" };
  expect(featureIsEnabled(undefined, principal, "legal-lists")).toBe(false);
  for (const organizationId of [principal.organizationId, "organization_b"]) {
    for (const userId of [principal.userId, "member_b"]) {
      for (const enabledFeatures of [
        [],
        ["legal-lists"],
        ["legal-lists", "list-verification"],
      ]) {
        const state = {
          organizationId,
          userId,
          enabledFeatures,
        } satisfies NonNullable<Parameters<typeof featureIsEnabled>[0]>;
        for (const featureId of ["legal-lists", "list-verification"]) {
          expect(featureIsEnabled(state, principal, featureId)).toBe(
            organizationId === principal.organizationId &&
              userId === principal.userId &&
              enabledFeatures.includes(featureId),
          );
        }
      }
    }
  }
});
