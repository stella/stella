import { PUBLIC_VISITOR_ROUTE_DEFS } from "./public-visitor-route-defs";
import { INTENTIONALLY_NOT_SMOKED, SMOKE_ROUTE_DEFS } from "./smoke-route-defs";

export const networkBaselineKey = (def: {
  template: string;
  expectation?: { kind: string };
}): string => {
  switch (def.expectation?.kind) {
    case "redirectsTo":
      return `${def.template} target`;
    case undefined:
    case "rendersInPlace":
    case "settles":
      return def.template;
    default:
      throw new Error(
        `Unknown smoke route expectation: ${String(def.expectation?.kind)}`,
      );
  }
};

export const authenticatedRouteTemplates = (source: string): string[] => {
  const marker = "export interface FileRoutesByTo {";
  const start = source.indexOf(marker);
  const end = source.indexOf("\n}", start + marker.length);
  if (start === -1 || end === -1) {
    throw new Error("Could not find FileRoutesByTo in routeTree.gen.ts");
  }
  const routes: string[] = [];
  for (const line of source.slice(start + marker.length, end).split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const match = /^\s*'([^']+)':\s*typeof\s+(\w+)\s*$/u.exec(line);
    if (!match?.[1] || !match[2]) {
      throw new Error(`Unknown FileRoutesByTo entry: ${line}`);
    }
    // Structural layout markers cover new top-level authenticated sections.
    if (/^(?:Protected|Knowledge)/u.test(match[2])) {
      routes.push(match[1]);
    }
  }
  if (routes.length === 0) {
    throw new Error("FileRoutesByTo has no authenticated routes");
  }
  return routes.toSorted();
};

export const assertSmokeRouteCoverage = (
  source: string,
  defs: readonly { template: string }[] = SMOKE_ROUTE_DEFS,
): void => {
  const actual = authenticatedRouteTemplates(source);
  const expected = [
    ...defs.map((def) => def.template),
    ...PUBLIC_VISITOR_ROUTE_DEFS.map((def) => def.template),
    ...INTENTIONALLY_NOT_SMOKED,
  ].toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = actual.filter((route) => !expected.includes(route));
    const stale = expected.filter((route) => !actual.includes(route));
    throw new Error(
      `Smoke route coverage differs: missing=${JSON.stringify(missing)} stale=${JSON.stringify(stale)}; declarations must cover each route exactly once`,
    );
  }
};

// Prepared route deltas exempt inventory changes, never measured budget growth.
export const networkBaselineCoverageProblem = ({
  actualKeys,
  expectedKeys,
  changedRoutes = [],
}: {
  actualKeys: string[];
  expectedKeys: string[];
  changedRoutes?: string[];
}): string | null => {
  const changed = new Set(changedRoutes);
  const expected = expectedKeys.filter((key) => !changed.has(key)).toSorted();
  const actual = actualKeys.filter((key) => !changed.has(key)).toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    return `Network baseline route keys differ: missing=${JSON.stringify(expected.filter((key) => !actual.includes(key)))} stale=${JSON.stringify(actual.filter((key) => !expected.includes(key)))}`;
  }
  return null;
};
