import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";
import { compareCodeUnit } from "@stll/collation";

import { shrinkViolations } from "../../../../scripts/baseline-shrink";

const ACCESS_SUBJECTS = [
  "public-law",
  "document",
  "org-auth",
  "matter",
  "other",
] as const;

const AUTHENTICATION_POLICIES = [
  "public",
  "session",
  "organization",
  "token",
] as const;

const EXPECTED_OUTCOMES = ["allow", 401, 403, 404] as const;

export const ACTORS = [
  { actor: "anonymous", type: "anonymous" },
  {
    actor: "foreign-organization",
    type: "foreign-organization",
    organization: "foreign",
    role: "member",
  },
  ...ORGANIZATION_ROLE_NAMES.map((role) => ({
    actor: role,
    type: "owning-organization-role" as const,
    organization: "owning" as const,
    role,
  })),
  {
    actor: "unpaid",
    type: "organization-standing",
    organization: "owning",
    role: "owner",
    standing: "unpaid",
  },
  {
    actor: "expired",
    type: "organization-standing",
    organization: "owning",
    role: "owner",
    standing: "expired",
  },
] as const;

export type AccessMatrixActor = (typeof ACTORS)[number];
export type AccessMatrixActorId = AccessMatrixActor["actor"];
export type AccessSubject = (typeof ACCESS_SUBJECTS)[number];
export type AuthenticationPolicy = (typeof AUTHENTICATION_POLICIES)[number];
export type ExpectedAccessOutcome = (typeof EXPECTED_OUTCOMES)[number];

export type RouteAccessPolicy =
  | { type: "missing"; reason: string }
  | {
      type: "declared";
      authentication: AuthenticationPolicy;
      accountRestriction: string | null;
      source: string;
      permissions: unknown;
      entitlements: readonly string[];
    };

export type RouteAccessMatrix =
  | { type: "missing" }
  | {
      type: "declared";
      actors: readonly {
        actor: string;
        expected: ExpectedAccessOutcome;
      }[];
    };

export type AccessMatrixRoute = {
  id: string;
  subject: AccessSubject;
  publicLawAudience?: "anonymous" | "authenticated";
  policy: RouteAccessPolicy;
  matrix: RouteAccessMatrix;
  denyTests: readonly string[];
};

export type RouteAccessCounts = {
  routes: number;
  subjects: Record<AccessSubject, number>;
  policiesDeclared: number;
  policiesMissing: number;
  matricesDeclared: number;
  matricesMissing: number;
  excludedMatterRoutes: number;
  matrixSize: number;
  denyTests: number;
};

export type RouteAccessCensus = {
  schemaVersion: 1;
  evidence: "fixture-declarations; completed execution is not collected";
  counts: RouteAccessCounts;
  rows: readonly AccessMatrixRoute[];
};

export type AccessMatrixBaseline = {
  schemaVersion: 1;
  entries: Readonly<Record<string, string>>;
};

export type RouteAccessGuardResult = {
  ok: boolean;
  census: RouteAccessCensus;
  hardFindings: readonly string[];
  baselineFindings: readonly string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSubject = (value: unknown): value is AccessSubject =>
  ACCESS_SUBJECTS.some((subject) => subject === value);

const isAuthenticationPolicy = (
  value: unknown,
): value is AuthenticationPolicy =>
  AUTHENTICATION_POLICIES.some((policy) => policy === value);

const isExpectedOutcome = (value: unknown): value is ExpectedAccessOutcome =>
  EXPECTED_OUTCOMES.some((outcome) => outcome === value);

const isMatrixActorId = (value: string): value is AccessMatrixActorId =>
  ACTORS.some(({ actor }) => actor === value);

const canonicalRow = (row: AccessMatrixRoute): AccessMatrixRoute => ({
  ...row,
  ...(row.matrix.type === "declared"
    ? {
        matrix: {
          type: "declared",
          actors: [...row.matrix.actors].toSorted((left, right) =>
            compareCodeUnit(left.actor, right.actor),
          ),
        },
      }
    : {}),
  denyTests: [...row.denyTests].toSorted(),
});

/** Construct stable census rows and summary counts from the route registry. */
export const buildRouteAccessCensus = (
  routes: readonly AccessMatrixRoute[],
): RouteAccessCensus => {
  const rows = routes
    .map(canonicalRow)
    .toSorted((left, right) => compareCodeUnit(left.id, right.id));
  const subjects = {
    "public-law": rows.filter((row) => row.subject === "public-law").length,
    document: rows.filter((row) => row.subject === "document").length,
    "org-auth": rows.filter((row) => row.subject === "org-auth").length,
    matter: rows.filter((row) => row.subject === "matter").length,
    other: rows.filter((row) => row.subject === "other").length,
  } satisfies Record<AccessSubject, number>;
  const policiesDeclared = rows.filter(
    ({ policy }) => policy.type === "declared",
  ).length;
  const matricesDeclared = rows.filter(
    ({ matrix }) => matrix.type === "declared",
  ).length;
  let matrixSize = 0;
  let denyTests = 0;
  for (const row of rows) {
    if (row.subject !== "matter" && row.matrix.type === "declared") {
      matrixSize += row.matrix.actors.length;
    }
    denyTests += row.denyTests.length;
  }

  return {
    schemaVersion: 1,
    evidence: "fixture-declarations; completed execution is not collected",
    counts: {
      routes: rows.length,
      subjects,
      policiesDeclared,
      policiesMissing: rows.length - policiesDeclared,
      matricesDeclared,
      matricesMissing: rows.length - matricesDeclared,
      excludedMatterRoutes: subjects.matter,
      matrixSize,
      denyTests,
    },
    rows,
  };
};

const policyShapeFindings = (route: AccessMatrixRoute): string[] => {
  const findings: string[] = [];
  if (
    !isRecord(route.policy) ||
    !["missing", "declared"].includes(String(route.policy.type))
  ) {
    return ["access policy shape is malformed"];
  }
  if (route.policy.type === "missing") {
    if (route.policy.reason.trim() === "") {
      findings.push("missing-policy reason is empty");
    }
    return findings;
  }
  if (!isAuthenticationPolicy(route.policy.authentication)) {
    findings.push("authentication policy is unknown");
  }
  if (
    route.policy.accountRestriction !== null &&
    (typeof route.policy.accountRestriction !== "string" ||
      route.policy.accountRestriction.trim() === "")
  ) {
    findings.push("account restriction is malformed");
  }
  if (route.policy.source.trim() === "") {
    findings.push("declared-policy source is empty");
  }
  if (
    !Array.isArray(route.policy.entitlements) ||
    route.policy.entitlements.some(
      (entitlement) =>
        typeof entitlement !== "string" || entitlement.trim() === "",
    )
  ) {
    findings.push("policy entitlements are malformed");
  }
  return findings;
};

const matrixShapeFindings = (route: AccessMatrixRoute): string[] => {
  const findings: string[] = [];
  if (
    !isRecord(route.matrix) ||
    !["missing", "declared"].includes(String(route.matrix.type))
  ) {
    return ["matrix shape is malformed"];
  }
  if (route.matrix.type === "missing") {
    return findings;
  }
  if (!Array.isArray(route.matrix.actors)) {
    return ["matrix actors must be an array"];
  }
  const actorIds = route.matrix.actors.map((entry) =>
    isRecord(entry) ? entry.actor : undefined,
  );
  if (
    route.matrix.actors.some(({ expected }) => expected !== "allow") &&
    route.denyTests.length === 0
  ) {
    findings.push("denied matrix cells have no deny-test evidence");
  }
  if (new Set(actorIds).size !== actorIds.length) {
    findings.push("matrix contains a duplicate actor row");
  }
  for (const entry of route.matrix.actors) {
    if (!isRecord(entry) || typeof entry.actor !== "string") {
      findings.push("matrix contains a malformed actor row");
      continue;
    }
    if (!isMatrixActorId(entry.actor)) {
      findings.push(`matrix actor is not declared: ${entry.actor}`);
    }
    if (!isExpectedOutcome(entry.expected)) {
      findings.push(`matrix outcome is invalid for actor ${entry.actor}`);
    }
  }
  const present = new Set(actorIds);
  for (const { actor } of ACTORS) {
    if (!present.has(actor)) {
      findings.push(`matrix actor is missing: ${actor}`);
    }
  }
  return findings;
};

const routeShapeFindings = (route: AccessMatrixRoute): string[] => {
  const findings: string[] = [];
  if (route.id.trim() === "") {
    findings.push("route id is empty");
  }
  if (!isSubject(route.subject)) {
    findings.push("route subject is unknown");
  }
  if (route.subject !== "public-law" && route.publicLawAudience !== undefined) {
    findings.push("non-public-law route declares a public-law audience");
  }
  if (route.denyTests.some((testId) => testId.trim() === "")) {
    findings.push("denyTests contains an empty test id");
  }
  if (new Set(route.denyTests).size !== route.denyTests.length) {
    findings.push("denyTests contains a duplicate test id");
  }
  return [
    ...findings,
    ...policyShapeFindings(route),
    ...matrixShapeFindings(route),
  ].map((finding) => `${route.id}: ${finding}`);
};

const publicLawFindings = (route: AccessMatrixRoute): string[] => {
  if (route.subject !== "public-law") {
    return [];
  }
  const findings =
    route.publicLawAudience === undefined
      ? [`${route.id}: public-law audience is not declared`]
      : [];
  if (route.policy.type !== "declared") {
    return findings;
  }
  if (route.policy.entitlements.length > 0) {
    findings.push(
      `${route.id}: public-law policy declares paid-state entitlements`,
    );
  }
  if (route.publicLawAudience === undefined) {
    return findings;
  }
  const publicAuthentication =
    route.publicLawAudience === "anonymous"
      ? route.policy.authentication === "public"
      : route.policy.authentication !== "public";
  if (!publicAuthentication) {
    findings.push(
      `${route.id}: public-law authentication does not match its declared audience`,
    );
  }
  if (route.matrix.type !== "declared") {
    return findings;
  }

  const expectedAnonymous =
    route.publicLawAudience === "anonymous" ? "allow" : 401;
  for (const row of route.matrix.actors) {
    const expected = row.actor === "anonymous" ? expectedAnonymous : "allow";
    if (row.expected !== expected) {
      findings.push(
        `${route.id}: public-law actor ${row.actor} must expect ${expected}`,
      );
    }
  }
  return findings;
};

const generalPolicyFindings = (route: AccessMatrixRoute): string[] => {
  if (route.subject === "public-law") {
    return [];
  }
  if (route.policy.type !== "declared" || route.matrix.type !== "declared") {
    return [];
  }
  const anonymous = route.matrix.actors.find(
    ({ actor }) => actor === "anonymous",
  );
  if (route.policy.authentication !== "public" && anonymous?.expected !== 401) {
    return [
      `${route.id}: authenticated routes must deny anonymous actors with 401`,
    ];
  }
  if (
    route.policy.authentication === "public" &&
    anonymous?.expected !== "allow"
  ) {
    return [`${route.id}: public routes must allow anonymous actors`];
  }
  return [];
};

/** Missing policy and matrix declarations remain debt only for owned subjects. */
export const routeAccessDebt = (
  rows: readonly AccessMatrixRoute[],
): Readonly<Record<string, string>> => {
  const debt: [string, string][] = [];
  for (const route of rows) {
    if (route.subject === "matter") {
      continue;
    }
    if (route.policy.type === "missing") {
      debt.push([`${route.id}::policy`, route.policy.reason]);
    }
    if (route.matrix.type === "missing") {
      debt.push([
        `${route.id}::matrix`,
        "Route actor matrix has not been declared.",
      ]);
    }
  }
  return Object.fromEntries(debt);
};

const baselineShapeFindings = (baseline: unknown): string[] => {
  if (!isRecord(baseline)) {
    return ["baseline must be an object"];
  }
  if (baseline.schemaVersion !== 1) {
    return ["baseline schemaVersion must be 1"];
  }
  if (!isRecord(baseline.entries)) {
    return ["baseline entries must be an object"];
  }
  const malformed = Object.entries(baseline.entries).flatMap(([id, reason]) =>
    id.trim() === "" || typeof reason !== "string" || reason.trim() === ""
      ? [`baseline entry ${JSON.stringify(id)} has an invalid reason`]
      : [],
  );
  return malformed;
};

/** Validate matrix invariants and compare only legacy declaration debt. */
export const checkRouteAccessMatrix = ({
  routes,
  baseline,
}: {
  routes: readonly AccessMatrixRoute[];
  baseline: unknown;
}): RouteAccessGuardResult => {
  const census = buildRouteAccessCensus(routes);
  const routeIds = routes.map(({ id }) => id);
  const duplicateIds = routeIds.filter(
    (id, index) => routeIds.indexOf(id) !== index,
  );
  const hardFindings = [
    ...new Set(duplicateIds.map((id) => `duplicate route id: ${id}`)),
    ...routes.flatMap((route) =>
      route.subject === "matter"
        ? []
        : [
            ...routeShapeFindings(route),
            ...publicLawFindings(route),
            ...generalPolicyFindings(route),
          ],
    ),
  ];
  const baselineShape = baselineShapeFindings(baseline);
  const baselineFindings = [
    ...baselineShape,
    ...(baselineShape.length === 0
      ? shrinkViolations(
          baseline,
          {
            schemaVersion: 1,
            entries: routeAccessDebt(census.rows),
          },
          ["entries"],
        )
      : []),
  ];
  return {
    ok: hardFindings.length === 0 && baselineFindings.length === 0,
    census,
    hardFindings,
    baselineFindings,
  };
};

/** Compare one HTTP response with the declared cell, using exact deny codes. */
export const compareRouteAccessObservation = ({
  route,
  actor,
  status,
}: {
  route: AccessMatrixRoute;
  actor: string;
  status: number;
}): string[] => {
  if (route.matrix.type === "missing") {
    return [`${route.id}: no matrix declared for observed actor ${actor}`];
  }
  const expected = route.matrix.actors.find((row) => row.actor === actor);
  if (!expected) {
    return [`${route.id}: no matrix row for observed actor ${actor}`];
  }
  const allowed =
    route.subject === "public-law"
      ? status === 200
      : status >= 200 && status < 400;
  if (expected.expected === "allow") {
    return allowed
      ? []
      : [`${route.id}: ${actor} expected allow, received HTTP ${status}`];
  }
  return status === expected.expected
    ? []
    : [
        `${route.id}: ${actor} expected HTTP ${expected.expected}, received HTTP ${status}`,
      ];
};
