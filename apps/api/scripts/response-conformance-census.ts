import { panic } from "better-result";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import { createRouteRegistryMatcher } from "../src/lib/route-registry-matcher";
import { collectConformanceTestEvidence } from "./lib/conformance-test-evidence";
import { discoverSafeHandlers, REPO_ROOT } from "./lib/enumerate-safe-handlers";
import {
  buildResponseConformanceCensus,
  isConformanceRecord,
  responseConformanceCensusMatches,
} from "./lib/response-conformance-census";

export const RESPONSE_CONFORMANCE_CENSUS =
  "apps/api/response-conformance-census.json";

export const generateResponseConformanceCensus = async () => {
  await import("../src/tests/setup-env");
  const { default: api } = await import("../src/server");
  const { collectMcpConformanceRows } =
    await import("./lib/conformance-mcp-census");
  const discovery = await discoverSafeHandlers();
  if (discovery.importErrors.length !== 0) {
    panic(
      `Response census could not load: ${discovery.importErrors.map(({ id }) => id).join(", ")}`,
    );
  }
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
  const endpointByHandler = new Map(
    discovery.endpoints.map((endpoint) => [endpoint.handler, endpoint.id]),
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
  const routes = api.routes.map((route) => {
    const id = `${route.method} ${route.path}`;
    const hooks: unknown = route.hooks;
    const endpoint = endpointByHandler.get(route.handler);
    return {
      kind: "route" as const,
      id,
      owner: "stella" as const,
      schema: isConformanceRecord(hooks) ? hooks["response"] : undefined,
      schemaSource: `${id}#hooks.response`,
      ...(endpoint === undefined ? {} : { handlerEndpoint: endpoint }),
      httpTests: [...(httpTests.get(id) ?? [])].toSorted(),
      handlerTests:
        endpoint === undefined ? [] : (handlerTests.get(endpoint) ?? []),
      toolTests: [],
    };
  });
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
