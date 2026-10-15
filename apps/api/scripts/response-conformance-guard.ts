import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { BASELINE_PATHS } from "../../../scripts/baseline-paths";
import { shrinkViolations } from "../../../scripts/baseline-shrink";

const ROOT = path.resolve(import.meta.dir, "../../..");
const CENSUS = "apps/api/response-conformance-census.json";
const EVIDENCE = "static-invocation-absence";
const nonempty = v.pipe(v.string(), v.minLength(1));
const surfaceSchema = v.object({
  kind: v.picklist(["route", "mcp", "capability"]),
  id: nonempty,
  owner: v.picklist(["stella", "upstream"]),
  httpTests: v.array(nonempty),
  handlerTests: v.array(nonempty),
  toolTests: v.array(nonempty),
  response: v.object({ type: v.picklist(["missing", "declared"]) }),
  schemaExemption: v.optional(v.literal("upstream-text-relay")),
});
const censusSchema = v.object({
  version: v.literal(1),
  surfaces: v.array(surfaceSchema),
});
const baselineSchema = v.strictObject({
  version: v.literal(1),
  evidence: v.literal(EVIDENCE),
  entries: v.pipe(
    v.array(nonempty),
    v.check(
      (entries) => new Set(entries).size === entries.length,
      "Duplicate response conformance debt",
    ),
  ),
});

/** This debt records absent static call evidence, never completed execution. */
export const responseConformanceDebt = (census: unknown) => {
  const { surfaces } = v.parse(censusSchema, census);
  const identities = new Set<string>();
  const entries: string[] = [];
  for (const surface of surfaces) {
    const key = `${surface.kind}:${surface.id}`;
    if (identities.has(key)) {
      panic(`Duplicate response conformance surface: ${key}`);
    }
    identities.add(key);
    const upstreamExemption =
      surface.owner === "upstream" &&
      surface.schemaExemption === "upstream-text-relay";
    if (surface.response.type === "missing" && !upstreamExemption) {
      entries.push(`${key} missing-response-schema`);
    }
    if (
      surface.httpTests.length +
        surface.handlerTests.length +
        surface.toolTests.length ===
      0
    ) {
      entries.push(`${key} missing-static-invocation`);
    }
  }
  return { version: 1, evidence: EVIDENCE, entries: entries.toSorted() };
};

export const compareResponseConformanceDebt = (
  baseline: unknown,
  census: unknown,
) => {
  const before = v.parse(baselineSchema, baseline);
  const current = responseConformanceDebt(census);
  const violations = shrinkViolations(before, current, ["entries"]);
  const remaining = new Set(current.entries);
  const stale = before.entries
    .filter((entry) => !remaining.has(entry))
    .toSorted();
  return { current, violations, stale };
};

export const responseConformanceGuardSelfTest = () => {
  const surface = {
    kind: "route",
    id: "GET /fixture",
    owner: "stella",
    response: { type: "missing" },
    httpTests: [],
    handlerTests: [],
    toolTests: [],
  };
  const census = { version: 1, surfaces: [surface] };
  const baseline = responseConformanceDebt(census);
  if (
    compareResponseConformanceDebt(baseline, census).violations.length !== 0
  ) {
    panic("Response conformance guard rejects unchanged debt");
  }
  const fixed = {
    version: 1,
    surfaces: [
      {
        ...surface,
        response: { type: "declared" },
        httpTests: ["fixture.test.ts"],
      },
    ],
  };
  const shrink = compareResponseConformanceDebt(baseline, fixed);
  if (shrink.violations.length !== 0 || shrink.stale.length !== 2) {
    panic("Response conformance guard missed shrinking debt");
  }
  if (
    compareResponseConformanceDebt(shrink.current, census).violations.length !==
    2
  ) {
    panic("Response conformance guard missed restored debt");
  }
};

const readFreshDebtComparison = (census: unknown) => {
  const committed = readFileSync(path.join(ROOT, CENSUS), "utf-8");
  if (committed !== `${JSON.stringify(census, null, 2)}\n`) {
    panic(
      "Response conformance census is stale; run response-conformance-census.ts --write",
    );
  }
  const baseline: unknown = JSON.parse(
    readFileSync(path.join(ROOT, BASELINE_PATHS.responseConformance), "utf-8"),
  );
  return compareResponseConformanceDebt(baseline, census);
};

export const checkResponseConformanceCensus = (census: unknown) => {
  const result = readFreshDebtComparison(census);
  if (result.violations.length > 0) {
    panic(`Response conformance debt grew:\n${result.violations.join("\n")}`);
  }
  if (result.stale.length > 0) {
    panic(
      `Response conformance debt shrank; prune with response-conformance-guard.ts --write:\n${result.stale.join("\n")}`,
    );
  }
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const mode = args.at(0);
  if (
    args.length !== 1 ||
    (mode !== "--check" && mode !== "--write" && mode !== "--self-test")
  ) {
    panic("Usage: response-conformance-guard.ts --check|--write|--self-test");
  }
  if (mode === "--self-test") {
    responseConformanceGuardSelfTest();
  } else {
    const { generateResponseConformanceCensus } =
      await import("./response-conformance-census");
    const census = await generateResponseConformanceCensus();
    if (mode === "--check") {
      checkResponseConformanceCensus(census);
    } else {
      const result = readFreshDebtComparison(census);
      if (result.violations.length > 0) {
        panic(
          `Response conformance debt grew:\n${result.violations.join("\n")}`,
        );
      }
      writeFileSync(
        path.join(ROOT, BASELINE_PATHS.responseConformance),
        `${JSON.stringify(result.current, null, 2)}\n`,
      );
    }
    // Registry imports own pools and timers; the standalone guard owns no server.
    process.exit(0);
  }
  // Registry imports own pools and timers; this command does not start a server.
  process.exit(0);
}
