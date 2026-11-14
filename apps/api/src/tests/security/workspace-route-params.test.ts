/**
 * Every route mounted under a `:workspaceId` segment receives `workspaceId` in
 * its params. A route-level `params` schema that omits it hands the handler
 * params without the matter it was authorized for, and a strict schema
 * refuses every request outright.
 *
 * `WorkspaceHandlerConfig["params"]` closes the class at compile time for
 * anything `createSafeHandler` mounts. This census is the runtime backstop for
 * what that type cannot see: endpoints defined outside the factory, tables
 * that mount a handler under a workspace prefix it was not written for, and
 * any future factory that skips the config type. It reads the composed route
 * table, so every mount path counts, and it asserts the invariant (the schema
 * declares `workspaceId`), not the spelling.
 */
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { apiRoutes } from "@/api/api-routes";
import type { RouteEntry } from "@/api/http/route";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const OBJECT_TYPES = new Set([
  "object",
  "loose_object",
  "strict_object",
  "object_with_rest",
]);

/**
 * Whether a params schema declares `workspaceId`. A valibot object (piped or
 * not) names its keys in `entries`; a union declares it only when every
 * option does. Any other shape cannot be shown to declare it.
 */
const declaresWorkspaceId = (schema: unknown): boolean => {
  if (!isRecord(schema)) {
    return false;
  }
  const type = schema["type"];
  if (typeof type === "string" && OBJECT_TYPES.has(type)) {
    const entries = schema["entries"];
    return isRecord(entries) && Object.hasOwn(entries, "workspaceId");
  }
  if (type === "union" || type === "variant" || type === "intersect") {
    const options = schema["options"];
    return (
      Array.isArray(options) &&
      options.length > 0 &&
      (type === "intersect"
        ? options.some(declaresWorkspaceId)
        : options.every(declaresWorkspaceId))
    );
  }
  return false;
};

const offenders = (entries: readonly RouteEntry[]): string[] =>
  entries
    .filter(
      ({ path, definition }) =>
        path.includes(":workspaceId") &&
        definition.config.params !== undefined &&
        !declaresWorkspaceId(definition.config.params),
    )
    .map(({ method, path }) => `${method} ${path}`);

describe("workspace-prefixed route params", () => {
  test("the route table mounts workspace routes with their own params schemas", () => {
    const workspaceRoutes = apiRoutes.filter(({ path }) =>
      path.includes(":workspaceId"),
    );
    expect(workspaceRoutes.length).toBeGreaterThan(50);
    // Without schemas to read the census below would pass vacuously.
    expect(
      workspaceRoutes.filter(
        ({ definition }) => definition.config.params !== undefined,
      ).length,
    ).toBeGreaterThan(10);
  });

  test("every params schema on a :workspaceId route declares workspaceId", () => {
    expect(offenders(apiRoutes)).toEqual([]);
  });

  test("the census reports a params schema that drops workspaceId", () => {
    const run = async () => "ok";
    const entry = (
      path: string,
      params: NonNullable<RouteEntry["definition"]["config"]["params"]>,
    ): RouteEntry => ({
      method: "GET",
      path,
      middleware: [],
      definition: { access: "workspace", config: { params }, run },
    });
    expect(
      offenders([
        entry(
          "/v1/files/:workspaceId/:fileId",
          v.object({ fileId: v.string() }),
        ),
        entry(
          "/v1/files/:workspaceId/:fileId/raw",
          v.pipe(v.object({ workspaceId: v.string(), fileId: v.string() })),
        ),
        entry("/v1/notes/:noteId", v.object({ noteId: v.string() })),
      ]),
    ).toEqual(["GET /v1/files/:workspaceId/:fileId"]);
  });
});
