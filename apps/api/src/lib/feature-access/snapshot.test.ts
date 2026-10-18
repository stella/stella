import { expect, test } from "bun:test";

import type { FeatureRegistry } from "@/api/lib/feature-access/registry";
import {
  buildFeatureAccessSnapshot,
  featureAccessReadPlan,
} from "@/api/lib/feature-access/snapshot";

const registry = {
  general: { enrolment: "general-availability" },
  invitation: { enrolment: "invitation" },
  enrolled: { enrolment: "self-serve" },
  dependent: {
    enrolment: "general-availability",
    prerequisites: ["invitation"],
  },
} as const satisfies FeatureRegistry;

test("general availability reads identity without requiring grants or an enrolment source", () => {
  for (const enrolmentSource of ["database", "none"] as const) {
    expect(
      featureAccessReadPlan({
        organizationId: "org-a",
        registry,
        grants: {},
        enrolmentSource,
      }),
    ).toEqual({
      candidates:
        enrolmentSource === "database" ? ["general", "enrolled"] : ["general"],
      enrolmentFeatureIds: enrolmentSource === "database" ? ["enrolled"] : [],
    });
  }
});

test("general availability snapshots retain membership and prerequisite requirements", () => {
  for (const identity of [
    null,
    { email: "member@example.test", emailVerified: true },
  ]) {
    const snapshot = buildFeatureAccessSnapshot({
      organizationId: "org-a",
      userId: "user-a",
      identity,
      enrolments: [],
      registry,
      grants: {},
    });
    expect(snapshot.decisions.get("general")?.status).toBe(
      identity === null ? "hidden" : "enabled",
    );
    expect(snapshot.decisions.get("dependent")?.status).toBe("hidden");
  }
});
