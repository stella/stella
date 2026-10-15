import { panic } from "better-result";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { ROUTE_ACCESS_FIXTURES } from "../src/tests/security/route-access-fixtures";
import { loadComposedRouteRegistry } from "./lib/composed-route-registry";
import { REPO_ROOT } from "./lib/enumerate-safe-handlers";
import { responseConformanceCensusMatches } from "./lib/response-conformance-census";
import { inspectRouteAccess } from "./lib/route-access-census";
import { buildRouteAccessCensus } from "./lib/route-access-matrix";

const CENSUS_PATH = "apps/api/route-access-census.json";

export const generateRouteAccessCensus = async () => {
  const { rows } = await loadComposedRouteRegistry();
  const { getSafeHandlerAccessPolicy, isSafePublicHandler } =
    await import("../src/lib/api-handlers");
  const { PUBLIC_CORPUS_ROUTE_POLICY } =
    await import("../src/public-corpus-policy");
  const { LEGAL_RESOLVE_RESOURCE_ROUTES } =
    await import("../src/mcp/resource-policy-contract");
  const publicLawRoutes = new Set(
    Object.keys(PUBLIC_CORPUS_ROUTE_POLICY).map((id) => {
      const separator = id.indexOf(" ");
      return `${id.slice(0, separator)} ${STELLA_API_VERSION_PREFIX}${id.slice(separator + 1)}`;
    }),
  );
  const tokenLawRoutes = new Set(
    Object.values(LEGAL_RESOLVE_RESOURCE_ROUTES).map(
      ({ path: routePath }) => `GET ${STELLA_API_VERSION_PREFIX}${routePath}`,
    ),
  );
  const fixtures = new Map(
    ROUTE_ACCESS_FIXTURES.map((fixture) => [fixture.id, fixture]),
  );
  if (fixtures.size !== ROUTE_ACCESS_FIXTURES.length) {
    panic("Route access fixtures contain a duplicate route identity.");
  }
  const mounted = new Set(rows.map(({ id }) => id));
  for (const id of fixtures.keys()) {
    if (!mounted.has(id)) {
      panic(`Route access fixture is not mounted: ${id}`);
    }
  }
  for (const id of [...publicLawRoutes, ...tokenLawRoutes]) {
    if (!mounted.has(id)) {
      panic(`Declared public-law route is not mounted: ${id}`);
    }
  }
  return buildRouteAccessCensus(
    rows.map((row) => {
      const access = inspectRouteAccess({
        row,
        registration: getSafeHandlerAccessPolicy(row.handler),
        publicHandler: isSafePublicHandler(row.handler),
        publicLawRoutes,
        tokenLawRoutes,
      });
      const fixture = fixtures.get(row.id);
      if (fixture !== undefined && fixture.subject !== access.subject) {
        panic(
          `Route access fixture subject differs from its declaration: ${row.id}`,
        );
      }
      return {
        id: row.id,
        ...access,
        matrix:
          fixture === undefined
            ? { type: "missing" as const }
            : { type: "declared" as const, actors: fixture.cells },
        denyTests: fixture?.cells.some(({ expected }) => expected !== "allow")
          ? [fixture.testPath]
          : [],
      };
    }),
  );
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const mode = args.at(0);
  if (args.length !== 1 || (mode !== "--write" && mode !== "--check")) {
    panic("Usage: route-access-census.ts --write|--check");
  }
  const census = await generateRouteAccessCensus();
  const target = path.join(REPO_ROOT, CENSUS_PATH);
  if (mode === "--write") {
    writeFileSync(target, `${JSON.stringify(census, null, 2)}\n`);
  } else if (
    !existsSync(target) ||
    !responseConformanceCensusMatches(
      JSON.parse(readFileSync(target, "utf-8")),
      census,
    )
  ) {
    panic("Route access census is stale; run its --write command.");
  }
  console.log(JSON.stringify(census.counts));
  process.exit(0);
}
