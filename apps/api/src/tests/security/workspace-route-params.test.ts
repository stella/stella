/**
 * Every route mounted under a `:workspaceId` prefix receives `workspaceId` in
 * its params object. A route-level `params` schema that omits it fails
 * validation for every request, before authentication, with a bare
 * "Invalid request". `workspaceParams()` exists so handlers cannot get this
 * wrong; this census makes the helper mandatory rather than conventional.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const handlersDir = path.resolve(import.meta.dir, "../../handlers");

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
    if (/prefix: "[^"]*:workspaceId/u.test(readFileSync(full, "utf-8"))) {
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
  test("the source scan finds the known workspace route modules", () => {
    const modules = collectRouteModules(handlersDir);
    expect(modules).toContainEqual(
      path.join(handlersDir, "entities/routes.ts"),
    );
    expect(modules).toContainEqual(path.join(handlersDir, "files/routes.ts"));
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
