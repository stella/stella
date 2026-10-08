import { panic } from "better-result";
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
      `${String(sources.get(server))}; if (dev) { await import("@/api/handlers/dev/routes"); }`,
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
      `import existing from "@/api/handlers/example/create"; ${String(sources.get(routes))}`,
    );
    sources.set(
      "apps/api/src/handlers/example/create.ts",
      'import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; const existing = createSafeHandler({}); declareAggregateMutation(other.handler, {type: "aggregate", aggregates: ["workspace"]}); export default existing;',
    );
    expect(enumerate(sources).at(0)?.declared).toBe(false);
    sources.set(
      "apps/api/src/handlers/example/create.ts",
      'import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { createSafeHandler } from "@/api/lib/api-handlers"; import { withAggregateLock } from "@/api/lib/db/aggregate-lock"; const existing = createSafeHandler({}, async () => { await withAggregateLock({aggregate: "workspace", id, tx}); }); declareAggregateMutation(existing.handler, {type: "aggregate", aggregates: ["workspace"]}); export default existing;',
    );
    expect(enumerate(sources).at(0)?.declared).toBe(true);
  });

  test("a default export declaration does not classify a different named handler", () => {
    const sources = fixture('post("/named", foo.handler)');
    sources.set(
      routes,
      `import { foo } from "@/api/handlers/example/create"; ${String(sources.get(routes))}`,
    );
    sources.set(
      "apps/api/src/handlers/example/create.ts",
      'import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { createSafeHandler } from "@/api/lib/api-handlers"; import { withAggregateLock } from "@/api/lib/db/aggregate-lock"; export const foo = createSafeHandler({}, async () => {}); const bar = createSafeHandler({}, async () => { await withAggregateLock({aggregate: "workspace", id, tx}); }); declareAggregateMutation(bar.handler, {type: "aggregate", aggregates: ["workspace"]}); export default bar;',
    );
    expect(enumerate(sources).at(0)?.declared).toBe(false);
    expect(
      checkAggregateMutationCoverage({
        registrations: enumerate(sources),
        baseline: [],
        previous: [],
      }),
    ).toEqual([expect.stringContaining("Undeclared aggregate mutation")]);
  });

  test("each declared aggregate is acquired by the exact handler", () => {
    const sources = fixture('post("/existing", existing.handler)');
    sources.set(
      routes,
      `import existing from "@/api/handlers/example/create"; ${String(sources.get(routes))}`,
    );
    const prefix =
      'import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { createSafeHandler } from "@/api/lib/api-handlers"; import { withAggregateLock } from "@/api/lib/db/aggregate-lock";';
    const suffix =
      'declareAggregateMutation(existing.handler, {type: "aggregate", aggregates: ["workspace"]}); export default existing;';
    const acquisition =
      'await withAggregateLock({aggregate: "workspace", id, tx});';
    sources.set(
      "apps/api/src/handlers/example/create.ts",
      `${prefix} const existing = createSafeHandler({}, async () => { ${acquisition} }); ${suffix}`,
    );
    expect(enumerate(sources).at(0)?.declared).toBe(true);
    sources.set(
      "apps/api/src/handlers/example/create.ts",
      `${prefix} const existing = createSafeHandler({}, async () => {}); ${suffix}`,
    );
    expect(() => enumerate(sources)).toThrow("must await withAggregateLock");
    sources.set(
      "apps/api/src/handlers/example/create.ts",
      `${prefix} const unrelated = async () => { ${acquisition} }; const existing = createSafeHandler({}, async () => {}); ${suffix}`,
    );
    expect(() => enumerate(sources)).toThrow("must await withAggregateLock");
    sources.set(
      "apps/api/src/handlers/example/create.ts",
      `${prefix} const existing = createSafeHandler({}, async () => { withAggregateLock({aggregate: "workspace", id, tx}); }); ${suffix}`,
    );
    expect(() => enumerate(sources)).toThrow("must await withAggregateLock");
  });

  test("detached callbacks cannot cover an aggregate declaration", () => {
    const sources = fixture('post("/existing", existing.handler)');
    sources.set(
      routes,
      `import existing from "@/api/handlers/example/create"; ${String(sources.get(routes))}`,
    );
    const imports =
      'import { Result } from "better-result"; import { abortableTx } from "@/api/db/safe-db"; import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { createSafeHandler } from "@/api/lib/api-handlers"; import { withAggregateLock, withAggregateSavepoint } from "@/api/lib/db/aggregate-lock";';
    const acquire =
      'async (tx) => { await withAggregateLock({aggregate: "workspace", id, tx}); }';
    const declare =
      'declareAggregateMutation(existing.handler, {type: "aggregate", aggregates: ["workspace"]}); export default existing;';
    const module = "apps/api/src/handlers/example/create.ts";
    for (const detached of [
      `setTimeout(${acquire}, 0);`,
      `await arbitrary(${acquire});`,
      `safeDb(${acquire});`,
      `abortableTx(safeDb, ${acquire});`,
      `tx.transaction(${acquire});`,
      `await tx.transaction(${acquire});`,
      `withAggregateSavepoint(tx, ${acquire});`,
      `setTimeout(async () => { await withAggregateSavepoint(tx, ${acquire}); }, 0);`,
      `await safeDb(async (tx) => { setTimeout(${acquire}, 0); });`,
    ]) {
      sources.set(
        module,
        `${imports} const existing = createSafeHandler({}, async ({safeDb}) => { ${detached} }); ${declare}`,
      );
      expect(() => enumerate(sources)).toThrow("must await withAggregateLock");
    }
    for (const joined of [
      `await safeDb(${acquire});`,
      `await abortableTx(safeDb, ${acquire});`,
      `await withAggregateSavepoint(tx, ${acquire});`,
    ]) {
      sources.set(
        module,
        `${imports} const existing = createSafeHandler({}, async ({safeDb}) => { ${joined} }); ${declare}`,
      );
      expect(enumerate(sources).at(0)?.declared).toBe(true);
    }
    for (const yielded of [
      `safeDb(${acquire})`,
      `abortableTx(safeDb, ${acquire})`,
      `withAggregateSavepoint(tx, ${acquire})`,
    ]) {
      sources.set(
        module,
        `${imports} const existing = createSafeHandler({}, async function* ({safeDb}) { yield* Result.await(${yielded}); }); ${declare}`,
      );
      expect(enumerate(sources).at(0)?.declared).toBe(true);
    }
  });

  test("inline declarations verify their own implementation and owner import", () => {
    const sources = fixture(
      'post("/inline", declareAggregateMutation(async () => { await withAggregateLock({aggregate: "workspace", id, tx}); }, {type: "aggregate", aggregates: ["workspace"]}))',
    );
    const imports =
      'import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { withAggregateLock } from "@/api/lib/db/aggregate-lock";';
    const routeSource = sources.get(routes);
    if (routeSource === undefined) {
      panic("Missing route fixture");
    }
    sources.set(routes, `${imports} ${routeSource}`);
    expect(enumerate(sources).at(0)?.declared).toBe(true);
    sources.set(
      routes,
      `${imports} ${routeSource.replace('await withAggregateLock({aggregate: "workspace", id, tx});', "")}`,
    );
    expect(() => enumerate(sources)).toThrow("must await withAggregateLock");
    sources.set(
      routes,
      `${imports.replace("@/api/lib/db/aggregate-lock", "@/api/lib/fake-lock")} ${routeSource}`,
    );
    expect(() => enumerate(sources)).toThrow("must await withAggregateLock");
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
      `import { PATHS } from "@/api/lib/paths"; ${String(sources.get(routes))}`,
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
      `import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; ${String(sources.get(routes))}`,
    );
    expect(() => enumerate(sources)).toThrow("Unknown aggregate registry name");
  });
});
