import { expect, test } from "bun:test";

import { decideFeatureAccess } from "@/api/lib/feature-access/policy";
import {
  assertFeaturePrerequisites,
  defineFeatureRegistry,
  featurePrerequisiteClosure,
} from "@/api/lib/feature-access/prerequisites";

const registry = defineFeatureRegistry({
  base: { enrolment: "invitation" },
  middle: { enrolment: "invitation", prerequisites: ["base"] },
  leaf: { enrolment: "invitation", prerequisites: ["base", "middle"] },
});

test("each prerequisite in a feature closure requires its own matching grant", () => {
  const grant = { type: "organization", organizationId: "org_a" } as const;
  for (let mask = 0; mask < 8; mask += 1) {
    const decision = decideFeatureAccess({
      registry,
      featureId: "leaf",
      organizationId: "org_a",
      userId: "user_a",
      user: { email: "member@example.test", emailVerified: true },
      membership: true,
      grants: {
        base: mask % 2 === 1 ? [grant] : [],
        middle: Math.floor(mask / 2) % 2 === 1 ? [grant] : [],
        leaf: mask >= 4 ? [grant] : [],
      },
    });
    expect(decision.status).toBe(mask === 7 ? "enabled" : "hidden");
  }
  expect([...featurePrerequisiteClosure(registry, "leaf")]).toEqual([
    "base",
    "middle",
    "leaf",
  ]);
});

test("registry validation refuses cycles and unknown prerequisite identifiers", () => {
  expect(() =>
    assertFeaturePrerequisites({
      base: { enrolment: "invitation", prerequisites: ["missing"] },
    }),
  ).toThrow("registered feature");
  expect(() =>
    assertFeaturePrerequisites({
      base: { enrolment: "invitation", prerequisites: ["base"] },
    }),
  ).toThrow("acyclic");
  expect(() =>
    assertFeaturePrerequisites({
      base: { enrolment: "invitation", prerequisites: ["leaf"] },
      leaf: { enrolment: "invitation", prerequisites: ["base"] },
    }),
  ).toThrow("acyclic");
});
