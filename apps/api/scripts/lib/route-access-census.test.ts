import { expect, test } from "bun:test";

import { ROUTE_ACCESS_DETAIL } from "../../src/lib/auth/route-access-policy";
import type { ComposedRouteRow } from "./composed-route-registry";
import { inspectRouteAccess } from "./route-access-census";

const inspect = (
  options: Partial<Parameters<typeof inspectRouteAccess>[0]> = {},
) =>
  inspectRouteAccess({
    row: {
      id: "GET /v1/records",
      method: "GET",
      path: "/v1/records",
      handler: () => "fixture",
      hooks: {},
    } satisfies ComposedRouteRow,
    registration: undefined,
    publicHandler: false,
    publicLawRoutes: new Set(),
    tokenLawRoutes: new Set(),
    ...options,
  });

test("absence of a declaration is never treated as public access", () => {
  expect(inspect()).toMatchObject({
    policy: { type: "missing" },
    subject: "other",
  });
});

test.each(["session", "organization"] as const)(
  "surviving %s macro metadata declares the authenticated boundary",
  (authentication) => {
    expect(
      inspect({
        row: {
          id: "GET /v1/records",
          method: "GET",
          path: "/v1/records",
          handler: () => "fixture",
          hooks: {
            detail: { [ROUTE_ACCESS_DETAIL.authentication]: authentication },
          },
        },
      }).policy,
    ).toMatchObject({ type: "declared", authentication });
  },
);

test("safe-handler registration preserves entitlement and account decisions separately", () => {
  const result = inspect({
    publicHandler: true,
    publicLawRoutes: new Set(["GET /v1/records"]),
    registration: {
      accountAccess: "account-control",
      permissions: { workspace: ["read"] },
      featureAccess: { feature: "fixture" },
      requiresUsage: { type: "fixture" },
      actionAdmission: undefined,
    },
  });
  expect(result).toMatchObject({
    subject: "public-law",
    publicLawAudience: "anonymous",
    policy: {
      type: "declared",
      authentication: "public",
      accountRestriction: "account-control",
      entitlements: ["featureAccess", "requiresUsage"],
    },
  });
});

test("canonical token routes retain their authentication even with a public handler context", () => {
  expect(
    inspect({
      publicHandler: true,
      tokenLawRoutes: new Set(["GET /v1/records"]),
    }),
  ).toMatchObject({
    subject: "public-law",
    publicLawAudience: "authenticated",
    policy: { type: "declared", authentication: "token" },
  });
});

test("matter ownership comes from the canonical workspace macro declaration", () => {
  expect(
    inspect({
      row: {
        id: "GET /v1/records",
        method: "GET",
        path: "/v1/records",
        handler: () => "fixture",
        hooks: {
          detail: {
            [ROUTE_ACCESS_DETAIL.authentication]: "organization",
            [ROUTE_ACCESS_DETAIL.matter]: "active",
          },
        },
      },
    }),
  ).toMatchObject({
    subject: "matter",
    policy: { type: "declared", authentication: "organization" },
  });
});
