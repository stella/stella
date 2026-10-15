import { panic } from "better-result";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import { createRouteRegistryMatcher } from "../src/lib/route-registry-matcher";
import { loadComposedRouteRegistry } from "./lib/composed-route-registry";
import { collectConformanceTestEvidence } from "./lib/conformance-test-evidence";
import { REPO_ROOT } from "./lib/enumerate-safe-handlers";
import {
  buildResponseConformanceCensus,
  isConformanceRecord,
  responseConformanceCensusMatches,
} from "./lib/response-conformance-census";

export const RESPONSE_CONFORMANCE_CENSUS =
  "apps/api/response-conformance-census.json";

export const generateResponseConformanceCensus = async () => {
  const { api, discovery, rows } = await loadComposedRouteRegistry();
  const { collectMcpConformanceRows } =
    await import("./lib/conformance-mcp-census");
  const tests = execFileSync("git", ["ls-files", "-z", "--", "apps/api"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  })
    .split("\0")
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => ({
      file,
      source: readFileSync(path.join(REPO_ROOT, file), "utf-8"),
    }));
  tests.sort((left, right) => compareCodeUnit(left.file, right.file));
  const evidence = collectConformanceTestEvidence(tests);
  const handlerTests = new Map(
    evidence.handlerCalls.map(({ endpoint, tests: files }) => [
      endpoint,
      files,
    ]),
  );
  const match = createRouteRegistryMatcher({
    routes: api.routes,
    staticRoutes: api.router.static,
    strictPath: api.config.strictPath,
    aot: api.config.aot,
  });
  const httpTests = new Map<string, Set<string>>();
  for (const call of evidence.httpCalls) {
    if (call.source !== "composed-api") {
      continue;
    }
    const route = match(
      new Request(`http://conformance.test${call.path}`, {
        method: call.method,
      }),
    );
    if (route === undefined) {
      continue;
    }
    const key = `${route.method} ${route.path}`;
    const files = httpTests.get(key) ?? new Set<string>();
    for (const file of call.tests) {
      files.add(file);
    }
    httpTests.set(key, files);
  }
  const routes = rows.map(({ id, hooks, handlerEndpoint }) => ({
    kind: "route" as const,
    id,
    owner: "stella" as const,
    schema: isConformanceRecord(hooks) ? hooks["response"] : undefined,
    schemaSource: `${id}#hooks.response`,
    ...(handlerEndpoint === undefined ? {} : { handlerEndpoint }),
    httpTests: [...(httpTests.get(id) ?? [])].toSorted(),
    handlerTests:
      handlerEndpoint === undefined
        ? []
        : (handlerTests.get(handlerEndpoint) ?? []),
    toolTests: [],
  }));
  const tools = collectMcpConformanceRows(discovery.endpoints).map((row) => ({
    ...row,
    httpTests: [],
    handlerTests:
      row.handlerEndpoint === undefined
        ? []
        : (handlerTests.get(row.handlerEndpoint) ?? []),
    toolTests: evidence.mcpCalls
      .filter((call) => call.mode === row.mode && call.name === row.name)
      .flatMap((call) => call.tests),
  }));
  const { loadCapabilityCatalog } = await import("../src/mcp/capability-tools");
  const registryIds = new Set(
    (await loadCapabilityCatalog()).map(({ id }) => id),
  );
  const discoveredIds = new Set(
    tools.filter(({ kind }) => kind === "capability").map(({ id }) => id),
  );
  if (
    registryIds.size !== discoveredIds.size ||
    [...registryIds].some((id) => !discoveredIds.has(id))
  ) {
    panic(
      "Response census differs from the capability registry; regenerate the canonical capability catalog and runtime",
    );
  }
  return buildResponseConformanceCensus(
    [...routes, ...tools],
    evidence.unresolvedCalls,
  );
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || (args[0] !== "--write" && args[0] !== "--check")) {
    panic("Usage: response-conformance-census.ts --write|--check");
  }
  const census = await generateResponseConformanceCensus();
  const serialized = `${JSON.stringify(census, null, 2)}\n`;
  const target = path.join(REPO_ROOT, RESPONSE_CONFORMANCE_CENSUS);
  if (args[0] === "--write") {
    writeFileSync(target, serialized);
  } else if (
    !existsSync(target) ||
    !responseConformanceCensusMatches(
      JSON.parse(readFileSync(target, "utf-8")),
      census,
    )
  ) {
    panic("Response conformance census is stale; run its --write command");
  }
  console.log(JSON.stringify(census.counts));
  // Registry imports own pools and timers; this producer has no server lifecycle.
  process.exit(0);
}
