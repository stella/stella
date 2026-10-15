import { expect, test } from "bun:test";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";

import {
  ACTORS,
  buildRouteAccessCensus,
  checkRouteAccessMatrix,
  compareRouteAccessObservation,
} from "./route-access-matrix";
import type {
  AccessMatrixRoute,
  AuthenticationPolicy,
  ExpectedAccessOutcome,
} from "./route-access-matrix";

const outcomeFor = (
  actor: string,
  authentication: AuthenticationPolicy,
): ExpectedAccessOutcome =>
  actor === "anonymous" && authentication !== "public" ? 401 : "allow";

const badAnonymousOutcome = (actor: string): ExpectedAccessOutcome =>
  actor === "anonymous" ? 403 : "allow";

const badUnpaidOutcome = (actor: string): ExpectedAccessOutcome => {
  if (actor === "anonymous") {
    return 401;
  }
  return actor === "unpaid" ? 403 : "allow";
};

const deniedForeignOrganizationOutcome = (
  actor: string,
): ExpectedAccessOutcome => (actor === "foreign-organization" ? 404 : "allow");

const declaredMatrix = (
  authentication: AuthenticationPolicy,
): AccessMatrixRoute["matrix"] => ({
  type: "declared",
  actors: ACTORS.map(({ actor }) => ({
    actor,
    expected: outcomeFor(actor, authentication),
  })),
});

const route = ({
  id = "GET /records",
  subject = "org-auth",
  authentication = "organization",
  entitlements = [],
  matrix = declaredMatrix(authentication),
  policySource = "handler config",
  publicLawAudience,
  denyTests = ["records-foreign-org-denied"],
}: {
  id?: string;
  subject?: AccessMatrixRoute["subject"];
  authentication?: AuthenticationPolicy;
  entitlements?: string[];
  matrix?: AccessMatrixRoute["matrix"];
  policySource?: string;
  publicLawAudience?: "anonymous" | "authenticated";
  denyTests?: string[];
} = {}): AccessMatrixRoute => ({
  id,
  subject,
  ...(subject === "public-law"
    ? {
        publicLawAudience:
          publicLawAudience ??
          (authentication === "public" ? "anonymous" : "authenticated"),
      }
    : {}),
  policy: {
    type: "declared",
    authentication,
    accountRestriction: null,
    source: policySource,
    permissions: {},
    entitlements,
  },
  matrix,
  denyTests,
});

const baseline = (entries: Record<string, string> = {}) => ({
  schemaVersion: 1 as const,
  entries,
});

test("actor rows derive owning organization roles from auth-model", () => {
  expect(
    ACTORS.filter(({ type }) => type === "owning-organization-role").map(
      ({ actor }) => actor,
    ),
  ).toEqual(ORGANIZATION_ROLE_NAMES);
  expect(ACTORS.map(({ actor }) => actor)).toEqual([
    "anonymous",
    "foreign-organization",
    ...ORGANIZATION_ROLE_NAMES,
    "unpaid",
    "expired",
  ]);
});

test("census rows and counts are stable and report matter exclusions", () => {
  const publicLaw = route({
    id: "GET /law",
    subject: "public-law",
    authentication: "public",
    denyTests: [],
  });
  const matter = {
    ...route({ id: "GET /workspaces/:workspaceId/entities" }),
    subject: "matter" as const,
    policy: { type: "missing" as const, reason: "owned by matter access" },
    matrix: { type: "missing" as const },
  };
  const census = buildRouteAccessCensus([matter, publicLaw]);

  expect(census.rows.map(({ id }) => id)).toEqual([
    "GET /law",
    "GET /workspaces/:workspaceId/entities",
  ]);
  expect(census.counts).toMatchObject({
    routes: 2,
    policiesDeclared: 1,
    policiesMissing: 1,
    matricesDeclared: 1,
    matricesMissing: 1,
    excludedMatterRoutes: 1,
    matrixSize: ACTORS.length,
    denyTests: 0,
  });
  expect(
    checkRouteAccessMatrix({
      routes: [matter, publicLaw],
      baseline: baseline(),
    }).baselineFindings,
  ).toEqual([]);
});

test("baseline permits shrinking legacy debt but rejects new route debt", () => {
  const existing = {
    id: "GET /legacy",
    subject: "other" as const,
    policy: { type: "missing" as const, reason: "policy not recorded" },
    matrix: { type: "missing" as const },
    denyTests: [],
  };
  const existingBaseline = baseline({
    "GET /legacy::policy": "policy not recorded",
    "GET /legacy::matrix": "Route actor matrix has not been declared.",
  });

  expect(
    checkRouteAccessMatrix({ routes: [], baseline: existingBaseline }).ok,
  ).toBe(true);
  const grown = checkRouteAccessMatrix({
    routes: [
      existing,
      {
        ...existing,
        id: "GET /new",
        policy: { type: "missing", reason: "new unclassified route" },
      },
    ],
    baseline: existingBaseline,
  });
  expect(grown.ok).toBe(false);
  expect(grown.baselineFindings).toContain(
    '$.entries["GET /new::policy"] is not an existing entry',
  );
});

test("declared matrices require every actor exactly once", () => {
  const complete = declaredMatrix("organization");
  if (complete.type !== "declared") {
    throw new Error("Fixture matrix must be declared");
  }
  const firstActor = complete.actors.at(0);
  if (firstActor === undefined) {
    throw new Error("Fixture matrix must contain actors");
  }
  const incomplete = {
    type: "declared" as const,
    actors: complete.actors.filter(({ actor }) => actor !== "intern"),
  };
  const duplicate = {
    type: "declared" as const,
    actors: [...complete.actors, firstActor],
  };

  const missingActor = checkRouteAccessMatrix({
    routes: [route({ matrix: incomplete })],
    baseline: baseline(),
  });
  expect(missingActor.hardFindings).toContain(
    "GET /records: matrix actor is missing: intern",
  );
  expect(missingActor.ok).toBe(false);

  const duplicateActor = checkRouteAccessMatrix({
    routes: [route({ matrix: duplicate })],
    baseline: baseline(),
  });
  expect(duplicateActor.hardFindings).toContain(
    "GET /records: matrix contains a duplicate actor row",
  );
});

test("duplicate route ids and invalid deny fixtures fail hard", () => {
  const duplicateRoute = route();
  const duplicateRoutes = checkRouteAccessMatrix({
    routes: [duplicateRoute, duplicateRoute],
    baseline: baseline(),
  });
  expect(duplicateRoutes.hardFindings).toContain(
    "duplicate route id: GET /records",
  );

  const duplicateDenyTest = checkRouteAccessMatrix({
    routes: [route({ denyTests: ["same-test", "same-test"] })],
    baseline: baseline(),
  });
  expect(duplicateDenyTest.hardFindings).toContain(
    "GET /records: denyTests contains a duplicate test id",
  );
});

test("anonymous access must match the declared authentication boundary", () => {
  const invalid = route({
    matrix: {
      type: "declared",
      actors: ACTORS.map(({ actor }) => ({
        actor,
        expected: badAnonymousOutcome(actor),
      })),
    },
  });
  const result = checkRouteAccessMatrix({
    routes: [invalid],
    baseline: baseline(),
  });

  expect(result.hardFindings).toContain(
    "GET /records: authenticated routes must deny anonymous actors with 401",
  );
});

test("public-law paid-state gates are never baselineable", () => {
  const paidGate = route({
    id: "GET /law",
    subject: "public-law",
    authentication: "public",
    entitlements: ["public-law-read"],
  });
  const result = checkRouteAccessMatrix({
    routes: [paidGate],
    baseline: baseline({ "GET /law::policy": "legacy paid gate" }),
  });

  expect(result.hardFindings).toContain(
    "GET /law: public-law policy declares paid-state entitlements",
  );
  expect(result.baselineFindings).toContain(
    '$.entries["GET /law::policy"] is not an existing entry',
  );
  expect(result.ok).toBe(false);
});

test("account restrictions remain distinct from entitlements", () => {
  const restricted = route({
    id: "GET /law/review",
    subject: "public-law",
    authentication: "public",
  });
  const restrictedPolicy = restricted.policy;
  if (restrictedPolicy.type !== "declared") {
    throw new Error("Fixture route must have a declared policy");
  }
  const result = checkRouteAccessMatrix({
    routes: [
      {
        ...restricted,
        policy: {
          ...restrictedPolicy,
          type: "declared",
          accountRestriction: "review-account",
        },
      },
    ],
    baseline: baseline(),
  });

  expect(result.hardFindings).toEqual([]);

  const malformed = checkRouteAccessMatrix({
    routes: [
      {
        ...restricted,
        policy: {
          ...restrictedPolicy,
          type: "declared",
          accountRestriction: " ",
        },
      },
    ],
    baseline: baseline(),
  });
  expect(malformed.hardFindings).toContain(
    "GET /law/review: account restriction is malformed",
  );
});

test("public-law matrices allow all actors except anonymous auth denial", () => {
  const valid = route({
    id: "GET /law",
    subject: "public-law",
    authentication: "session",
  });
  expect(
    checkRouteAccessMatrix({ routes: [valid], baseline: baseline() })
      .hardFindings,
  ).toEqual([]);

  const invalid = route({
    id: "GET /law",
    subject: "public-law",
    authentication: "session",
    matrix: {
      type: "declared",
      actors: ACTORS.map(({ actor }) => ({
        actor,
        expected: badUnpaidOutcome(actor),
      })),
    },
  });
  expect(
    checkRouteAccessMatrix({ routes: [invalid], baseline: baseline() })
      .hardFindings,
  ).toContain("GET /law: public-law actor unpaid must expect allow");
});

test("canonical public-law audience rejects an accidental auth gate", () => {
  const routeWithAccidentalGate = route({
    id: "GET /law",
    subject: "public-law",
    authentication: "organization",
    publicLawAudience: "anonymous",
  });
  const result = checkRouteAccessMatrix({
    routes: [routeWithAccidentalGate],
    baseline: baseline(),
  });

  expect(result.hardFindings).toContain(
    "GET /law: public-law authentication does not match its declared audience",
  );
  expect(result.hardFindings).toContain(
    "GET /law: public-law actor anonymous must expect allow",
  );
});

test("observations accept 2xx and 3xx allows and exact denial statuses", () => {
  const routeWithDeniedForeignOrg = route({
    matrix: {
      type: "declared",
      actors: ACTORS.map(({ actor }) => ({
        actor,
        expected: deniedForeignOrganizationOutcome(actor),
      })),
    },
  });

  expect(
    compareRouteAccessObservation({
      route: routeWithDeniedForeignOrg,
      actor: "owner",
      status: 302,
    }),
  ).toEqual([]);
  expect(
    compareRouteAccessObservation({
      route: routeWithDeniedForeignOrg,
      actor: "foreign-organization",
      status: 403,
    }),
  ).toEqual([
    "GET /records: foreign-organization expected HTTP 404, received HTTP 403",
  ]);

  const publicLaw = route({
    id: "GET /law",
    subject: "public-law",
    authentication: "public",
    denyTests: [],
  });
  expect(
    compareRouteAccessObservation({
      route: publicLaw,
      actor: "anonymous",
      status: 201,
    }),
  ).toEqual(["GET /law: anonymous expected allow, received HTTP 201"]);
});

test("malformed and duplicate baselines fail closed", () => {
  const malformed = checkRouteAccessMatrix({
    routes: [],
    baseline: { schemaVersion: 2, entries: [] },
  });
  expect(malformed.ok).toBe(false);
  expect(malformed.baselineFindings).toContain(
    "baseline schemaVersion must be 1",
  );

  const badReason = checkRouteAccessMatrix({
    routes: [],
    baseline: baseline({ "GET /legacy::policy": " " }),
  });
  expect(badReason.baselineFindings).toContain(
    'baseline entry "GET /legacy::policy" has an invalid reason',
  );
});
