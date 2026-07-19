import { OptionalKind } from "@sinclair/typebox";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { PERMISSIVE_ROUTE_SCHEMA_MARKER } from "@/api/lib/permissive-route-schema";

// Meta-test: routes built with `createSafeTokenHandler` authorize themselves
// from a caller-supplied credential, so Elysia's route-schema validation must
// never be able to answer a request before the handler's credential check
// runs. `TokenHandlerConfig` enforces at the type level that the `body`,
// `query`, and `params` slots only accept the branded permissive schemas from
// `permissive-route-schema.ts`; this test enforces the same invariant at
// runtime via the marker symbol those factories stamp, so a type-level bypass
// (a cast) is still a visible failure. It enumerates handler modules from the
// filesystem (like `cross-tenant-coverage.test.ts` enumerates domains), so a
// new token route is covered the moment it lands.

const handlersDir = path.resolve(import.meta.dir, "../../handlers");

/** Recursively collect handler source files that use the token factory. */
const collectTokenHandlerFiles = (dir: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTokenHandlerFiles(entryPath));
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue;
    }
    // Bare identifier, not `createSafeTokenHandler(`: explicit type
    // arguments (`createSafeTokenHandler<...>(...)`) must match too.
    if (readFileSync(entryPath, "utf-8").includes("createSafeTokenHandler")) {
      files.push(entryPath);
    }
  }
  return files.sort();
};

const tokenHandlerFiles = collectTokenHandlerFiles(handlersDir);

const VALIDATED_SLOTS = ["body", "query", "params"] as const;

type EndpointLike = {
  config: Record<string, unknown>;
  handler: unknown;
};

const isEndpointLike = (value: unknown): value is EndpointLike =>
  typeof value === "object" &&
  value !== null &&
  "config" in value &&
  typeof Reflect.get(value, "config") === "object" &&
  Reflect.get(value, "config") !== null &&
  "handler" in value &&
  typeof Reflect.get(value, "handler") === "function";

const endpointsOf = (module: Record<string, unknown>): EndpointLike[] =>
  Object.values(module).filter(isEndpointLike);

/** Reads a symbol property off a schema value without asserting its type. */
const symbolPropertyOf = (schema: unknown, symbol: symbol): unknown =>
  typeof schema === "object" && schema !== null
    ? Reflect.get(schema, symbol)
    : undefined;

describe("token-route validation order guard", () => {
  test("the filesystem scan finds the known token-route modules", () => {
    // Anchors prove the source-text heuristic still matches reality; if the
    // factory is renamed, this test must be updated alongside it.
    expect(tokenHandlerFiles).toContainEqual(
      path.join(handlersDir, "operator/read-registrations.ts"),
    );
    expect(tokenHandlerFiles).toContainEqual(
      path.join(handlersDir, "folio-collab/authorize.ts"),
    );
  });

  test.each(tokenHandlerFiles)(
    "%s only attaches branded permissive route schemas",
    async (file) => {
      const module: Record<string, unknown> = await import(file);
      const endpoints = endpointsOf(module);
      // Every module using the factory must export the endpoint it builds;
      // an unexported endpoint cannot be wired into a route anyway.
      expect(endpoints.length).toBeGreaterThan(0);

      for (const endpoint of endpoints) {
        for (const slot of VALIDATED_SLOTS) {
          const schema = endpoint.config[slot];
          if (schema === undefined) {
            continue;
          }
          // The runtime marker only exists on schemas built by the
          // permissive-route-schema factories; a hand-built or casted strict
          // schema fails here even though it may have satisfied the types.
          expect(symbolPropertyOf(schema, PERMISSIVE_ROUTE_SCHEMA_MARKER)).toBe(
            true,
          );
        }
        const bodySchema = endpoint.config["body"];
        if (bodySchema !== undefined) {
          // Body schemas must be root-optional so a body-less probe cannot
          // produce a framework validation error either.
          expect(symbolPropertyOf(bodySchema, OptionalKind)).toBe("Optional");
        }
      }
    },
  );
});
