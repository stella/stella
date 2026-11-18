import { expect, test } from "bun:test";

import { RUNTIME_MODE } from "@stll/runtime-mode";
import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { isOrganizationFeatureEnabled } from "@/api/lib/feature-access/organization";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";

const state = createTestState({ file: import.meta.path, config: env });

for (const deployed of [false, true]) {
  for (const granted of [false, true]) {
    test(`invoice links require deployment and their own organization grant: ${deployed}/${granted}`, () => {
      state.setConfig("FEATURE_TIME_BILLING", true);
      state.setConfig("FEATURE_INVOICE_LINKS", deployed);
      state.setConfig("API_FEATURE_ACCESS_GRANTS", {
        "invoice-links": granted
          ? [{ type: "organization", organizationId: "org-a" }]
          : [],
      });
      for (const organizationId of ["org-a", "org-b"]) {
        const expected = deployed && granted && organizationId === "org-a";
        expect(
          isOrganizationFeatureEnabled({
            featureId: "invoice-links",
            organizationId,
          }),
        ).toBe(expected);
        const snapshot = buildFeatureAccessSnapshot({
          organizationId,
          userId: "user-a",
          identity: { email: "user@example.test", emailVerified: true },
          enrolments: [
            { organizationId, userId: "user-a", featureId: "time-billing" },
          ],
        });
        expect(snapshot.decisions.get("invoice-links")?.status).toBe(
          expected ? "enabled" : "hidden",
        );
      }
    });
  }
}

test("member invitations cannot confer organization invoice link authority", () => {
  state.setConfig("FEATURE_TIME_BILLING", true);
  state.setConfig("FEATURE_INVOICE_LINKS", true);
  state.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "invoice-links": [
      { type: "member", organizationId: "org-a", email: "user@example.test" },
    ],
  });
  expect(
    isOrganizationFeatureEnabled({
      featureId: "invoice-links",
      organizationId: "org-a",
    }),
  ).toBe(false);
  expect(
    buildFeatureAccessSnapshot({
      organizationId: "org-a",
      userId: "user-a",
      identity: { email: "user@example.test", emailVerified: true },
      enrolments: [
        {
          organizationId: "org-a",
          userId: "user-a",
          featureId: "time-billing",
        },
      ],
    }).decisions.get("invoice-links")?.status,
  ).toBe("hidden");
});

test("billing deployment prerequisites and removal withdraw organization authority", () => {
  state.setConfig("FEATURE_TIME_BILLING", true);
  state.setConfig("FEATURE_INVOICE_LINKS", true);
  state.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "invoice-links": [{ type: "organization", organizationId: "org-a" }],
  });
  expect(
    isOrganizationFeatureEnabled({
      featureId: "invoice-links",
      organizationId: "org-a",
    }),
  ).toBe(true);
  const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
  try {
    state.setConfig("FEATURE_TIME_BILLING", false);
    expect(
      isOrganizationFeatureEnabled({
        featureId: "invoice-links",
        organizationId: "org-a",
      }),
    ).toBe(false);
    state.setConfig("FEATURE_TIME_BILLING", true);
    state.setConfig("API_FEATURE_ACCESS_GRANTS", {});
    expect(
      isOrganizationFeatureEnabled({
        featureId: "invoice-links",
        organizationId: "org-a",
      }),
    ).toBe(false);
  } finally {
    restoreMode();
  }
});
