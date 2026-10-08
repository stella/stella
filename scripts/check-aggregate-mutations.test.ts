import { describe, expect, test } from "bun:test";

import {
  checkAggregateMutationCoverage,
  enumerateAggregateMutations,
} from "./check-aggregate-mutations";

const server = "apps/api/src/server.ts";
const routes = "apps/api/src/handlers/example/routes.ts";
const fixture = (registration: string) =>
  new Map([
    [
      "apps/api/src/lib/db/aggregate-lock.ts",
      "export const AGGREGATE_LOCKS = {workspace: {rank: 1}} as const;",
    ],
    [
      server,
      'import { route } from "@/api/handlers/example/routes"; new Elysia().use(route);',
    ],
    [
      routes,
      `export const route = new Elysia()${registration.startsWith("[") ? "" : "."}${registration};`,
    ],
  ]);
const enumerate = (sources: Map<string, string>) =>
  enumerateAggregateMutations((file) => sources.get(file));
const legacy = (registrations: ReturnType<typeof enumerate>) =>
  registrations
    .filter((entry) => !entry.declared)
    .map((entry) => ({
      key: entry.key,
      reason: "Existing fixture awaits ownership declaration.",
    }));

describe("aggregate mutation route coverage", () => {
  test("a planted mutation outside the inventory fails", () => {
    const original = enumerate(fixture('post("/existing", existing.handler)'));
    const baseline = legacy(original);
    const changed = enumerate(
      fixture(
        'post("/existing", existing.handler).delete("/planted", planted.handler)',
      ),
    );
    expect(changed.length).toBe(original.length + 1);
    expect(
      checkAggregateMutationCoverage({
        registrations: changed,
        baseline,
        previous: baseline,
      }),
    ).toEqual([expect.stringContaining("Undeclared aggregate mutation:")]);
  });

  test("new baseline rows and changed reasons cannot grandfather a route", () => {
    const registrations = enumerate(
      fixture('post("/planted", planted.handler)'),
    );
    const baseline = legacy(registrations);
    expect(
      checkAggregateMutationCoverage({ registrations, baseline, previous: [] }),
    ).toEqual([expect.stringContaining("may only shrink")]);
    expect(
      checkAggregateMutationCoverage({
        registrations,
        baseline,
        previous: baseline.map((row) => ({
          ...row,
          reason: "Previous reason.",
        })),
      }),
    ).toEqual([expect.stringContaining("may only shrink")]);
  });

  test("removed and declared routes require baseline removal", () => {
    const registrations = enumerate(
      fixture('post("/existing", existing.handler)'),
    );
    const baseline = legacy(registrations);
    expect(
      checkAggregateMutationCoverage({
        registrations: [],
        baseline,
        previous: baseline,
      }),
    ).toEqual([expect.stringContaining("Stale")]);
    expect(
      checkAggregateMutationCoverage({
        registrations: [],
        baseline: [],
        previous: baseline,
      }),
    ).toEqual([]);
  });

  test("follows dev imports and nested factories including ALL transports", () => {
    const sources = fixture('post("/existing", existing.handler)');
    sources.set(
      server,
      `${sources.get(server)}; if (dev) { await import("@/api/handlers/dev/routes"); }`,
    );
    sources.set(
      "apps/api/src/handlers/dev/routes.ts",
      'new Elysia().all("/transport", transport);',
    );
    expect(
      enumerate(sources)
        .map((entry) => entry.method)
        .toSorted(),
    ).toEqual(["ALL", "POST"]);
  });

  test("sidecar declaration belongs to the exact exported handler", () => {
    const sources = fixture('post("/existing", existing.handler)');
    sources.set(
      routes,
      `import existing from "@/api/handlers/example/create"; ${sources.get(routes)}`,
    );
    sources.set(
      "apps/api/src/handlers/example/create.ts",
      'import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; const existing = createSafeHandler({}); declareAggregateMutation(other.handler, {type: "aggregate", aggregates: ["workspace"]}); export default existing;',
    );
    expect(enumerate(sources).at(0)?.declared).toBe(false);
    sources.set(
      "apps/api/src/handlers/example/create.ts",
      'import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; const existing = createSafeHandler({}); declareAggregateMutation(existing.handler, {type: "aggregate", aggregates: ["workspace"]}); export default existing;',
    );
    expect(enumerate(sources).at(0)?.declared).toBe(true);
  });

  test("mounted producers are followed regardless of their filename", () => {
    const sources = fixture('post("/existing", existing.handler)');
    sources.set(
      server,
      'import { plugin } from "@/api/handlers/example/custom-plugin"; new Elysia().use(plugin);',
    );
    sources.set(
      "apps/api/src/handlers/example/custom-plugin.ts",
      'export const plugin = new Elysia().patch("/custom", handler);',
    );
    expect(enumerate(sources).map((entry) => entry.method)).toEqual(["PATCH"]);
  });

  test("constant paths are derived from their imported object", () => {
    const sources = fixture("post(PATHS.create, existing.handler)");
    sources.set(
      routes,
      `import { PATHS } from "@/api/lib/paths"; ${sources.get(routes)}`,
    );
    sources.set(
      "apps/api/src/lib/paths.ts",
      'export const PATHS = {create: "/derived"} as const;',
    );
    expect(enumerate(sources).at(0)?.key).toContain("|POST|/derived|");
  });

  test("dynamic paths and computed methods cannot evade coverage", () => {
    expect(() => enumerate(fixture("post(buildPath(), handler)"))).toThrow(
      "Dynamic mutation route path",
    );
    expect(() => enumerate(fixture('[method]("/computed", handler)'))).toThrow(
      "Computed route registration",
    );
  });

  test("generic route registration needs a reasoned baseline and cannot grow it", () => {
    const registrations = enumerate(
      fixture('route(["POST"], "/generic", handler)'),
    );
    expect(registrations.at(0)?.method).toBe("GENERIC");
    expect(
      checkAggregateMutationCoverage({
        registrations,
        baseline: [],
        previous: [],
      }),
    ).toEqual([expect.stringContaining("Undeclared aggregate mutation")]);
    expect(
      checkAggregateMutationCoverage({
        registrations,
        baseline: legacy(registrations),
        previous: [],
      }),
    ).toEqual([expect.stringContaining("may only shrink")]);
  });

  test("an unknown aggregate cannot satisfy a route declaration", () => {
    const sources = fixture(
      'post("/existing", declareAggregateMutation(handler, {type: "aggregate", aggregates: ["missing"]}))',
    );
    sources.set(
      routes,
      `import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; ${sources.get(routes)}`,
    );
    expect(() => enumerate(sources)).toThrow("Unknown aggregate registry name");
  });
});
