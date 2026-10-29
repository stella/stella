import { describe, expect, test } from "bun:test";

import {
  aggregateMutationBaseline,
  checkAggregateMutationCoverage,
  verifyAggregateDeclarations,
} from "./check-aggregate-mutations";

const routes = "apps/api/src/handlers/example/routes.ts";
const owner = "apps/api/src/lib/db/aggregate-mutation-declaration.ts";
const fixture = () =>
  new Map([
    [
      "apps/api/src/lib/db/aggregate-lock.ts",
      "export const AGGREGATE_LOCKS = {workspace: {rank: 1}} as const;",
    ],
  ]);
/** Verifies every declaration site in the fixture; returns how many it found. */
const verify = (sources: Map<string, string>) =>
  verifyAggregateDeclarations({
    files: [...sources.keys()],
    load: (file) => sources.get(file),
  });
const legacy = (undeclared: readonly string[]) =>
  aggregateMutationBaseline(undeclared).map((entry) => ({
    ...entry,
    reason: "Existing fixture awaits ownership declaration.",
  }));

/** Typed fixture pairs, so destructuring yields strings. */
const pairs = (...items: [string, string][]) => items;

describe("aggregate mutation route coverage", () => {
  test("a planted mutation outside the inventory fails", () => {
    const baseline = legacy(["POST /existing"]);
    expect(
      checkAggregateMutationCoverage({
        undeclared: ["POST /existing", "DELETE /planted"],
        baseline,
        previous: baseline,
      }),
    ).toEqual(["Undeclared aggregate mutation: DELETE /planted"]);
  });

  test("the same handler at another path requires its own row", () => {
    const baseline = legacy(["POST /one/existing"]);
    expect(
      checkAggregateMutationCoverage({
        undeclared: ["POST /one/existing", "POST /two/existing"],
        baseline,
        previous: baseline,
      }),
    ).toEqual(["Undeclared aggregate mutation: POST /two/existing"]);
  });

  test("identical route copies cannot reuse a baseline count", () => {
    const original = ["POST /existing"];
    const changed = ["POST /existing", "POST /existing"];
    const baseline = legacy(original);
    expect(
      checkAggregateMutationCoverage({
        undeclared: changed,
        baseline,
        previous: baseline,
      }),
    ).toEqual([expect.stringContaining("count")]);
    expect(
      checkAggregateMutationCoverage({
        undeclared: changed,
        baseline: legacy(changed),
        previous: baseline,
      }),
    ).toEqual([expect.stringContaining("may only shrink")]);
    expect(
      checkAggregateMutationCoverage({
        undeclared: original,
        baseline,
        previous: legacy(changed),
      }),
    ).toEqual([]);
  });

  test("new baseline rows and changed reasons cannot grandfather a route", () => {
    const undeclared = ["POST /planted"];
    const baseline = legacy(undeclared);
    expect(
      checkAggregateMutationCoverage({ undeclared, baseline, previous: [] }),
    ).toEqual([expect.stringContaining("may only shrink")]);
    expect(
      checkAggregateMutationCoverage({
        undeclared,
        baseline,
        previous: baseline.map((row) => ({
          ...row,
          reason: "Previous reason.",
        })),
      }),
    ).toEqual([expect.stringContaining("may only shrink")]);
  });

  test("removed and declared routes require baseline removal", () => {
    const baseline = legacy(["POST /existing"]);
    expect(
      checkAggregateMutationCoverage({
        undeclared: [],
        baseline,
        previous: baseline,
      }),
    ).toEqual(["Stale aggregate mutation baseline entry: POST /existing"]);
    expect(
      checkAggregateMutationCoverage({
        undeclared: [],
        baseline: [],
        previous: baseline,
      }),
    ).toEqual([]);
  });

  test("generated rows name the method and carry one reason per method", () => {
    expect(
      aggregateMutationBaseline(["PUT /b", "DELETE /a", "PUT /b"]),
    ).toEqual([
      {
        key: "DELETE /a",
        count: 1,
        reason:
          "Existing DELETE route awaits ownership declaration at its route definition.",
      },
      {
        key: "PUT /b",
        count: 2,
        reason:
          "Existing PUT route awaits ownership declaration at its route definition.",
      },
    ]);
  });
});

describe("aggregate declaration sites", () => {
  const imports =
    'import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { withAggregateLock } from "@/api/lib/db/aggregate-lock";';
  const locked =
    'declareAggregateMutation(async () => { await withAggregateLock({aggregate: "workspace", id, tx}); }, {type: "aggregate", aggregates: ["workspace"]})';

  test("files that never name the helper are not parsed, and the owner is skipped", () => {
    const sources = fixture();
    sources.set(routes, "this is not ( valid source");
    sources.set(owner, "export const declareAggregateMutation = () => {};");
    expect(verify(sources)).toBe(0);
  });

  test("every direct call is verified, wherever it sits", () => {
    const sources = fixture();
    sources.set(
      routes,
      `${imports} export const route = routes({ "/a": { POST: ${locked} }, "/b": { PUT: ${locked} } });`,
    );
    expect(verify(sources)).toBe(2);
  });

  test("an independent declaration needs a reason and no lock", () => {
    const sources = fixture();
    sources.set(
      routes,
      `${imports} export const handler = declareAggregateMutation(definition, {type: "independent", reason: "Owns one row."});`,
    );
    expect(verify(sources)).toBe(1);
    sources.set(
      routes,
      `${imports} export const handler = declareAggregateMutation(definition, {type: "independent", reason: ""});`,
    );
    expect(() => verify(sources)).toThrow(
      "Missing mutation declaration reason",
    );
  });

  test("aliases, re-exports, namespace imports and lookalike owners fail closed", () => {
    for (const [source, message] of pairs(
      [
        `${imports} const alias = declareAggregateMutation; alias(handler, {type: "independent", reason: "r"});`,
        "Call declareAggregateMutation directly",
      ],
      [
        `${imports} export { declareAggregateMutation };`,
        "Call declareAggregateMutation directly",
      ],
      [
        'import * as owner from "@/api/lib/db/aggregate-mutation-declaration"; owner.declareAggregateMutation(handler, {type: "independent", reason: "r"});',
        "Import declareAggregateMutation by name from its owner",
      ],
      [
        'import { declareAggregateMutation } from "@/api/lib/db/other"; declareAggregateMutation(handler, {type: "independent", reason: "r"});',
        "Import declareAggregateMutation from",
      ],
      [
        'const owner = await import("@/api/lib/db/aggregate-mutation-declaration"); owner.declareAggregateMutation(handler, {type: "independent", reason: "r"});',
        "Call declareAggregateMutation directly",
      ],
      [
        `${imports} declareAggregateMutation(handler, decl);`,
        "Invalid aggregate mutation declaration",
      ],
    )) {
      const sources = fixture();
      sources.set(routes, source);
      expect(() => verify(sources)).toThrow(message);
    }
  });

  test("an aliased import is verified under its local name", () => {
    const sources = fixture();
    sources.set(
      routes,
      `import { declareAggregateMutation as own } from "@/api/lib/db/aggregate-mutation-declaration"; import { withAggregateLock } from "@/api/lib/db/aggregate-lock"; own(async () => {}, {type: "aggregate", aggregates: ["workspace"]});`,
    );
    expect(() => verify(sources)).toThrow("must await withAggregateLock");
  });

  test("an unknown aggregate cannot satisfy a declaration", () => {
    const sources = fixture();
    sources.set(
      routes,
      `${imports} declareAggregateMutation(handler, {type: "aggregate", aggregates: ["missing"]});`,
    );
    expect(() => verify(sources)).toThrow("Unknown aggregate registry name");
  });

  test("inline declarations verify their own implementation and owner import", () => {
    const sources = fixture();
    sources.set(routes, `${imports} export const route = ${locked};`);
    expect(verify(sources)).toBe(1);
    sources.set(
      routes,
      `${imports} export const route = ${locked.replace('await withAggregateLock({aggregate: "workspace", id, tx});', "")};`,
    );
    expect(() => verify(sources)).toThrow("must await withAggregateLock");
    sources.set(
      routes,
      `${imports.replace("@/api/lib/db/aggregate-lock", "@/api/lib/fake-lock")} export const route = ${locked};`,
    );
    expect(() => verify(sources)).toThrow("must await withAggregateLock");
  });

  test("inline declarations resolve named imported handlers by trusted binding", () => {
    const sources = fixture();
    sources.set(
      routes,
      `import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { existing } from "@/api/handlers/example/create"; export const route = declareAggregateMutation(existing, {type: "aggregate", aggregates: ["workspace"]});`,
    );
    const module = "apps/api/src/handlers/example/create.ts";
    const moduleImports =
      'import { createSafeHandler } from "@/api/lib/api-handlers"; import { withAggregateLock } from "@/api/lib/db/aggregate-lock";';
    const locking =
      'createSafeHandler({}, async () => { await withAggregateLock({aggregate: "workspace", id, tx}); })';
    sources.set(module, `${moduleImports} export const existing = ${locking};`);
    expect(verify(sources)).toBe(1);
    sources.set(
      module,
      `${moduleImports} export let existing = ${locking}; existing = createSafeHandler({}, async () => {});`,
    );
    expect(() => verify(sources)).toThrow(
      "Cannot resolve declared aggregate handler implementation",
    );
  });

  test.each([
    {
      imported: "withInvoiceMatterLocks as acquire",
      body: "await acquire(tx, ids);",
    },
    {
      imported: "lockInvoiceInStatus as acquire",
      body: "await acquire(tx, {invoiceId: invoiceId, workspaceId: workspaceId, status: status, matterLocks: {type: 'acquire'}});",
    },
    {
      imported: "withAggregateParentBatch as acquire",
      body: "await acquire({tx, organizationIds: [], workspaceIds: ids, mode: 'no key update'});",
    },
    {
      imported: "withAggregateParentBatch as acquire",
      body: "await acquire({tx, organizationIds: [], 'workspaceIds': [id], mode: 'no key update'});",
    },
  ])(
    "canonical awaited matter batches cover their declared workspace owner: $body",
    ({ imported, body }) => {
      const sources = fixture();
      sources.set(
        "apps/api/src/handlers/example/create.ts",
        `import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { createSafeHandler } from "@/api/lib/api-handlers"; import { ${imported} } from "@/api/lib/db/aggregate-lock"; const existing = createSafeHandler({}, async ({safeDb}) => { await safeDb(async (tx) => { ${body} }); }); declareAggregateMutation(existing, {type: "aggregate", aggregates: ["workspace"]}); export default existing;`,
      );
      expect(verify(sources)).toBe(1);
    },
  );

  test.each([
    {
      module: "@/api/lib/db/aggregate-lock",
      body: "acquire(tx, {invoiceId: invoiceId, workspaceId: workspaceId, status: status, matterLocks: {type: 'acquire'}});",
      imported: "lockInvoiceInStatus as acquire",
    },
    {
      module: "@/api/lib/db/aggregate-lock",
      body: "await acquire(tx, {invoiceId: invoiceId, workspaceId: workspaceId, status: status, matterLocks: {type: 'acquired'}});",
      imported: "lockInvoiceInStatus as acquire",
    },
    {
      module: "@/api/lib/db/aggregate-lock",
      body: "await acquire(tx, {invoiceId: invoiceId, workspaceId: null, status: status, matterLocks: {type: 'acquire'}});",
      imported: "lockInvoiceInStatus as acquire",
    },
    {
      module: "@/api/lib/db/aggregate-lock",
      body: "await acquire(tx, {invoiceId: invoiceId, workspaceId: workspaceId, status: status, matterLocks: {type: 'acquire'}, ...other});",
      imported: "lockInvoiceInStatus as acquire",
    },
    {
      module: "@/api/lib/db/aggregate-lock",
      body: "await acquire(tx, {invoiceId: invoiceId, workspaceId: workspaceId, status: status, matterLocks: {type: 'acquire'}, [key]: other});",
      imported: "lockInvoiceInStatus as acquire",
    },
    {
      module: "@/api/lib/db/aggregate-lock",
      body: "const acquire = async () => {}; await acquire(tx, {invoiceId: invoiceId, workspaceId: workspaceId, status: status, matterLocks: {type: 'acquire'}});",
      imported: "lockInvoiceInStatus as acquire",
    },
    {
      module: "@/api/lib/db/fake-lock",
      body: "await acquire(tx, {invoiceId: invoiceId, workspaceId: workspaceId, status: status, matterLocks: {type: 'acquire'}});",
      imported: "lockInvoiceInStatus as acquire",
    },
    {
      module: "@/api/lib/db/aggregate-lock",
      body: "acquire(tx, ids);",
      imported: "withInvoiceMatterLocks as acquire",
    },
    {
      module: "@/api/lib/db/aggregate-lock",
      body: "await acquire(tx);",
      imported: "withInvoiceMatterLocks as acquire",
    },
    {
      module: "@/api/lib/db/aggregate-lock",
      body: "await acquire(tx, []);",
      imported: "withInvoiceMatterLocks as acquire",
    },
    {
      module: "@/api/lib/db/aggregate-lock",
      body: "await acquire(tx, undefined);",
      imported: "withInvoiceMatterLocks as acquire",
    },
    {
      module: "@/api/lib/db/aggregate-lock",
      body: "await acquire(tx, null);",
      imported: "withInvoiceMatterLocks as acquire",
    },
    {
      module: "@/api/lib/db/aggregate-lock",
      body: "const acquire = async () => {}; await acquire(tx, ids);",
      imported: "withInvoiceMatterLocks as acquire",
    },
    {
      module: "@/api/lib/db/fake-lock",
      body: "await acquire(tx, ids);",
      imported: "withInvoiceMatterLocks as acquire",
    },
    {
      module: "@/api/lib/db/aggregate-lock",
      body: "acquire({tx, workspaceIds: ids});",
      imported: "withAggregateParentBatch as acquire",
    },
    {
      module: "@/api/lib/db/aggregate-lock",
      body: "await acquire({tx, organizationIds: ids});",
      imported: "withAggregateParentBatch as acquire",
    },
    {
      module: "@/api/lib/db/aggregate-lock",
      body: "await acquire({tx, workspaceIds: []});",
      imported: "withAggregateParentBatch as acquire",
    },
    {
      module: "@/api/lib/db/aggregate-lock",
      body: "await acquire({tx, workspaceIds: ids, ...other});",
      imported: "withAggregateParentBatch as acquire",
    },
    {
      module: "@/api/lib/db/aggregate-lock",
      body: "await acquire({tx, workspaceIds: ids, [key]: []});",
      imported: "withAggregateParentBatch as acquire",
    },
    {
      module: "@/api/lib/db/aggregate-lock",
      body: "const acquire = async () => {}; await acquire({tx, workspaceIds: ids});",
      imported: "withAggregateParentBatch as acquire",
    },
    {
      module: "@/api/lib/db/fake-lock",
      body: "await acquire({tx, workspaceIds: ids});",
      imported: "withAggregateParentBatch as acquire",
    },
  ])(
    "refuses unproven matter batch ownership: $module $body",
    ({ module, imported, body }) => {
      const sources = fixture();
      sources.set(
        "apps/api/src/handlers/example/create.ts",
        `import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { createSafeHandler } from "@/api/lib/api-handlers"; import { ${imported} } from "${module}"; const existing = createSafeHandler({}, async ({safeDb}) => { await safeDb(async (tx) => { ${body} }); }); declareAggregateMutation(existing, {type: "aggregate", aggregates: ["workspace"]}); export default existing;`,
      );
      expect(() => verify(sources)).toThrow("must await withAggregateLock");
    },
  );

  test.each([
    {
      module: "@/api/db/safe-db",
      joined: true,
      call: "await resultTx(safeDb, async (tx) => { await withInvoiceMatterLocks(tx, ids); });",
    },
    {
      module: "@/api/db/safe-db",
      joined: false,
      call: "resultTx(safeDb, async (tx) => { await withInvoiceMatterLocks(tx, ids); });",
    },
    {
      module: "@/api/db/fake-safe-db",
      joined: false,
      call: "await resultTx(safeDb, async (tx) => { await withInvoiceMatterLocks(tx, ids); });",
    },
    {
      module: "@/api/db/safe-db",
      joined: false,
      call: "const resultTx = async () => {}; await resultTx(safeDb, async (tx) => { await withInvoiceMatterLocks(tx, ids); });",
    },
  ])(
    "a result transaction joins its lock callback only through the actual awaited owner: $module $call",
    ({ module, joined, call }) => {
      const sources = fixture();
      sources.set(
        "apps/api/src/handlers/example/create.ts",
        `import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { createSafeRootHandler } from "@/api/lib/api-handlers"; import { resultTx } from "${module}"; import { withInvoiceMatterLocks } from "@/api/lib/db/aggregate-lock"; const existing = createSafeRootHandler({}, async function* ({safeDb}) { ${call} }); declareAggregateMutation(existing, {type: "aggregate", aggregates: ["workspace"]}); export default existing;`,
      );
      if (joined) {
        expect(verify(sources)).toBe(1);
      } else {
        expect(() => verify(sources)).toThrow("must await withAggregateLock");
      }
    },
  );

  test("a declaration through a local endpoint factory checks the factory's handler", () => {
    const sources = fixture();
    const create = (body: string) =>
      `import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { createSafeHandler } from "@/api/lib/api-handlers"; import { withAggregateLock } from "@/api/lib/db/aggregate-lock"; export const createEndpoint = (authorize = defaultAuthorize) => createSafeHandler({}, async () => { ${body} }); const existing = createEndpoint(); declareAggregateMutation(existing, {type: "aggregate", aggregates: ["workspace"]}); export default existing;`;
    sources.set(
      "apps/api/src/handlers/example/create.ts",
      create('await withAggregateLock({aggregate: "workspace", id, tx});'),
    );
    expect(verify(sources)).toBe(1);
    sources.set("apps/api/src/handlers/example/create.ts", create(""));
    expect(() => verify(sources)).toThrow("must await withAggregateLock");
  });

  test("the declared binding is the one whose handler must lock", () => {
    const sources = fixture();
    sources.set(
      "apps/api/src/handlers/example/create.ts",
      'import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { createSafeHandler } from "@/api/lib/api-handlers"; import { withAggregateLock } from "@/api/lib/db/aggregate-lock"; export const foo = createSafeHandler({}, async () => {}); const bar = createSafeHandler({}, async () => { await withAggregateLock({aggregate: "workspace", id, tx}); }); declareAggregateMutation(foo, {type: "aggregate", aggregates: ["workspace"]}); export default bar;',
    );
    expect(() => verify(sources)).toThrow("must await withAggregateLock");
  });
});

describe("declared handler locks", () => {
  test("each declared aggregate is acquired by the exact handler", () => {
    const sources = fixture();
    const prefix =
      'import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { createSafeHandler } from "@/api/lib/api-handlers"; import { withAggregateLock } from "@/api/lib/db/aggregate-lock";';
    const suffix =
      'declareAggregateMutation(existing, {type: "aggregate", aggregates: ["workspace"]}); export default existing;';
    const acquisition =
      'await withAggregateLock({aggregate: "workspace", id, tx});';
    sources.set(
      "apps/api/src/handlers/example/create.ts",
      `${prefix} const existing = createSafeHandler({}, async () => { ${acquisition} }); ${suffix}`,
    );
    expect(verify(sources)).toBe(1);
    sources.set(
      "apps/api/src/handlers/example/create.ts",
      `${prefix} const existing = createSafeHandler({}, async () => {}); ${suffix}`,
    );
    expect(() => verify(sources)).toThrow("must await withAggregateLock");
    sources.set(
      "apps/api/src/handlers/example/create.ts",
      `${prefix} const unrelated = async () => { ${acquisition} }; const existing = createSafeHandler({}, async () => {}); ${suffix}`,
    );
    expect(() => verify(sources)).toThrow("must await withAggregateLock");
    sources.set(
      "apps/api/src/handlers/example/create.ts",
      `${prefix} const existing = createSafeHandler({}, async () => { withAggregateLock({aggregate: "workspace", id, tx}); }); ${suffix}`,
    );
    expect(() => verify(sources)).toThrow("must await withAggregateLock");
  });

  test("both registered row-lock APIs require trusted awaited acquisitions", () => {
    const module = "apps/api/src/handlers/example/create.ts";
    const setup = fixture;
    const declaration =
      'declareAggregateMutation(existing, {type: "aggregate", aggregates: ["workspace"]}); export default existing;';

    for (const api of ["withAggregateLock", "withAggregateRowQuery"]) {
      const options =
        api === "withAggregateLock"
          ? '{aggregate: "workspace", id, mode: "update", tx}'
          : '{aggregate: "workspace", id, mode: "update", tx, select: (tx) => tx.select().from(workspaces)}';
      const acquire = `await acquireRows(${options});`;
      const imports =
        'import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { createSafeHandler } from "@/api/lib/api-handlers";';
      const sources = setup();

      sources.set(
        module,
        `${imports} import { ${api} as acquireRows } from "@/api/lib/db/aggregate-lock"; const existing = createSafeHandler({}, async () => { ${acquire} }); ${declaration}`,
      );
      expect(verify(sources)).toBe(1);

      sources.set(
        module,
        `${imports} import { ${api} as acquireRows } from "@/api/lib/db/aggregate-lock"; const existing = createSafeHandler({}, async () => { acquireRows(${options}); }); ${declaration}`,
      );
      expect(() => verify(sources)).toThrow("must await withAggregateLock");

      sources.set(
        module,
        `${imports} import { ${api} as acquireRows } from "@/api/lib/fake-lock"; const existing = createSafeHandler({}, async () => { ${acquire} }); ${declaration}`,
      );
      expect(() => verify(sources)).toThrow("must await withAggregateLock");

      sources.set(
        module,
        `${imports} import { ${api} as acquireRows } from "@/api/lib/db/aggregate-lock"; const existing = createSafeHandler({}, async () => { const acquireRows = async () => {}; await acquireRows(${options}); }); ${declaration}`,
      );
      expect(() => verify(sources)).toThrow("must await withAggregateLock");
    }
  });

  test("detached callbacks cannot cover an aggregate declaration", () => {
    const sources = fixture();
    const imports =
      'import { Result } from "better-result"; import { abortableTx } from "@/api/db/safe-db"; import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { createSafeHandler } from "@/api/lib/api-handlers"; import { withAggregateLock, withAggregateSavepoint } from "@/api/lib/db/aggregate-lock";';
    const acquire =
      'async (tx) => { await withAggregateLock({aggregate: "workspace", id, tx}); }';
    const declare =
      'declareAggregateMutation(existing, {type: "aggregate", aggregates: ["workspace"]}); export default existing;';
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
      expect(() => verify(sources)).toThrow("must await withAggregateLock");
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
      expect(verify(sources)).toBe(1);
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
      expect(verify(sources)).toBe(1);
    }
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
      `import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { createSafeHandler } from "@/api/lib/api-handlers"; ${imports} const existing = createSafeHandler({}, async ({safeDb}) => { ${body} }); declareAggregateMutation(existing, ${declaration}); export default existing;`;
    const setup = fixture;

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
      expect(verify(sources)).toBe(1);
      sources.set(
        module,
        handlerModule({
          imports: `${lockImport} async function lockLocal(tx) { ${acquisition} }`,
          body: "await safeDb(async (tx) => { await lockLocal(tx); });",
        }),
      );
      expect(verify(sources)).toBe(1);
      sources.set(
        module,
        handlerModule({
          imports: 'import { lockExample } from "@/api/services/example-lock";',
          body: "setTimeout(() => lockExample(tx), 0);",
        }),
      );
      expect(() => verify(sources)).toThrow("must await withAggregateLock");
    });

    test("generator handlers reach callees that lock in inline callbacks", () => {
      const sources = setup();
      const generator = (yielded: string) =>
        `import { Result } from "better-result"; import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { createSafeHandler } from "@/api/lib/api-handlers"; import { renewExample } from "@/api/services/example-lock"; const existing = createSafeHandler({}, async function* () { const renewed = yield* Result.await(${yielded}); return Result.ok(renewed); }); declareAggregateMutation(existing, {type: "aggregate", aggregates: ["workspace"]}); export default existing;`;
      sources.set(
        service,
        `import { Result } from "better-result"; import { rootDb } from "@/api/db/root"; ${lockImport} export const renewExample = async () => { const outcome = await Result.tryPromise({ try: async () => await rootDb.transaction(async (tx) => { const lock = ${acquisition} }) }); return outcome; };`,
      );
      for (const yielded of [
        "await renewExample({ db })",
        "renewExample({ db })",
      ]) {
        sources.set(module, generator(yielded));
        expect(verify(sources)).toBe(1);
      }
      sources.set(
        service,
        `import { rlsDb } from "@/api/db/root"; ${lockImport} export const renewExample = async () => { await rlsDb.transaction(async function (tx) { ${acquisition} }); };`,
      );
      expect(verify(sources)).toBe(1);
      sources.set(
        service,
        `import { rootDb } from "@/api/db/root"; ${lockImport} export const renewExample = async () => { await rootDb.transaction(async (tx) => { await tx.transaction(async (savepoint) => { await withAggregateLock({aggregate: "workspace", id, tx: savepoint}); }); }); };`,
      );
      expect(verify(sources)).toBe(1);
      sources.set(
        service,
        `import { Result } from "better-result"; import { withAggregateLock, withAggregateTransaction } from "@/api/lib/db/aggregate-lock"; export const renewExample = async ({ db }) => { const outcome = await Result.tryPromise({ try: async () => await withAggregateTransaction(db, async (tx) => { const lock = ${acquisition} }) }); return outcome; };`,
      );
      expect(verify(sources)).toBe(1);
      sources.set(
        service,
        `import { abortableTx, safeDbFromScoped } from "@/api/db/safe-db"; ${lockImport} export const renewExample = async ({ value }) => { return await abortableTx(safeDbFromScoped(value.scopedDb), async (tx) => { ${acquisition} }); };`,
      );
      expect(verify(sources)).toBe(1);
      for (const detached of [
        `await value.scopedDb(async (tx) => { ${acquisition} });`,
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
        `await rootDb.transaction(async (tx) => { [tx] = [custom]; await tx.transaction(async () => { ${acquisition} }); });`,
        `await rootDb.transaction(async (tx) => { [first, [tx]] = [0, [custom]]; await tx.transaction(async () => { ${acquisition} }); });`,
        `await rootDb.transaction(async (tx) => { ({ tx } = { tx: custom }); await tx.transaction(async () => { ${acquisition} }); });`,
        `await rootDb.transaction(async (tx) => { ({ inner: { value: tx } } = source); await tx.transaction(async () => { ${acquisition} }); });`,
        `await rootDb.transaction(async (tx) => { tx++; await tx.transaction(async () => { ${acquisition} }); });`,
        `await rootDb.transaction(async (tx) => { for (tx of handles) {} await tx.transaction(async () => { ${acquisition} }); });`,
        `await rootDb.transaction(async (tx) => { const swap = () => { tx = custom; }; swap(); await tx.transaction(async () => { ${acquisition} }); });`,
        `await rootDb.transaction(async (first, tx) => { await tx.transaction(async () => { ${acquisition} }); });`,
        `await Result.tryPromise({ catch: async () => { ${acquisition} } });`,
        `const later = async (tx) => { ${acquisition} };`,
      ]) {
        sources.set(
          service,
          `import { Result } from "better-result"; import { rootDb } from "@/api/db/root"; ${lockImport} export const renewExample = async (db) => { ${detached} };`,
        );
        expect(() => verify(sources)).toThrow("must await withAggregateLock");
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
        expect(() => verify(sources)).toThrow("must await withAggregateLock");
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
        expect(() => verify(sources)).toThrow("must await withAggregateLock");
      }
    });

    test("only never-written const, function or import bindings are trusted", () => {
      const sources = setup();
      const imports = `${lockImport} import { lockExample } from "@/api/services/example-lock";`;
      sources.set(
        service,
        `${lockImport} export const lockExample = async (tx) => { ${acquisition} };`,
      );
      sources.set(
        module,
        handlerModule({
          imports: `${lockImport} let lockLocal = async (tx) => { ${acquisition} }; lockLocal = async () => {};`,
          body: "await safeDb(async (tx) => { await lockLocal(tx); });",
        }),
      );
      expect(() => verify(sources)).toThrow("must await withAggregateLock");
      for (const definition of [
        `${lockImport} export let lockExample = async (tx) => { ${acquisition} };`,
        `${lockImport} export const lockExample = async (tx) => { ${acquisition} }; export function reset() { lockExample = async () => {}; }`,
        `${lockImport} export async function lockExample(tx) { ${acquisition} } lockExample = async () => {};`,
      ]) {
        sources.set(service, definition);
        sources.set(
          module,
          handlerModule({
            imports,
            body: "await safeDb(async (tx) => { await lockExample(tx); });",
          }),
        );
        expect(() => verify(sources)).toThrow("must await withAggregateLock");
      }
      for (const body of [
        `const withAggregateLock = async () => {}; ${acquisition}`,
        `await safeDb(async (tx) => { const withAggregateLock = async () => {}; ${acquisition} });`,
        `({ safeDb } = { safeDb: async () => {} }); await safeDb(async (tx) => { ${acquisition} });`,
      ]) {
        sources.set(module, handlerModule({ imports: lockImport, body }));
        expect(() => verify(sources)).toThrow("must await withAggregateLock");
      }
      sources.set(
        module,
        `import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration"; import { createSafeHandler } from "@/api/lib/api-handlers"; ${lockImport} let existing = createSafeHandler({}, async ({safeDb}) => { await safeDb(async (tx) => { ${acquisition} }); }); existing = createSafeHandler({}, async () => {}); declareAggregateMutation(existing, {type: "aggregate", aggregates: ["workspace"]}); export default existing;`,
      );
      expect(() => verify(sources)).toThrow(
        "Cannot resolve declared aggregate handler implementation",
      );
    });

    test("wrapped const helpers retain their lock ownership", () => {
      const sources = setup();
      sources.set(
        module,
        handlerModule({
          imports: 'import { lockExample } from "@/api/services/example-lock";',
          body: "await safeDb(async (tx) => { await lockExample(tx); });",
        }),
      );
      for (const wrap of [
        (callback: string) => `(${callback})`,
        (callback: string) => `(${callback}) as LockFunction`,
        (callback: string) => `(${callback}) satisfies LockFunction`,
      ]) {
        sources.set(
          service,
          `${lockImport} export const lockExample = ${wrap(`async (tx) => { ${acquisition} }`)};`,
        );
        expect(verify(sources)).toBe(1);
        sources.set(
          service,
          `${lockImport} export const lockExample = ${wrap("async (tx) => {}")};`,
        );
        expect(() => verify(sources)).toThrow("must await withAggregateLock");
      }
    });

    test("direct and followed locks combine to cover the declaration", () => {
      const sources = setup();
      sources.set(
        "apps/api/src/lib/db/aggregate-lock.ts",
        "export const AGGREGATE_LOCKS = {workspace: {rank: 1}, entity: {rank: 2}} as const;",
      );
      const declaration =
        '{type: "aggregate", aggregates: ["workspace", "entity"]}';
      const body =
        'await safeDb(async (tx) => { await withAggregateLock({aggregate: "workspace", id, tx}); await lockEntity(tx); });';
      const imports = `${lockImport} import { lockEntity } from "@/api/services/example-lock";`;
      sources.set(
        service,
        `${lockImport} export const lockEntity = async (tx) => { await withAggregateLock({aggregate: "entity", id, tx}); };`,
      );
      sources.set(module, handlerModule({ imports, body, declaration }));
      expect(verify(sources)).toBe(1);
      sources.set(
        service,
        `${lockImport} export let lockEntity = async (tx) => { await withAggregateLock({aggregate: "entity", id, tx}); };`,
      );
      expect(() => verify(sources)).toThrow("must await withAggregateLock");
    });

    test("only the final try property of Result.tryPromise is joined", () => {
      const sources = setup();
      sources.set(
        module,
        handlerModule({
          imports:
            'import { renewExample } from "@/api/services/example-lock";',
          body: "await renewExample(options);",
        }),
      );
      const callee = (members: string) =>
        `import { Result } from "better-result"; ${lockImport} export const renewExample = async (options) => { await Result.tryPromise({ ${members} }); };`;
      const locking = `try: async () => { ${acquisition} }`;
      sources.set(service, callee(`...options, ${locking}`));
      expect(verify(sources)).toBe(1);
      for (const members of [
        `${locking}, ...options`,
        `${locking}, try: async () => {}`,
        `${locking}, [key]: async () => {}`,
      ]) {
        sources.set(service, callee(members));
        expect(() => verify(sources)).toThrow("must await withAggregateLock");
      }
    });

    test("methods and class members inside a callee are not joined", () => {
      const sources = setup();
      sources.set(
        module,
        handlerModule({
          imports:
            'import { renewExample } from "@/api/services/example-lock";',
          body: "await renewExample(tx);",
        }),
      );
      for (const detached of [
        `const handlers = { async run() { ${acquisition} } };`,
        `class Later { async run() { ${acquisition} } }`,
      ]) {
        sources.set(
          service,
          `${lockImport} export const renewExample = async (tx) => { ${detached} };`,
        );
        expect(() => verify(sources)).toThrow("must await withAggregateLock");
      }
    });

    test("generators and indirect invocations earn no credit", () => {
      const sources = setup();
      const imports =
        'import { lockExample } from "@/api/services/example-lock";';
      for (const [definition, body] of pairs(
        [
          `export async function* lockExample(tx) { ${acquisition} }`,
          "await safeDb(async (tx) => { await lockExample(tx); });",
        ],
        [
          `export const lockExample = async function* (tx) { ${acquisition} };`,
          "await safeDb(async (tx) => { await lockExample(tx); });",
        ],
        [
          `import { rootDb } from "@/api/db/root"; export const lockExample = async () => { await rootDb.transaction(async function* (tx) { ${acquisition} }); };`,
          "await lockExample();",
        ],
        [
          `export const lockExample = async (tx) => { ${acquisition} };`,
          "await safeDb(async (tx) => { await lockExample.call(undefined, tx); });",
        ],
      )) {
        sources.set(service, `${lockImport} ${definition}`);
        sources.set(module, handlerModule({ imports, body }));
        expect(() => verify(sources)).toThrow("must await withAggregateLock");
      }
    });

    test("only directly exported named definitions are followed", () => {
      const sources = setup();
      const body = "await safeDb(async (tx) => { await lockExample(tx); });";
      const locking = `async (tx) => { ${acquisition} }`;
      const named =
        'import { lockExample } from "@/api/services/example-lock";';
      sources.set(
        service,
        `${lockImport} export const lockExample = ${locking};`,
      );
      sources.set(module, handlerModule({ imports: named, body }));
      expect(verify(sources)).toBe(1);
      for (const [definition, imports] of pairs(
        [
          `const lockExample = ${locking}; const noop = async () => {}; export { noop as lockExample };`,
          named,
        ],
        [
          `export const lockExample = ${locking}; export { lockExample as other };`,
          named,
        ],
        [
          `const lockExample = ${locking}; export default lockExample;`,
          'import lockExample from "@/api/services/example-lock";',
        ],
        [
          `export default async function lockExample(tx) { ${acquisition} }`,
          'import lockExample from "@/api/services/example-lock";',
        ],
        [`const lockExample = ${locking}; export = lockExample;`, named],
        [
          `export const lockExample = ${locking};`,
          'import type { lockExample } from "@/api/services/example-lock";',
        ],
        [
          `export const lockExample = ${locking};`,
          'import { type lockExample } from "@/api/services/example-lock";',
        ],
        [
          `export const lockExample = ${locking};`,
          'import * as lockExample from "@/api/services/example-lock";',
        ],
      )) {
        sources.set(service, `${lockImport} ${definition}`);
        sources.set(module, handlerModule({ imports, body }));
        expect(() => verify(sources)).toThrow("must await withAggregateLock");
      }
      sources.set(
        service,
        `${lockImport} export const lockExample = ${locking};`,
      );
      sources.set(
        "apps/api/src/services/barrel.ts",
        'export { lockExample } from "./example-lock";',
      );
      sources.set(
        module,
        handlerModule({
          imports: 'import { lockExample } from "@/api/services/barrel";',
          body,
        }),
      );
      expect(() => verify(sources)).toThrow("must await withAggregateLock");
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
      expect(() => verify(sources)).toThrow("must await withAggregateLock");
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
      expect(() => verify(sources)).toThrow("must await withAggregateLock");
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
        expect(() => verify(sources)).toThrow("must await withAggregateLock");
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
      expect(verify(sources)).toBe(1);
    });
  });
});
