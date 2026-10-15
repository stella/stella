import { panic } from "better-result";

import { compareCodeUnit } from "@stll/collation";
import { sha256Hex } from "@stll/sha256/bun";

import type { ConformanceTestEvidence } from "./conformance-test-evidence";

export const isConformanceRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Stable declarations, not compiled validators or executable schema metadata. */
export const serializeConformanceDeclaration = (value: unknown): string => {
  const serialized = JSON.stringify(value, (_key, entry: unknown) => {
    if (!isConformanceRecord(entry)) {
      return entry;
    }
    return Object.fromEntries(
      Object.entries(entry)
        .filter(
          ([, nested]) => typeof nested !== "function" && nested !== undefined,
        )
        .toSorted(([left], [right]) => compareCodeUnit(left, right)),
    );
  });
  return serialized ?? panic("Response declaration is not serializable");
};

export const conformanceDeclarationHash = (value: unknown): string =>
  sha256Hex(serializeConformanceDeclaration(value));

export const responseDeclarationStatuses = (schema: unknown): string[] => {
  if (schema === undefined || schema === null) {
    return [];
  }
  if (isConformanceRecord(schema)) {
    const keys = Object.keys(schema);
    if (
      keys.length > 0 &&
      keys.every((key) => /^(?:[1-5]\d{2}|default)$/u.test(key))
    ) {
      return keys.toSorted();
    }
  }
  return ["200"];
};

export type ConformanceSurface = {
  kind: "route" | "mcp" | "capability";
  id: string;
  owner: "stella" | "upstream";
  schema: unknown;
  schemaSource: string;
  handlerEndpoint?: string;
  httpTests: string[];
  handlerTests: string[];
  toolTests: string[];
  schemaExemption?: "upstream-text-relay";
};

/** Source calls are candidates; completed runtime observations remain separate. */
export const buildResponseConformanceCensus = (
  surfaces: readonly ConformanceSurface[],
  unresolvedCalls: ConformanceTestEvidence["unresolvedCalls"],
) => {
  const rows = surfaces
    .map(({ schema, ...surface }) => {
      const response =
        schema === undefined || schema === null
          ? { type: "missing" as const }
          : (() => {
              const hash = conformanceDeclarationHash(schema);
              return {
                type: "declared" as const,
                declaration: hash,
                statuses: responseDeclarationStatuses(schema),
              };
            })();
      return { ...surface, response };
    })
    .toSorted((left, right) =>
      compareCodeUnit(`${left.kind}:${left.id}`, `${right.kind}:${right.id}`),
    );
  const routes = rows.filter((row) => row.kind === "route");
  return {
    version: 1,
    testEvidence:
      "statically resolved invocations; not proof of completed execution",
    executionEvidence: "not-collected",
    counts: {
      routesTotal: routes.length,
      routesExercisedByTests: 0,
      routesWithoutExecutionEvidence: routes.length,
      routesWithDeclaredSchema: routes.filter(
        (row) => row.response.type === "declared",
      ).length,
      routesWithHttpTestCalls: routes.filter((row) => row.httpTests.length > 0)
        .length,
      routesWithHandlerTestCalls: routes.filter(
        (row) => row.handlerTests.length > 0,
      ).length,
      toolsTotal: rows.filter((row) => row.kind === "mcp").length,
      capabilitiesTotal: rows.filter((row) => row.kind === "capability").length,
    },
    unresolvedCalls,
    surfaces: rows,
  };
};
