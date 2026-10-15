import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

import { BASELINE_PATHS } from "../../../scripts/baseline-paths";
import { shrinkViolations } from "../../../scripts/baseline-shrink";
import { responseConformanceCensusMatches } from "./lib/response-conformance-census";
import {
  ACTORS,
  buildRouteAccessCensus,
  checkRouteAccessMatrix,
  compareRouteAccessObservation,
  routeAccessDebt,
} from "./lib/route-access-matrix";

const ROOT = path.resolve(import.meta.dir, "../../..");
const CENSUS_PATH = "apps/api/route-access-census.json";
const nonempty = v.pipe(v.string(), v.minLength(1));
const nonblank = v.pipe(
  nonempty,
  v.check((value) => value.trim() !== "", "Expected a nonblank string"),
);
const subjectSchema = v.picklist([
  "public-law",
  "document",
  "org-auth",
  "matter",
  "other",
]);
const expectedSchema = v.picklist(["allow", 401, 403, 404]);
const authenticationSchema = v.picklist([
  "public",
  "session",
  "organization",
  "token",
]);
const policySchema = v.variant("type", [
  v.strictObject({ type: v.literal("missing"), reason: nonempty }),
  v.strictObject({
    type: v.literal("declared"),
    authentication: authenticationSchema,
    accountRestriction: v.nullable(nonempty),
    source: nonempty,
    permissions: v.unknown(),
    entitlements: v.array(nonempty),
  }),
]);
const matrixSchema = v.variant("type", [
  v.strictObject({ type: v.literal("missing") }),
  v.strictObject({
    type: v.literal("declared"),
    actors: v.array(
      v.strictObject({ actor: nonempty, expected: expectedSchema }),
    ),
  }),
]);
const routeSchema = v.strictObject({
  id: nonempty,
  subject: subjectSchema,
  publicLawAudience: v.optional(v.picklist(["anonymous", "authenticated"])),
  policy: policySchema,
  matrix: matrixSchema,
  denyTests: v.array(nonempty),
});
const censusSchema = v.strictObject({
  schemaVersion: v.literal(1),
  evidence: v.literal(
    "fixture-declarations; completed execution is not collected",
  ),
  counts: v.strictObject({
    routes: v.pipe(v.number(), v.integer(), v.minValue(0)),
    subjects: v.strictObject({
      "public-law": v.pipe(v.number(), v.integer(), v.minValue(0)),
      document: v.pipe(v.number(), v.integer(), v.minValue(0)),
      "org-auth": v.pipe(v.number(), v.integer(), v.minValue(0)),
      matter: v.pipe(v.number(), v.integer(), v.minValue(0)),
      other: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
    policiesDeclared: v.pipe(v.number(), v.integer(), v.minValue(0)),
    policiesMissing: v.pipe(v.number(), v.integer(), v.minValue(0)),
    matricesDeclared: v.pipe(v.number(), v.integer(), v.minValue(0)),
    matricesMissing: v.pipe(v.number(), v.integer(), v.minValue(0)),
    excludedMatterRoutes: v.pipe(v.number(), v.integer(), v.minValue(0)),
    matrixSize: v.pipe(v.number(), v.integer(), v.minValue(0)),
    denyTests: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
  rows: v.array(routeSchema),
});
const baselineSchema = v.strictObject({
  schemaVersion: v.literal(1),
  entries: v.record(v.string(), nonblank),
});

type ParsedCensus = v.InferOutput<typeof censusSchema>;
type ParsedBaseline = v.InferOutput<typeof baselineSchema>;

const parseJson = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(ROOT, file), "utf-8"));

const parseCensus = (value: unknown): ParsedCensus => {
  const census = v.parse(censusSchema, value);
  if (
    !responseConformanceCensusMatches(
      buildRouteAccessCensus(census.rows),
      census,
    )
  ) {
    panic("Route access census counts or ordering do not match its rows");
  }
  return census;
};

const parseBaseline = (baseline: unknown): ParsedBaseline =>
  v.parse(baselineSchema, baseline);

const git = (args: readonly string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  if (result.exitCode !== 0) {
    panic(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
};

const resolveBaseRevision = (override?: string) => {
  const requested = override ?? process.env["BASE_SHA"];
  const args = requested
    ? ["rev-parse", "--verify", "--end-of-options", `${requested}^{commit}`]
    : ["merge-base", "HEAD", "origin/main"];
  return git(args).trim();
};

const readBaseBaseline = (revision: string): ParsedBaseline | null => {
  const pathAtBase = git([
    "ls-tree",
    "--name-only",
    revision,
    "--",
    BASELINE_PATHS.routeAccess,
  ]).trim();
  if (pathAtBase === "") {
    return null;
  }
  const content = git(["show", `${revision}:${BASELINE_PATHS.routeAccess}`]);
  return parseBaseline(JSON.parse(content));
};

type CompareRouteAccessGuardOptions = {
  census: unknown;
  baseline: unknown;
  baseBaseline?: unknown | null;
};

export const compareRouteAccessGuard = ({
  census,
  baseline,
  baseBaseline,
}: CompareRouteAccessGuardOptions) => {
  const parsedCensus = parseCensus(census);
  const parsedBaseline = parseBaseline(baseline);
  const parsedBase =
    baseBaseline === undefined || baseBaseline === null
      ? null
      : parseBaseline(baseBaseline);
  const matrix = checkRouteAccessMatrix({
    routes: parsedCensus.rows,
    baseline: parsedBaseline,
  });
  const currentEntries = routeAccessDebt(parsedCensus.rows);
  const stale = Object.keys(parsedBaseline.entries)
    .filter((entry) => !(entry in currentEntries))
    .toSorted(compareCodeUnit);
  const baseFindings =
    parsedBase === null
      ? []
      : shrinkViolations(parsedBase, parsedBaseline, ["entries"]);
  return {
    census: parsedCensus,
    debt: matrix,
    stale,
    baseFindings,
  };
};

const readFreshComparison = (census: unknown, baseOverride?: string) => {
  const parsedCensus = parseCensus(census);
  const committedCensus = parseCensus(parseJson(CENSUS_PATH));
  if (!responseConformanceCensusMatches(committedCensus, parsedCensus)) {
    panic("Route access census is stale; run route-access-census.ts --write");
  }
  const baseline = parseBaseline(parseJson(BASELINE_PATHS.routeAccess));
  const baseRevision = resolveBaseRevision(baseOverride);
  return compareRouteAccessGuard({
    census: parsedCensus,
    baseline,
    baseBaseline: readBaseBaseline(baseRevision),
  });
};

export const checkRouteAccessCensus = (
  census: unknown,
  baseRevision?: string,
) => {
  const { debt, stale, baseFindings } = readFreshComparison(
    census,
    baseRevision,
  );
  if (debt.hardFindings.length > 0) {
    panic(
      `Route access matrix has invalid declarations:\n${debt.hardFindings.join("\n")}`,
    );
  }
  if (debt.baselineFindings.length > 0) {
    panic(`Route access debt grew:\n${debt.baselineFindings.join("\n")}`);
  }
  if (baseFindings.length > 0) {
    panic(
      `Route access baseline grew from its base revision:\n${baseFindings.join("\n")}`,
    );
  }
  if (stale.length > 0) {
    panic(
      `Route access debt shrank; prune with route-access-guard.ts --write:\n${stale.join("\n")}`,
    );
  }
};

export const routeAccessGuardSelfTest = () => {
  const rows = [
    {
      id: "GET /law/fixture",
      subject: "public-law" as const,
      publicLawAudience: "anonymous" as const,
      policy: {
        type: "declared" as const,
        authentication: "public" as const,
        accountRestriction: null,
        source: "public-law-policy",
        permissions: null,
        entitlements: [],
      },
      matrix: {
        type: "declared" as const,
        actors: ACTORS.map(({ actor }) => ({
          actor,
          expected: "allow" as const,
        })),
      },
      denyTests: [],
    },
  ];
  const fixtureRoute = rows.at(0);
  if (fixtureRoute === undefined) {
    panic("Route access self-test fixture is missing");
  }
  const census = buildRouteAccessCensus(rows);
  const emptyBaseline = { schemaVersion: 1, entries: {} };
  const valid = compareRouteAccessGuard({
    census,
    baseline: emptyBaseline,
  });
  if (!valid.debt.ok) {
    panic("Route access guard rejected a complete public-law matrix");
  }
  const paidGate = buildRouteAccessCensus([
    {
      ...fixtureRoute,
      policy: { ...fixtureRoute.policy, entitlements: ["paid-law-read"] },
      matrix: { type: "missing" },
    },
  ]);
  const seededPaidGateDebt = {
    schemaVersion: 1,
    entries: routeAccessDebt(paidGate.rows),
  };
  const paidResult = compareRouteAccessGuard({
    census: paidGate,
    baseline: seededPaidGateDebt,
  });
  if (
    !paidResult.debt.hardFindings.includes(
      "GET /law/fixture: public-law policy declares paid-state entitlements",
    )
  ) {
    panic("Route access guard let a paid public-law gate pass");
  }
  const observation = compareRouteAccessObservation({
    route: fixtureRoute,
    actor: "anonymous",
    status: 403,
  });
  if (observation.length !== 1) {
    panic("Route access guard accepted a wrong fixture status");
  }
  const debtBaseline = {
    schemaVersion: 1,
    entries: {
      "GET /legacy::policy":
        "No access declaration is registered for this route.",
    },
  };
  const staleFirst = compareRouteAccessGuard({
    census,
    baseline: debtBaseline,
  }).stale.at(0);
  if (staleFirst !== "GET /legacy::policy") {
    panic("Route access guard missed stale baseline debt");
  }
  const newDebtBaseline = {
    schemaVersion: 1,
    entries: {
      "GET /new::policy": "No access declaration is registered for this route.",
      "GET /new::matrix": "Route actor matrix has not been declared.",
    },
  };
  const olderBaseline = { schemaVersion: 1, entries: {} };
  const expanded = compareRouteAccessGuard({
    census: buildRouteAccessCensus([
      {
        id: "GET /new",
        subject: "other",
        policy: {
          type: "missing",
          reason: "No access declaration is registered for this route.",
        },
        matrix: { type: "missing" },
        denyTests: [],
      },
    ]),
    baseline: newDebtBaseline,
    baseBaseline: olderBaseline,
  });
  if (
    expanded.debt.baselineFindings.length > 0 ||
    expanded.baseFindings.length !== 2
  ) {
    panic("Route access guard missed debt hidden by a grown baseline");
  }
};

const run = async (args: readonly string[]) => {
  const [mode = "--check", ...rest] = args;
  const baseIndex = rest.indexOf("--base");
  if (
    !["--check", "--write", "--self-test"].includes(mode) ||
    (mode === "--self-test" && rest.length > 0) ||
    (baseIndex !== -1 &&
      (baseIndex !== 0 || rest.length !== 2 || rest[1]?.trim() === "")) ||
    (baseIndex === -1 && rest.length > 0)
  ) {
    panic(
      "Usage: route-access-guard.ts [--check|--write|--self-test] [--base <rev>]",
    );
  }
  if (mode === "--self-test") {
    routeAccessGuardSelfTest();
    return;
  }
  const { generateRouteAccessCensus } = await import("./route-access-census");
  const census = await generateRouteAccessCensus();
  const requestedBase = baseIndex === -1 ? undefined : rest.at(1);
  const { debt, stale, baseFindings } = readFreshComparison(
    census,
    requestedBase,
  );
  if (debt.hardFindings.length > 0) {
    panic(
      `Route access matrix has invalid declarations:\n${debt.hardFindings.join("\n")}`,
    );
  }
  if (baseFindings.length > 0) {
    panic(
      `Route access baseline grew from its base revision:\n${baseFindings.join("\n")}`,
    );
  }
  if (debt.baselineFindings.length > 0) {
    panic(`Route access debt grew:\n${debt.baselineFindings.join("\n")}`);
  }
  if (mode === "--write") {
    writeFileSync(
      path.join(ROOT, BASELINE_PATHS.routeAccess),
      `${JSON.stringify(routeAccessBaseline(debt.census.rows), null, 2)}\n`,
    );
    return;
  }
  if (stale.length > 0) {
    panic(
      `Route access debt shrank; prune with route-access-guard.ts --write:\n${stale.join("\n")}`,
    );
  }
};

const routeAccessBaseline = (rows: ParsedCensus["rows"]) => ({
  schemaVersion: 1 as const,
  entries: routeAccessDebt(rows),
});

if (import.meta.main) {
  await run(process.argv.slice(2));
  process.exit(0);
}
