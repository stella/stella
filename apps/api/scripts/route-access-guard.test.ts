import { expect, test } from "bun:test";
import * as v from "valibot";

import {
  buildRouteAccessCensus,
  routeAccessDebt,
} from "./lib/route-access-matrix";
import type { AccessMatrixRoute } from "./lib/route-access-matrix";
import {
  compareRouteAccessGuard,
  routeAccessGuardSelfTest,
} from "./route-access-guard";

const missingDeclarations: AccessMatrixRoute = {
  id: "GET /legacy",
  subject: "other",
  policy: { type: "missing", reason: "No access declaration is registered." },
  matrix: { type: "missing" },
  denyTests: [],
};

const baseline = (entries: Readonly<Record<string, string>> = {}) => ({
  schemaVersion: 1,
  entries,
});

test("access declaration debt can only shrink", () => {
  const census = buildRouteAccessCensus([missingDeclarations]);
  const unseeded = compareRouteAccessGuard({ census, baseline: baseline() });
  expect(unseeded.debt.hardFindings).toEqual([]);
  expect(unseeded.debt.baselineFindings).toEqual([
    '$.entries["GET /legacy::policy"] is not an existing entry',
    '$.entries["GET /legacy::matrix"] is not an existing entry',
  ]);

  const seeded = compareRouteAccessGuard({
    census,
    baseline: baseline(routeAccessDebt(census.rows)),
  });
  expect(seeded.debt.ok).toBe(true);
  const shrunk = compareRouteAccessGuard({
    census: buildRouteAccessCensus([]),
    baseline: baseline(routeAccessDebt(census.rows)),
  });
  expect(shrunk.debt.baselineFindings).toEqual([]);
  expect(shrunk.stale).toEqual(["GET /legacy::matrix", "GET /legacy::policy"]);
});

test("a new route and matching baseline growth fail against the base", () => {
  const census = buildRouteAccessCensus([missingDeclarations]);
  const currentBaseline = baseline(routeAccessDebt(census.rows));
  const result = compareRouteAccessGuard({
    census,
    baseline: currentBaseline,
    baseBaseline: baseline(),
  });

  expect(result.debt.baselineFindings).toEqual([]);
  expect(result.baseFindings).toEqual([
    '$.entries["GET /legacy::policy"] is not an existing entry',
    '$.entries["GET /legacy::matrix"] is not an existing entry',
  ]);
});

test("malformed baselines fail strict parsing", () => {
  expect(() =>
    compareRouteAccessGuard({
      census: buildRouteAccessCensus([]),
      baseline: {
        schemaVersion: 1,
        entries: { "GET /legacy::policy": " " },
      },
    }),
  ).toThrow(v.ValiError);
  expect(() =>
    compareRouteAccessGuard({
      census: buildRouteAccessCensus([]),
      baseline: {
        schemaVersion: 1,
        entries: {},
        ignored: true,
      },
    }),
  ).toThrow(v.ValiError);
});

test("hard policy findings cannot be hidden by seeded debt", () => {
  const invalidPublicLaw: AccessMatrixRoute = {
    id: "GET /law/fixture",
    subject: "public-law",
    publicLawAudience: "anonymous",
    policy: {
      type: "declared",
      authentication: "public",
      accountRestriction: null,
      source: "fixture policy",
      permissions: null,
      entitlements: ["paid-law-read"],
    },
    matrix: { type: "missing" },
    denyTests: [],
  };
  const census = buildRouteAccessCensus([invalidPublicLaw]);
  const seeded = baseline(routeAccessDebt(census.rows));
  const result = compareRouteAccessGuard({ census, baseline: seeded });

  expect(result.debt.hardFindings).toContain(
    "GET /law/fixture: public-law policy declares paid-state entitlements",
  );
  expect(result.debt.ok).toBe(false);
});

test("self-test detects wrong status and a paid public-law gate", () => {
  routeAccessGuardSelfTest();
});
