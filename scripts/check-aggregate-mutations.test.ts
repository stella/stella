import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  aggregateMutationBaseline,
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
  aggregateMutationBaseline(registrations).map((entry) => ({
    ...entry,
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

  test("a copied legacy registration in another group requires its own resolved path", () => {
    const original = enumerate(
      fixture(
        'group("/one", (app) => app.post("/existing", existing.handler))',
      ),
    );
    const baseline = legacy(original);
    const changed = enumerate(
      fixture(
        'group("/one", (app) => app.post("/existing", existing.handler)).group("/two", (app) => app.post("/existing", existing.handler))',
      ),
    );
    expect(changed.map((entry) => entry.key)).toEqual([
      expect.stringContaining("|POST|/one/existing|"),
      expect.stringContaining("|POST|/two/existing|"),
    ]);
    expect(
      checkAggregateMutationCoverage({
        registrations: changed,
        baseline,
        previous: baseline,
      }),
    ).toEqual([expect.stringContaining("Undeclared aggregate mutation:")]);
  });
  test("identical registration copies cannot reuse a baseline count", () => {
    const original = enumerate(fixture('post("/existing", existing.handler)'));
    const baseline = legacy(original);
    const changed = enumerate(
      fixture(
        'post("/existing", existing.handler).post("/existing", existing.handler)',
      ),
    );
    expect(
      checkAggregateMutationCoverage({
        registrations: changed,
        baseline,
        previous: baseline,
      }),
    ).toEqual([expect.stringContaining("count")]);
    expect(
      checkAggregateMutationCoverage({
        registrations: changed,
        baseline: legacy(changed),
        previous: baseline,
      }),
    ).toEqual([expect.stringContaining("may only shrink")]);
    expect(
      checkAggregateMutationCoverage({
        registrations: original,
        baseline,
        previous: legacy(changed),
      }),
    ).toEqual([]);
  });
  test("router and nested group prefixes compose", () => {
    const sources = fixture(
      'group("/inner", (app) => app.group("/child", (app) => app.post("/existing", existing.handler)))',
    );
    sources.set(
      routes,
      String(sources.get(routes)).replace(
        "new Elysia()",
        'new Elysia({prefix: "/router"})',
      ),
    );
    const original = enumerate(sources);
    expect(original.at(0)?.key).toContain(
      "|POST|/router/inner/child/existing|",
    );
  });
  test("cyclic receiver aliases terminate without hiding concrete routes", () => {
    const sources = fixture('post("/existing", existing.handler)');
    sources.set(
      routes,
      `${String(sources.get(routes))} const a = b; const b = a; a.post("/cycle", cyclic.handler);`,
    );
    const registrations = enumerate(sources);
    expect(registrations).toHaveLength(1);
    expect(registrations.at(0)?.key).toContain("|POST|/existing|");
    expect(registrations.at(0)?.declared).toBe(false);
  });

  test("unresolved group prefixes fail closed", () => {
    expect(() =>
      enumerate(
        fixture(
          'group(dynamic, (app) => app.post("/existing", existing.handler))',
        ),
      ),
    ).toThrow("Dynamic aggregate route prefix");
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

  describe("one-level calls into same-package lock helpers", () => {
    const module = "apps/api/src/handlers/example/create.ts";
    const service = "apps/api/src/services/example-lock.ts";
    const lockImport =
      'import { withAggregateLock } from "@/api/lib/db/aggregate-lock";';
    const acquisition =
      'await withAggregateLock({aggregate: "workspace", id, tx});';
    const handlerModule = ({
      imports = "",
      body,
      declaration = '{type: "aggregate", aggregates: ["workspace"]}',
    }: {
      imports?: string;
      body: string;
      declaration?: string;
    }) =>
      `import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { createSafeHandler } from "@/api/lib/api-handlers"; ${imports} const existing = createSafeHandler({}, async ({safeDb}) => { ${body} }); declareAggregateMutation(existing.handler, ${declaration}); export default existing;`;
    const setup = () => {
      const sources = fixture('post("/existing", existing.handler)');
      sources.set(
        routes,
        `import existing from "@/api/handlers/example/create"; ${String(sources.get(routes))}`,
      );
      return sources;
    };

    test("a same-package callee that awaits the helper covers the route", () => {
      const sources = setup();
      sources.set(
        service,
        `${lockImport} export const lockExample = async (tx) => { ${acquisition} };`,
      );
      sources.set(
        module,
        handlerModule({
          imports: 'import { lockExample } from "@/api/services/example-lock";',
          body: "await safeDb(async (tx) => { await lockExample(tx); });",
        }),
      );
      expect(enumerate(sources).at(0)?.declared).toBe(true);
      sources.set(
        module,
        handlerModule({
          imports: `${lockImport} async function lockLocal(tx) { ${acquisition} }`,
          body: "await safeDb(async (tx) => { await lockLocal(tx); });",
        }),
      );
      expect(enumerate(sources).at(0)?.declared).toBe(true);
      sources.set(
        module,
        handlerModule({
          imports: 'import { lockExample } from "@/api/services/example-lock";',
          body: "setTimeout(() => lockExample(tx), 0);",
        }),
      );
      expect(() => enumerate(sources)).toThrow("must await withAggregateLock");
    });

    test("generator handlers reach callees that lock in inline callbacks", () => {
      const sources = setup();
      const generator = (yielded: string) =>
        `import { Result } from "better-result"; import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { createSafeHandler } from "@/api/lib/api-handlers"; import { renewExample } from "@/api/services/example-lock"; const existing = createSafeHandler({}, async function* () { const renewed = yield* Result.await(${yielded}); return Result.ok(renewed); }); declareAggregateMutation(existing.handler, {type: "aggregate", aggregates: ["workspace"]}); export default existing;`;
      sources.set(
        service,
        `import { Result } from "better-result"; import { rootDb } from "@/api/db/root"; ${lockImport} export const renewExample = async () => { const outcome = await Result.tryPromise({ try: async () => await rootDb.transaction(async (tx) => { const lock = ${acquisition} }) }); return outcome; };`,
      );
      for (const yielded of [
        "await renewExample({ db })",
        "renewExample({ db })",
      ]) {
        sources.set(module, generator(yielded));
        expect(enumerate(sources).at(0)?.declared).toBe(true);
      }
      sources.set(
        service,
        `import { rlsDb } from "@/api/db/root"; ${lockImport} export const renewExample = async () => { await rlsDb.transaction(async function (tx) { ${acquisition} }); };`,
      );
      expect(enumerate(sources).at(0)?.declared).toBe(true);
      sources.set(
        service,
        `import { rootDb } from "@/api/db/root"; ${lockImport} export const renewExample = async () => { await rootDb.transaction(async (tx) => { await tx.transaction(async (savepoint) => { await withAggregateLock({aggregate: "workspace", id, tx: savepoint}); }); }); };`,
      );
      expect(enumerate(sources).at(0)?.declared).toBe(true);
      sources.set(
        service,
        `import { Result } from "better-result"; import { withAggregateLock, withAggregateTransaction } from "@/api/lib/db/aggregate-lock"; export const renewExample = async ({ db }) => { const outcome = await Result.tryPromise({ try: async () => await withAggregateTransaction(db, async (tx) => { const lock = ${acquisition} }) }); return outcome; };`,
      );
      expect(enumerate(sources).at(0)?.declared).toBe(true);
      for (const detached of [
        `setTimeout(async () => { ${acquisition} }, 0);`,
        `await setTimeout(async () => { ${acquisition} }, 0);`,
        `await runInTransaction(db, async (tx) => { ${acquisition} });`,
        `rootDb.transaction(async (tx) => { ${acquisition} });`,
        `await db.transaction(async (tx) => { ${acquisition} });`,
        `const custom = { transaction: (run) => undefined }; await custom.transaction(async (tx) => { ${acquisition} });`,
        `const rootDb = { transaction: (run) => undefined }; await rootDb.transaction(async (tx) => { ${acquisition} });`,
        `await setTimeout(async (tx) => { await tx.transaction(async (inner) => { ${acquisition} }); }, 0);`,
        `await rootDb.transaction(async (tx) => { const tx2 = tx; await tx2.transaction(async (inner) => { ${acquisition} }); });`,
        `await Result.tryPromise({ try: async (tx = custom) => { await tx.transaction(async () => { ${acquisition} }); } });`,
        `await Result.tryPromise({ try: async (tx) => { await tx.transaction(async () => { ${acquisition} }); } });`,
        `await rootDb.transaction(async (tx = custom) => { await tx.transaction(async () => { ${acquisition} }); });`,
        `await rootDb.transaction(async (tx) => { tx = custom; await tx.transaction(async () => { ${acquisition} }); });`,
        `await rootDb.transaction(async (first, tx) => { await tx.transaction(async () => { ${acquisition} }); });`,
        `await Result.tryPromise({ catch: async () => { ${acquisition} } });`,
        `const later = async (tx) => { ${acquisition} };`,
      ]) {
        sources.set(
          service,
          `import { Result } from "better-result"; import { rootDb } from "@/api/db/root"; ${lockImport} export const renewExample = async (db) => { ${detached} };`,
        );
        expect(() => enumerate(sources)).toThrow(
          "must await withAggregateLock",
        );
      }
    });

    test("shadowed or foreign runners earn no callback credit", () => {
      const sources = setup();
      sources.set(
        module,
        handlerModule({
          imports:
            'import { renewExample } from "@/api/services/example-lock";',
          body: "await renewExample({ safeDb: async () => {} });",
        }),
      );
      for (const callee of [
        `${lockImport} export const renewExample = async ({ safeDb }) => { await safeDb(async (tx) => { ${acquisition} }); };`,
        `import { Result } from "better-result"; ${lockImport} export const renewExample = async (Result) => { await Result.tryPromise({ try: async () => { ${acquisition} } }); };`,
        `import { custom } from "@/api/lib/custom-db"; ${lockImport} export const renewExample = async () => { await custom.transaction(async (tx) => { ${acquisition} }); };`,
        `import { abortableTx } from "@/api/db/safe-db"; ${lockImport} export const renewExample = async (abortableTx) => { await abortableTx(db, async (tx) => { ${acquisition} }); };`,
        `import { withAggregateSavepoint } from "@/api/lib/db/aggregate-lock"; ${lockImport} export const renewExample = async (tx) => { const withAggregateSavepoint = async () => {}; await withAggregateSavepoint(tx, async (inner) => { ${acquisition} }); };`,
      ]) {
        sources.set(service, callee);
        expect(() => enumerate(sources)).toThrow(
          "must await withAggregateLock",
        );
      }
    });

    test("a local binding shadowing a locking helper does not count", () => {
      const sources = setup();
      sources.set(
        service,
        `${lockImport} export const lockExample = async (tx) => { ${acquisition} };`,
      );
      const imports =
        'import { lockExample } from "@/api/services/example-lock";';
      for (const body of [
        "const lockExample = async () => {}; await safeDb(async (tx) => { await lockExample(tx); });",
        "await safeDb(async (tx) => { const lockExample = async () => {}; await lockExample(tx); });",
        "await safeDb(async (lockExample) => { await lockExample(tx); });",
        "if (ready) { var lockExample = async () => {}; } await lockExample(tx);",
      ]) {
        sources.set(module, handlerModule({ imports, body }));
        expect(() => enumerate(sources)).toThrow(
          "must await withAggregateLock",
        );
      }
    });

    test("the helper two levels deep does not cover the route", () => {
      const sources = setup();
      sources.set(
        "apps/api/src/services/example-inner.ts",
        `${lockImport} export const lockInner = async (tx) => { ${acquisition} };`,
      );
      sources.set(
        service,
        'import { lockInner } from "@/api/services/example-inner"; export const lockExample = async (tx) => { await lockInner(tx); };',
      );
      sources.set(
        module,
        handlerModule({
          imports: 'import { lockExample } from "@/api/services/example-lock";',
          body: "await safeDb(async (tx) => { await lockExample(tx); });",
        }),
      );
      expect(() => enumerate(sources)).toThrow("must await withAggregateLock");
    });

    test("a callee in another package does not count", () => {
      const sources = setup();
      sources.set(
        "packages/locks/package.json",
        JSON.stringify({ exports: { ".": "./src/index.ts" } }),
      );
      sources.set(
        "packages/locks/src/index.ts",
        `${lockImport} export const lockExample = async (tx) => { ${acquisition} };`,
      );
      sources.set(
        module,
        handlerModule({
          imports: 'import { lockExample } from "@stll/locks";',
          body: "await safeDb(async (tx) => { await lockExample(tx); });",
        }),
      );
      expect(() => enumerate(sources)).toThrow("must await withAggregateLock");
    });

    test("raw SQL locks and bare mentions of the helper do not count", () => {
      const sources = setup();
      sources.set(
        module,
        handlerModule({
          imports: 'import { lockExample } from "@/api/services/example-lock";',
          body: "await safeDb(async (tx) => { await lockExample(tx); });",
        }),
      );
      for (const callee of [
        'import { sql } from "drizzle-orm"; export const lockExample = async (tx) => { await tx.execute(sql`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`); };',
        `${lockImport} export const lockExample = async (tx) => { const lock = withAggregateLock; await lock({aggregate: "workspace", id, tx}); };`,
        'export const lockExample = async (tx) => { await withAggregateLock({aggregate: "workspace", id, tx}); };',
      ]) {
        sources.set(service, callee);
        expect(() => enumerate(sources)).toThrow(
          "must await withAggregateLock",
        );
      }
    });

    test("independent declarations keep working", () => {
      const sources = setup();
      sources.set(
        module,
        handlerModule({
          body: "await safeDb(async (tx) => {});",
          declaration:
            '{type: "independent", reason: "Fixture writes no aggregate."}',
        }),
      );
      expect(enumerate(sources).at(0)?.declared).toBe(true);
    });
  });
});
