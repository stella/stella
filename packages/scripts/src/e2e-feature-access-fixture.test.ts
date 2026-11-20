import { expect, test } from "bun:test";
import * as v from "valibot";

import {
  e2eFeatureAccessFixtureSchema,
  routeSmokeScaleEmail,
} from "./e2e-feature-access-fixture";

const smallOrganizationId = "018e5000-0000-7000-8000-000000000001";
const largeOrganizationId = "018e5000-0000-7000-8000-000000000002";
const fixture = {
  organizationId: "lists-organization",
  email: "lists@example.test",
  grants: {
    "legal-lists": [
      { type: "organization", organizationId: "lists-organization" },
      { type: "organization", organizationId: smallOrganizationId },
      { type: "organization", organizationId: largeOrganizationId },
    ],
  },
  routeSmokeScale: {
    small: {
      organizationId: smallOrganizationId,
      email: routeSmokeScaleEmail("small", smallOrganizationId),
    },
    large: {
      organizationId: largeOrganizationId,
      email: routeSmokeScaleEmail("large", largeOrganizationId),
    },
  },
} as const;

test("the private fixture binds both scale owners to exact prestart grants", () => {
  expect(v.safeParse(e2eFeatureAccessFixtureSchema, fixture).success).toBe(
    true,
  );
  expect(
    v.safeParse(e2eFeatureAccessFixtureSchema, {
      ...fixture,
      grants: { "legal-lists": fixture.grants["legal-lists"].slice(0, 2) },
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(e2eFeatureAccessFixtureSchema, {
      ...fixture,
      routeSmokeScale: {
        ...fixture.routeSmokeScale,
        large: {
          ...fixture.routeSmokeScale.large,
          email: "other@example.test",
        },
      },
    }).success,
  ).toBe(false);
});
