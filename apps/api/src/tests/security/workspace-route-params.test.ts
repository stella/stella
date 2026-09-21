/**
 * Every route mounted under a `:workspaceId` prefix receives `workspaceId` in
 * its params object. A route-level `params` schema that omits it fails
 * validation for every request, before authentication, with a bare
 * "Invalid request".
 *
 * `WorkspaceHandlerConfig["params"]` closes the class at compile time for
 * anything `createSafeHandler` mounts. This census is the runtime backstop for
 * what that type cannot see: params declared inline on a route or a `.group()`
 * guard, params reaching a route through a macro or a handler the factory does
 * not produce, and any future factory that skips the config type. Discovery
 * matches the `:workspaceId` segment in any route string, so a module that
 * mounts it in a `.group()` rather than its prefix is loaded too. It asserts
 * the invariant (the schema declares `workspaceId`), not the spelling, so a
 * hand-written schema is reported only when it actually drops the property.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const handlersDir = path.resolve(import.meta.dir, "../../handlers");

/**
 * A module mounts the workspace segment either in its own `prefix` or in a
 * `.group("/:workspaceId", ...)` inside it, so discovery matches the segment in
 * any string literal rather than in the prefix alone. Scanning for `new Elysia`
 * keeps the import list to route modules; everything else contributes no routes.
 */
const declaresWorkspaceRoute = (source: string): boolean =>
  source.includes("new Elysia") && /"[^"]*:workspaceId/u.test(source);

const collectRouteModules = (dir: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectRouteModules(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) {
      continue;
    }
    if (declaresWorkspaceRoute(readFileSync(full, "utf-8"))) {
      files.push(full);
    }
  }
  return files;
};

type RouteRecord = {
  hooks: unknown;
  method: string;
  path: string;
};

const isRouteRecord = (value: unknown): value is RouteRecord =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "path") === "string" &&
  typeof Reflect.get(value, "method") === "string";

const routesOf = (module: Record<string, unknown>): RouteRecord[] => {
  const routes: RouteRecord[] = [];
  for (const value of Object.values(module)) {
    const candidate =
      typeof value === "object" && value !== null
        ? Reflect.get(value, "routes")
        : undefined;
    if (Array.isArray(candidate)) {
      routes.push(...candidate.filter(isRouteRecord));
    }
  }
  return routes;
};

const paramsSchemaProperties = (hooks: unknown): unknown => {
  const params =
    typeof hooks === "object" && hooks !== null
      ? Reflect.get(hooks, "params")
      : undefined;
  return typeof params === "object" && params !== null
    ? Reflect.get(params, "properties")
    : undefined;
};

describe("workspace-prefixed route params", () => {
  test("the source scan finds both ways a module mounts the segment", () => {
    const modules = collectRouteModules(handlersDir);

    // Declared in the instance prefix.
    expect(modules).toContainEqual(
      path.join(handlersDir, "entities/routes.ts"),
    );
    expect(modules).toContainEqual(path.join(handlersDir, "files/routes.ts"));

    // Declared in a `.group("/:workspaceId", ...)` under a prefix that has no
    // segment of its own; a prefix-only scan never loads this module.
    expect(modules).toContainEqual(
      path.join(handlersDir, "workspaces/routes.ts"),
    );
  });

  test("every params schema on a :workspaceId route declares workspaceId", async () => {
    const offenders: string[] = [];
    for (const file of collectRouteModules(handlersDir)) {
      const module: Record<string, unknown> = await import(file);
      for (const route of routesOf(module)) {
        if (!route.path.includes(":workspaceId")) {
          continue;
        }
        const properties = paramsSchemaProperties(route.hooks);
        if (properties === undefined) {
          continue;
        }
        const hasWorkspaceId =
          typeof properties === "object" &&
          properties !== null &&
          "workspaceId" in properties;
        if (!hasWorkspaceId) {
          offenders.push(`${route.method} ${route.path}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
