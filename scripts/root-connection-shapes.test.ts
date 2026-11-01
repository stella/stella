import { Panic, panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as validationLib from "valibot";

import { compareCodeUnit } from "@stll/collation";
import { assertProperty } from "@stll/property-testing";

import {
  globalSystemWorkAllowedImports,
  inspectGlobalSystemWorkSource,
  isGlobalSystemWorkTestSource,
  parseGlobalSystemWorkOwners,
  readGlobalSystemWorkInventory,
} from "./global-system-work-census";
import {
  classifiedTableRelations,
  deriveOrgWriteGraphInputs,
  parseRecoveryOwnerFiles,
  parseRootConnectionDoorFiles,
  parseTableRelations,
} from "./org-write-graph-enrollment";
import {
  countRootConnectionImports,
  countRootConnectionTypeImports,
  findRootConnectionShapes,
  findStaleRootOperations,
  findUnscopedOrgWrites,
  orgScopeTableExportNames,
  ROOT_CONNECTION_SHAPE,
  ROOT_OPERATION_RESULTS,
  scanOrgWriteGraph,
} from "./root-connection-shapes";
import type { RootConnectionShape } from "./root-connection-shapes";
import {
  inspectWorkspaceSearchActivityActorSource,
  readWorkspaceSearchActivityActorInventory,
} from "./workspace-search-activity-actor-census";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const ROOT_IMPORT = 'import { rootDb } from "@/api/db/root";';
const FIXTURE_FILE = "apps/api/src/lib/fixture.ts";
const AUTH_FILE = ROOT_OPERATION_RESULTS.resolveMemberAuthorization.file;
const GLOBAL_SYSTEM_WORK_OWNERS = parseGlobalSystemWorkOwners(
  readFileSync(
    path.join(REPO_ROOT, "apps/api/src/lib/db/global-system-work.ts"),
    "utf-8",
  ),
  "apps/api/src/lib/db/global-system-work.ts",
);

const orgWritesOf = (...lines: string[]) =>
  findUnscopedOrgWrites({
    file: FIXTURE_FILE,
    content: lines.join("\n"),
    orgTables: new Set(["flowRuns", "signals"]),
  }).map(({ line, table, operation }) => ({ line, table, operation }));

describe("native validation model runtime contracts", () => {
  test.each([
    { type: "record", value: { type: "skip" } },
    { type: "array", value: ["skip"] },
  ])(
    "native unknown-item array validation copies its container and retains the $type item",
    ({ value }) => {
      const input = [value];
      const output = validationLib.parse(
        validationLib.array(validationLib.unknown()),
        input,
      );
      expect(output).not.toBe(input);
      expect(output.at(0)).toBe(value);
      output.push("added only to the copy");
      expect(input).toEqual([value]);
    },
  );

  test("nested native array schemas create fresh nested containers", () => {
    const value = { type: "skip" };
    const inner = [value];
    const input = [inner];
    const output = validationLib.parse(
      validationLib.array(validationLib.array(validationLib.unknown())),
      input,
    );
    const nested =
      output.at(0) ?? panic("Expected the native nested array output");
    expect(output).not.toBe(input);
    expect(nested).not.toBe(inner);
    expect(nested.at(0)).toBe(value);
    nested.push("added only to the nested copy");
    expect(inner).toEqual([value]);
  });

  test("failed native string validation retains the exact input object as output", () => {
    const state = { type: "skip" };
    const parsed = validationLib.safeParse(validationLib.string(), state);
    if (parsed.success) {
      expect.unreachable("An object cannot validate as a native string");
    }
    expect(parsed.output).toBe(state);
  });

  test("native object schemas copy declared nested outputs and omit optional fields", () => {
    const schema = validationLib.object({
      id: validationLib.string(),
      nested: validationLib.object({ slug: validationLib.string() }),
      rows: validationLib.array(
        validationLib.object({ value: validationLib.string() }),
      ),
      omitted: validationLib.optional(validationLib.string()),
    });
    const input = {
      id: "entities.read",
      nested: { slug: "read" },
      rows: [{ value: "one" }],
      extra: { ignored: true },
    };

    const output = validationLib.parse(schema, input);

    expect(output).not.toBe(input);
    expect(output.nested).not.toBe(input.nested);
    expect(output.rows).not.toBe(input.rows);
    expect(output.rows.at(0)).not.toBe(input.rows.at(0));
    expect(Object.hasOwn(output, "omitted")).toBe(false);
    expect(output).toEqual({
      id: "entities.read",
      nested: { slug: "read" },
      rows: [{ value: "one" }],
    });
  });

  test("native object unknown fields retain their input aliases", () => {
    const payload = { state: "original" };
    const input = { payload };
    const output = validationLib.parse(
      validationLib.object({ payload: validationLib.unknown() }),
      input,
    );

    expect(output).not.toBe(input);
    expect(output.payload).toBe(payload);
  });

  test("native optional schema wrapping does not mutate the base schema", () => {
    const base = validationLib.string();
    expect(validationLib.safeParse(base, undefined).success).toBe(false);
    const optional = validationLib.optional(base);
    expect(Object.is(optional, base)).toBe(false);
    expect(validationLib.safeParse(base, undefined).success).toBe(false);
    expect(validationLib.safeParse(optional, undefined).success).toBe(true);
  });
});

describe("owner writes use an organization-scoped transaction", () => {
  test("statement identities ignore layout while preserving the write predicate", () => {
    const fingerprint = (statement: string) =>
      findUnscopedOrgWrites({
        file: FIXTURE_FILE,
        content: `import { flowRuns } from "@/api/db/schema";\n${statement}`,
        orgTables: new Set(["flowRuns"]),
      }).at(0)?.fingerprint ?? panic("Statement fixture write is missing");
    const original = fingerprint(
      'tx.update(flowRuns).where(eq(flowRuns.id, "a"));',
    );
    expect(
      fingerprint(
        "tx\n .update(flowRuns)\n .where(eq(flowRuns.id, 'a')); // comment",
      ),
    ).toBe(original);
    expect(
      fingerprint('tx.update(flowRuns).where(eq(flowRuns.id, "b"));'),
    ).not.toBe(original);
  });
  test.each(["insert", "update", "delete"])(
    "classifies a direct %s by its schema export",
    (operation) => {
      const hits = orgWritesOf(
        'import { flowRuns as runs } from "@/api/db/schema";',
        `ownerTx.${operation}(runs);`,
      );
      expect(hits).toEqual([{ line: 2, table: "flowRuns", operation }]);
    },
  );

  test("the named callback admits only its own transaction and immutable aliases", () => {
    expect(
      orgWritesOf(
        'import { flowRuns } from "@/api/db/schema";',
        'import { withOrgScope as scopeOwner } from "@/api/db/org-scope";',
        'scopeOwner({ tx: ownerTx, scope, actor: { type: "system" }, fn: async (scopedTx) => {',
        "  const writer = scopedTx;",
        '  await writer.update(flowRuns).set({ status: "running" });',
        "  await ownerTx.delete(flowRuns);",
        "} });",
      ),
    ).toEqual([{ line: 6, table: "flowRuns", operation: "delete" }]);
  });

  test("namespace imports and computed method names retain table identity", () => {
    expect(
      orgWritesOf(
        'import * as schema from "@/api/db/schema/flows";',
        'import * as orgScope from "@/api/db/org-scope";',
        'const runs = schema["flowRuns"];',
        'orgScope.withOrgScope({ tx: ownerTx, scope, actor: { type: "system" }, fn: (scopedTx) => scopedTx["insert"](runs) });',
        'ownerTx["update"](runs);',
      ),
    ).toEqual([{ line: 5, table: "flowRuns", operation: "update" }]);
  });

  test("shadowed wrappers and mutable transaction aliases remain direct writes", () => {
    const hits = orgWritesOf(
      'import { flowRuns } from "@/api/db/schema";',
      'import { withOrgScope } from "@/api/db/org-scope";',
      "const local = (withOrgScope) => withOrgScope({ fn: (scopedTx) => scopedTx.update(flowRuns) });",
      'withOrgScope({ tx: ownerTx, scope, actor: { type: "system" }, fn: (scopedTx) => {',
      "  let writer = scopedTx;",
      "  writer.delete(flowRuns);",
      "} });",
    );
    expect(hits).toEqual([
      { line: 3, table: "flowRuns", operation: "update" },
      { line: 6, table: "flowRuns", operation: "delete" },
    ]);
  });

  test("global classifications do not enter organization write counts", () => {
    expect(
      orgWritesOf(
        'import { caseLawDecisions, flowRuns } from "@/api/db/schema";',
        "ownerTx.update(caseLawDecisions);",
        "const local = (flowRuns) => ownerTx.delete(flowRuns);",
      ),
    ).toEqual([]);
  });

  test("explicit SQL mutations use the same scoped receiver while read locks remain reads", () => {
    expect(
      orgWritesOf(
        'import { withOrgScope } from "@/api/db/org-scope";',
        "ownerTx.execute(sql`SELECT id FROM jobs FOR UPDATE`);",
        String.raw`ownerTx.execute(sql${"`"}UPDATE jobs SET status = ${"$"}{status}${"`"});`,
        String.raw`withOrgScope({ tx: ownerTx, scope, actor: { type: "system" }, fn: (scopedTx) => scopedTx.execute(sql${"`"}DELETE FROM jobs WHERE id = ${"$"}{id}${"`"}) });`,
      ),
    ).toEqual([{ line: 3, table: "<raw-sql>", operation: "execute" }]);
  });

  test("table classifications retain explicit registry export keys", () => {
    expect(
      orgScopeTableExportNames(
        "export const ORG_SCOPE_TABLES = { flowRuns: runScope, signals: signalScope } as const satisfies Registry;",
        FIXTURE_FILE,
      ),
    ).toEqual(["flowRuns", "signals"]);
    expect(() =>
      orgScopeTableExportNames(
        "export const ORG_SCOPE_TABLES = makeRegistry();",
        FIXTURE_FILE,
      ),
    ).toThrow("ORG_SCOPE_TABLES requires explicit export keys");
    expect(() => orgScopeTableExportNames("", FIXTURE_FILE)).toThrow(
      "ORG_SCOPE_TABLES requires one exported const binding",
    );
    expect(() =>
      orgScopeTableExportNames(
        "const ORG_SCOPE_TABLES = { flowRuns: runScope } as const;",
        FIXTURE_FILE,
      ),
    ).toThrow("ORG_SCOPE_TABLES requires one exported const binding");
    expect(() =>
      orgScopeTableExportNames(
        "export const ORG_SCOPE_TABLES = { flowRuns: runScope }; export const ORG_SCOPE_TABLES = { signals: signalScope };",
        FIXTURE_FILE,
      ),
    ).toThrow("ORG_SCOPE_TABLES requires one exported const binding");
    expect(() =>
      orgScopeTableExportNames(
        "export const ORG_SCOPE_TABLES = { flowRuns: runScope, flowRuns: otherScope };",
        FIXTURE_FILE,
      ),
    ).toThrow("ORG_SCOPE_TABLES repeats an export key");
  });

  test("dynamic schema imports preserve renamed and namespace table bindings", () => {
    expect(
      orgWritesOf(
        'const { flowRuns: runs } = await import("@/api/db/schema");',
        'const schema = await import("@/api/db/schema");',
        "ownerTx.update(runs);",
        "ownerTx.delete(schema.signals);",
      ),
    ).toEqual([
      { line: 3, table: "flowRuns", operation: "update" },
      { line: 4, table: "signals", operation: "delete" },
    ]);
  });
});

const shapesIn = (
  file: string,
  ...lines: readonly string[]
): RootConnectionShape[] =>
  findRootConnectionShapes(`${lines.join("\n")}\n`, file).map(
    ({ shape }) => shape,
  );

const shapesOf = (...lines: readonly string[]): RootConnectionShape[] =>
  shapesIn(FIXTURE_FILE, ...lines);

// Each case below is written in the form it took in the API before the
// worker handles became explicit, so a regression to that form is caught.
describe("shapes that supply the owner connection implicitly", () => {
  test("a destructured dependency default", () => {
    expect(
      shapesOf(
        ROOT_IMPORT,
        "export const executeFlowStep = async (",
        "  job: unknown,",
        "  { database = rootDb, makeScopedDb = createScoped }: Deps = {},",
        ") => await load(job, database);",
      ),
    ).toEqual([ROOT_CONNECTION_SHAPE.parameterDefault]);
  });

  test("a typed positional default", () => {
    expect(
      shapesOf(
        ROOT_IMPORT,
        "export const persistProjection = async (",
        "  options: Options,",
        '  database: Pick<typeof rootDb, "transaction"> = rootDb,',
        ") => await database.transaction(write(options));",
      ),
    ).toEqual([ROOT_CONNECTION_SHAPE.parameterDefault]);
  });

  test("a nullish fallback, including one wrapped in a member call", () => {
    expect(
      shapesOf(
        ROOT_IMPORT,
        "export const patch = async (userId: string, db?: Db) => {",
        "  const rows = await (db ?? rootDb).execute(query(userId));",
        "  return rows;",
        "};",
        "export const either = (db?: Db) => db || rootDb;",
        "export const assign = (holder: { db?: Db }) => { holder.db ??= rootDb; };",
        "let store: Store | undefined;",
        "export const getStore = () => (store ??= createStore(rootDb));",
        "export const orNew = (given?: Store) => given ?? new Store(rootDb);",
      ),
    ).toEqual([
      ROOT_CONNECTION_SHAPE.fallbackOperand,
      ROOT_CONNECTION_SHAPE.fallbackOperand,
      ROOT_CONNECTION_SHAPE.fallbackOperand,
      ROOT_CONNECTION_SHAPE.fallbackOperand,
      ROOT_CONNECTION_SHAPE.fallbackOperand,
    ]);
  });

  test("a conditional that writes on the owner connection", () => {
    expect(
      shapesOf(
        ROOT_IMPORT,
        "export const fail = async (actor: string | null, write: Write) => {",
        "  const result =",
        "    actor === null",
        "      ? await rootDb.transaction(write)",
        "      : await scoped(actor)(write);",
        "  return result;",
        "};",
        "export const facets = async (cursor: string | null) =>",
        "  await Promise.all([cursor ? empty : rootDb.execute(facetQuery)]);",
      ),
    ).toEqual([
      ROOT_CONNECTION_SHAPE.conditionalOperand,
      ROOT_CONNECTION_SHAPE.conditionalOperand,
    ]);
  });

  test("dependency objects, including properties set inside a callback", () => {
    expect(
      shapesOf(
        ROOT_IMPORT,
        "const DEFAULT_DEPENDENCIES: Dependencies = {",
        "  requestAutomaticOcr: async (input) =>",
        "    await requestAutomaticDocumentOcr({ ...input, db: rootDb }),",
        "};",
        "const defaultRepairDeps = { db: rootDb, repair: {} };",
        "export const withShorthand = () => configure({ rootDb });",
      ),
    ).toEqual([
      ROOT_CONNECTION_SHAPE.dependencyProperty,
      ROOT_CONNECTION_SHAPE.dependencyProperty,
      ROOT_CONNECTION_SHAPE.dependencyProperty,
    ]);
  });

  test("a store or host bound at module level", () => {
    expect(
      shapesOf(
        ROOT_IMPORT,
        "export const extractionRunStore = createExtractionRunStore(rootDb);",
        "const store = new AnalysisStore(rootDb);",
        "class Stores {",
        "  static runs: unknown;",
        "  static {",
        "    Stores.runs = createExtractionRunStore(rootDb);",
        "  }",
        "  static analyses = createAnalysisStore(rootDb);",
        "  later() {",
        "    return createExtractionRunStore(rootDb);",
        "  }",
        "}",
      ),
    ).toEqual([
      ROOT_CONNECTION_SHAPE.moduleLevelCall,
      ROOT_CONNECTION_SHAPE.moduleLevelCall,
      ROOT_CONNECTION_SHAPE.moduleLevelCall,
      ROOT_CONNECTION_SHAPE.moduleLevelCall,
      ROOT_CONNECTION_SHAPE.alias,
    ]);
  });

  test("a conditional that builds a store from it", () => {
    expect(
      shapesOf(
        ROOT_IMPORT,
        "export const pick = (given?: Store) =>",
        "  given ? given : createExtractionRunStore(rootDb);",
        "export const orNew = (given?: Store) =>",
        "  given === undefined ? new Store(rootDb) : given;",
      ),
    ).toEqual([
      ROOT_CONNECTION_SHAPE.conditionalOperand,
      ROOT_CONNECTION_SHAPE.conditionalOperand,
    ]);
  });

  test("an assignment of the handle or of a store built from it", () => {
    expect(
      shapesOf(
        ROOT_IMPORT,
        "export const plain = (given?: Db) => {",
        "  let db = given;",
        "  db = rootDb;",
        "  return db;",
        "};",
        "export const built = () => {",
        "  let store: Store | undefined;",
        "  store = createExtractionRunStore(rootDb);",
        "  return store;",
        "};",
        "export const braced = (given?: Store) => {",
        "  let store = given;",
        "  if (store === undefined) {",
        "    store = createExtractionRunStore(rootDb);",
        "  }",
        "  return store;",
        "};",
        "export const unbraced = (given?: Store) => {",
        "  let store = given;",
        "  if (!store) store = createExtractionRunStore(rootDb);",
        "  return store;",
        "};",
        "export const ifElse = (given?: Db) => {",
        "  let db: Db;",
        "  if (given) db = given;",
        "  else db = rootDb;",
        "  return db;",
        "};",
        "export const property = (holder: { db?: Db }) => {",
        "  holder.db = rootDb;",
        "};",
      ),
    ).toEqual([
      ROOT_CONNECTION_SHAPE.assignment,
      ROOT_CONNECTION_SHAPE.assignment,
      ROOT_CONNECTION_SHAPE.assignment,
      ROOT_CONNECTION_SHAPE.assignment,
      ROOT_CONNECTION_SHAPE.assignment,
      ROOT_CONNECTION_SHAPE.assignment,
    ]);
  });

  test("an assignment at module level counts its call once", () => {
    expect(
      shapesOf(
        ROOT_IMPORT,
        "let store: Store | undefined;",
        "store = createExtractionRunStore(rootDb);",
        "let db: Db | undefined;",
        "db = rootDb;",
      ),
    ).toEqual([
      ROOT_CONNECTION_SHAPE.moduleLevelCall,
      ROOT_CONNECTION_SHAPE.assignment,
    ]);
  });

  test("an alias or a returned handle", () => {
    expect(
      shapesOf(
        ROOT_IMPORT,
        "const database = rootDb;",
        "export const getDatabase = async () => {",
        "  if (configured()) {",
        "    return other;",
        "  }",
        "  return rootDb;",
        "};",
        "export const handle = () => rootDb;",
      ),
    ).toEqual([
      ROOT_CONNECTION_SHAPE.alias,
      ROOT_CONNECTION_SHAPE.alias,
      ROOT_CONNECTION_SHAPE.alias,
    ]);
  });

  test("a returned factory", () => {
    expect(
      shapesOf(
        ROOT_IMPORT,
        "export const makeStore = () => {",
        "  return createExtractionRunStore(rootDb);",
        "};",
        "export const repairs = () => createRepairDeps(rootDb);",
        "export const analyses = () => new AnalysisStore(rootDb);",
      ),
    ).toEqual([
      ROOT_CONNECTION_SHAPE.alias,
      ROOT_CONNECTION_SHAPE.alias,
      ROOT_CONNECTION_SHAPE.alias,
    ]);
  });
});

describe("binding resolution", () => {
  test("follows a renamed import", () => {
    expect(
      shapesOf(
        'import { rootDb as owner } from "../db/root";',
        "export const load = async (db = owner) => await db.select();",
      ),
    ).toEqual([ROOT_CONNECTION_SHAPE.parameterDefault]);
  });

  test("follows a namespace import, by member and by element", () => {
    expect(
      shapesOf(
        'import * as root from "@/api/db/root";',
        "export const a = (db?: Db) => db ?? root.rootDb;",
        'export const b = (db?: Db) => db ?? root["rootDb"];',
        "export const c = (db?: Db) => db ?? root.rlsDb;",
        "export const d = (db?: Db) => db ?? root.Transaction;",
      ),
    ).toEqual([
      ROOT_CONNECTION_SHAPE.fallbackOperand,
      ROOT_CONNECTION_SHAPE.fallbackOperand,
      ROOT_CONNECTION_SHAPE.fallbackOperand,
    ]);
  });

  test("treats the scoped-transaction pool like the owner connection", () => {
    expect(
      shapesOf(
        'import { rlsDb as pool } from "@/api/db/root";',
        "const database = pool;",
        "export const deps = { db: pool };",
        "export const load = async (db = pool) => db;",
      ),
    ).toEqual([
      ROOT_CONNECTION_SHAPE.alias,
      ROOT_CONNECTION_SHAPE.dependencyProperty,
      ROOT_CONNECTION_SHAPE.parameterDefault,
    ]);
  });

  test("follows renamed and namespace imports into assignments, returns and conditionals", () => {
    expect(
      shapesOf(
        'import { rootDb as owner } from "../db/root";',
        'import * as root from "@/api/db/root";',
        "export const renamed = (holder: { store?: Store }) => {",
        "  holder.store = createExtractionRunStore(owner);",
        "};",
        "export const namespaced = (given?: Db) => {",
        "  let db = given;",
        "  if (!db) db = root.rootDb;",
        "  return db;",
        "};",
        "export const returned = () => createExtractionRunStore(root.rootDb);",
        "export const ternary = (given?: Store) =>",
        "  given ? given : createExtractionRunStore(owner);",
      ),
    ).toEqual([
      ROOT_CONNECTION_SHAPE.assignment,
      ROOT_CONNECTION_SHAPE.assignment,
      ROOT_CONNECTION_SHAPE.alias,
      ROOT_CONNECTION_SHAPE.conditionalOperand,
    ]);
  });

  test("follows a dynamic import, destructured or as a namespace", () => {
    expect(
      shapesOf(
        "export const late = async () => {",
        '  const { rootDb: handle } = await import("@/api/db/root");',
        "  return handle;",
        "};",
        "export const lateNamespace = async () => {",
        '  const root = await import("@/api/db/root");',
        "  return { db: root.rootDb };",
        "};",
      ),
    ).toEqual([
      ROOT_CONNECTION_SHAPE.alias,
      ROOT_CONNECTION_SHAPE.dependencyProperty,
    ]);
  });

  test("ignores a local binding that shadows the import", () => {
    expect(
      shapesOf(
        ROOT_IMPORT,
        "const laneHandle = (rootDb: Db) => {",
        "  const transaction = async (fn: Fn) =>",
        "    await runUnderLane({ database: rootDb, work: fn });",
        "  return { transaction };",
        "};",
        "export const inner = () => {",
        "  const rootDb = scoped();",
        "  return { db: rootDb };",
        "};",
        "export const reassigned = (rootDb: Db, holder: { db?: Db }) => {",
        "  let store: Store | undefined;",
        "  if (!store) store = createExtractionRunStore(rootDb);",
        "  holder.db = rootDb;",
        "  return rootDb ? createExtractionRunStore(rootDb) : store;",
        "};",
        "export const returnsLocal = () => {",
        "  const rootDb = scoped();",
        "  return createExtractionRunStore(rootDb);",
        "};",
      ),
    ).toEqual([]);
  });

  test("ignores type-only imports and other modules' exports", () => {
    expect(
      shapesOf(
        'import type { rootDb } from "@/api/db/root";',
        'import { rootDb as other } from "@/api/db/other";',
        "export const load = async (db: typeof rootDb = other) => db;",
      ),
    ).toEqual([]);
    expect(
      shapesOf(
        'import { type rootDb } from "@/api/db/root";',
        "export type Db = typeof rootDb;",
      ),
    ).toEqual([]);
  });
});

describe("awaiting a call does not make its value explicit", () => {
  test("an awaited factory in every position that hands a value on", () => {
    expect(
      shapesOf(
        ROOT_IMPORT,
        "export const returned = async () => {",
        "  return await createExtractionRunStore(rootDb);",
        "};",
        "export const arrow = async () => await createExtractionRunStore(rootDb);",
        "export const assigned = async () => {",
        "  let store: Store | undefined;",
        "  store = await createExtractionRunStore(rootDb);",
        "  return store;",
        "};",
        "export const property = async (holder: { store?: Store }) => {",
        "  holder.store = await createExtractionRunStore(rootDb);",
        "};",
        "export const ternary = async (given?: Store) =>",
        "  given ? given : await createExtractionRunStore(rootDb);",
      ),
    ).toEqual([
      ROOT_CONNECTION_SHAPE.alias,
      ROOT_CONNECTION_SHAPE.alias,
      ROOT_CONNECTION_SHAPE.assignment,
      ROOT_CONNECTION_SHAPE.assignment,
      ROOT_CONNECTION_SHAPE.conditionalOperand,
    ]);
  });

  test("through renamed and namespace imports", () => {
    expect(
      shapesOf(
        'import { rootDb as owner } from "../db/root";',
        'import * as root from "@/api/db/root";',
        "export const renamed = async () => await createStore(owner);",
        "export const namespaced = async (holder: { store?: Store }) => {",
        "  holder.store = await createStore(root.rootDb);",
        "};",
        "export const ternary = async (given?: Store) =>",
        "  given ? given : await createStore(root.rootDb);",
        "export const either = async (given?: Store) =>",
        "  given ?? (await createStore(owner));",
      ),
    ).toEqual([
      ROOT_CONNECTION_SHAPE.alias,
      ROOT_CONNECTION_SHAPE.assignment,
      ROOT_CONNECTION_SHAPE.conditionalOperand,
      ROOT_CONNECTION_SHAPE.fallbackOperand,
    ]);
  });

  test("an unlisted operation, a listed one elsewhere, unawaited, or called as a member", () => {
    expect(
      shapesOf(
        ROOT_IMPORT,
        "export const repairs = async () => await runRepairs(rootDb);",
        "export const resolve = async (lookup: Lookup) =>",
        "  await resolveMemberAuthorization(lookup, rootDb);",
      ),
    ).toEqual([ROOT_CONNECTION_SHAPE.alias, ROOT_CONNECTION_SHAPE.alias]);
    expect(
      shapesIn(
        AUTH_FILE,
        ROOT_IMPORT,
        "export const unawaited = (lookup: Lookup) =>",
        "  resolveMemberAuthorization(lookup, rootDb);",
        "export const member = async (lookup: Lookup) =>",
        "  await auth.resolveMemberAuthorization(lookup, rootDb);",
      ),
    ).toEqual([ROOT_CONNECTION_SHAPE.alias, ROOT_CONNECTION_SHAPE.alias]);
  });

  test("ignores an awaited factory over a local that shadows the import", () => {
    expect(
      shapesOf(
        ROOT_IMPORT,
        "export const local = async (rootDb: Db) =>",
        "  await createExtractionRunStore(rootDb);",
        "export const inner = async (holder: { store?: Store }) => {",
        "  const rootDb = scoped();",
        "  holder.store = await createExtractionRunStore(rootDb);",
        "};",
      ),
    ).toEqual([]);
  });
});

test("every listed owner operation still names an awaited site in its file", () => {
  expect(
    findStaleRootOperations((file) =>
      readFileSync(path.join(REPO_ROOT, file), "utf-8"),
    ),
  ).toEqual([]);
});

describe("explicit uses are not shapes", () => {
  test("a direct query, an explicit argument, a local, and a door's operation", () => {
    expect(
      shapesOf(
        ROOT_IMPORT,
        "export const read = async (id: string) =>",
        "  await rootDb.select().from(table).where(eq(table.id, id));",
        "export const notifyActor = async (notice: Notice) => {",
        "  await fileNotice(notice, rootDb);",
        "};",
        "export const assignedResults = async (holder: Holder) => {",
        "  let rows: Row[] = [];",
        "  rows = await rootDb.select().from(table);",
        "  holder.rows = await rootDb.execute(query);",
        "  let settled: unknown;",
        "  settled = await rootDb.transaction(write);",
        "  return { rows, settled };",
        "};",
        "export const declared = () => {",
        "  const store = createExtractionRunStore(rootDb);",
        "  store.flush();",
        "};",
        "const handles = async () => {",
        '  const { rootDb: owner } = await import("@/api/db/root");',
        "  return { owner: laneHandle(owner) };",
        "};",
      ),
    ).toEqual([]);
  });

  test("a listed owner operation awaited in its own file", () => {
    expect(
      shapesIn(
        AUTH_FILE,
        ROOT_IMPORT,
        "export const resolveCredential = async (lookup: Lookup) =>",
        "  await resolveMemberAuthorization(lookup, rootDb);",
        "export const hooks = {",
        "  seed: async (organizationId: string) =>",
        "    await ensureDefaultDocumentTypes(organizationId, rootDb),",
        "};",
        "export const audience = async (lookup: Lookup) => {",
        "  return await resolveWorkspaceRealtimeAudience(lookup, rootDb);",
        "};",
      ),
    ).toEqual([]);
  });

  test("text in comments and strings", () => {
    expect(
      shapesOf(
        ROOT_IMPORT,
        "// const store = createStore(rootDb);",
        'const example = "db = rootDb";',
        "export const touch = async () => await rootDb.execute(example);",
      ),
    ).toEqual([]);
  });

  test("a file that never imports the connection", () => {
    expect(
      shapesOf("const rootDb = makeDb();", "export const deps = { rootDb };"),
    ).toEqual([]);
  });
});

describe("modules that reach an owner-level handle", () => {
  const importsOf = (...lines: readonly string[]): number =>
    countRootConnectionImports(
      `${lines.join("\n")}\n`,
      "apps/api/src/imports.ts",
    );
  const typesOf = (...lines: readonly string[]): number =>
    countRootConnectionTypeImports(
      `${lines.join("\n")}\n`,
      "apps/api/src/imports.ts",
    );

  test("one per handle a named import names, renamed or by path", () => {
    expect(importsOf(ROOT_IMPORT)).toBe(1);
    expect(importsOf('import { rlsDb } from "@/api/db/root";')).toBe(1);
    expect(importsOf('import { rootDb, rlsDb } from "@/api/db/root";')).toBe(2);
    expect(importsOf('import { rootDb as owner } from "../../db/root";')).toBe(
      1,
    );
    expect(importsOf('import { rlsDb } from "./root";')).toBe(1);
    expect(importsOf('import { rootDb } from "@/api/db/root.ts";')).toBe(1);
  });

  test("type-only references count apart: a parameter typed from a handle takes it", () => {
    const typeOnly = [
      ['import type { rootDb } from "@/api/db/root";', 1],
      ['import { type rlsDb, type Transaction } from "@/api/db/root";', 1],
      [
        'import type { rootDb as rootDatabase, Transaction } from "@/api/db/root";',
        1,
      ],
      ['import type * as root from "@/api/db/root";', 2],
      ['export type { rootDb } from "@/api/db/root";', 1],
      ['export { type rlsDb } from "@/api/db/root";', 1],
      ['export type * from "@/api/db/root";', 2],
      ['import type root = require("@/api/db/root");', 2],
      ['export type Db = typeof import("@/api/db/root").rootDb;', 1],
      ['export type Root = typeof import("@/api/db/root");', 2],
    ] as const;
    for (const [line, expected] of typeOnly) {
      expect([line, typesOf(line), importsOf(line)]).toEqual([
        line,
        expected,
        0,
      ]);
    }
  });

  test("a type-only import turned into a value import moves to the runtime count", () => {
    const before = 'import type { rootDb } from "@/api/db/root";';
    const after = 'import { rootDb } from "@/api/db/root";';
    expect([importsOf(before), typesOf(before)]).toEqual([0, 1]);
    expect([importsOf(after), typesOf(after)]).toEqual([1, 0]);
    const mixed = 'import { rootDb, type rlsDb } from "@/api/db/root";';
    expect([importsOf(mixed), typesOf(mixed)]).toEqual([1, 1]);
  });

  test("an indexed import type counts the member it selects", () => {
    for (const [line, expected] of [
      ['export type Db = typeof import("@/api/db/root")["rootDb"];', 1],
      ['export type Db = (typeof import("@/api/db/root"))["rlsDb"];', 1],
      ['export type Tx = import("@/api/db/root")["Transaction"];', 0],
    ] as const) {
      expect([line, typesOf(line), importsOf(line)]).toEqual([
        line,
        expected,
        0,
      ]);
    }
  });

  test("the shared transaction type alone does not count", () => {
    for (const line of [
      'import type { Transaction } from "@/api/db/root";',
      'export type Tx = import("@/api/db/root").Transaction;',
    ]) {
      expect([importsOf(line), typesOf(line)]).toEqual([0, 0]);
    }
  });

  test("re-exports count like imports", () => {
    expect(importsOf('export { rootDb } from "@/api/db/root";')).toBe(1);
    expect(importsOf('export { rlsDb as pool } from "../db/root";')).toBe(1);
    expect(importsOf('export * from "@/api/db/root";')).toBe(2);
    expect(importsOf('export * as root from "@/api/db/root";')).toBe(2);
    expect(importsOf('export { Transaction } from "@/api/db/root";')).toBe(0);
  });

  test("a namespace, require or undestructured dynamic import counts both", () => {
    expect(importsOf('import * as root from "@/api/db/root";')).toBe(2);
    expect(importsOf('import root = require("@/api/db/root");')).toBe(2);
    expect(
      importsOf(
        "export const load = async () => {",
        '  const root = await import("@/api/db/root");',
        "  return root;",
        "};",
      ),
    ).toBe(2);
    expect(
      importsOf(
        'export const load = () => import("@/api/db/root").then((m) => m.rlsDb);',
      ),
    ).toBe(2);
    expect(
      importsOf(
        "export const load = async () => {",
        '  const { rootDb, ...rest } = await import("@/api/db/root");',
        "  return [rootDb, rest];",
        "};",
      ),
    ).toBe(2);
  });

  test("a destructured dynamic import counts the handles it takes", () => {
    expect(
      importsOf(
        "export const load = async () => {",
        '  const { rlsDb, rootDb: owner } = await import("@/api/db/root");',
        "  return [rlsDb, owner];",
        "};",
      ),
    ).toBe(2);
    expect(
      importsOf(
        "export const load = async () => {",
        '  const { rlsDb } = await import("@/api/db/root");',
        "  return rlsDb;",
        "};",
      ),
    ).toBe(1);
  });

  test("other modules, side-effect imports, comments and strings do not count", () => {
    expect(
      importsOf(
        'import { rootDb } from "@/api/db/rooted";',
        'import { rootDb as other } from "@/api/lib/root-scoped-db";',
        'import "@/api/db/root";',
        '// import { rootDb } from "@/api/db/root";',
        "const text = 'import { rlsDb } from \"@/api/db/root\"';",
      ),
    ).toBe(0);
  });

  test("reads a generic arrow in a .ts file", () => {
    expect(
      importsOf(
        "export const first = <T,>(rows: T[]) => rows.at(0);",
        'import { rlsDb } from "@/api/db/root";',
      ),
    ).toBe(1);
  });
});

test("reports the line of each shape", () => {
  expect(
    findRootConnectionShapes(
      [ROOT_IMPORT, "", "export const deps = { db: rootDb };", ""].join("\n"),
      FIXTURE_FILE,
    ),
  ).toEqual([{ shape: ROOT_CONNECTION_SHAPE.dependencyProperty, line: 3 }]);
});

test("reads a generic arrow in a .ts file", () => {
  expect(
    shapesOf(
      ROOT_IMPORT,
      "export const first = <T,>(rows: T[]) => rows.at(0);",
      "export const load = async <T>(db: Db = rootDb): Promise<T> => await db.one();",
    ),
  ).toEqual([ROOT_CONNECTION_SHAPE.parameterDefault]);
});

test("dynamic imports retain handle identity through destructuring defaults", () => {
  for (const [binding, local] of [
    ["rootDb = fallback", "rootDb"],
    ["rootDb: owner = fallback", "owner"],
    ["rlsDb = fallback", "rlsDb"],
    ["rlsDb: owner = fallback", "owner"],
  ] as const) {
    expect(
      shapesOf(
        `const { ${binding} } = await import("@/api/db/root");`,
        `const config = { db: ${local} };`,
      ),
    ).toEqual([ROOT_CONNECTION_SHAPE.dependencyProperty]);
  }
});

describe("global system work source census", () => {
  test("every production caller is exactly the owner listed for its literal job", async () => {
    const { owners, importers, callSites } =
      await readGlobalSystemWorkInventory(REPO_ROOT);
    const expectedCallSites = Object.entries(owners)
      .map(([type, { owner }]) => ({ file: owner, type }))
      .toSorted(
        (left, right) =>
          compareCodeUnit(left.file, right.file) ||
          compareCodeUnit(left.type, right.type),
      );
    const productionCallSites = [
      ...new Map(
        callSites
          .filter(({ file }) => !isGlobalSystemWorkTestSource(file))
          .map((callSite) => [`${callSite.file}:${callSite.type}`, callSite]),
      ).values(),
    ].toSorted(
      (left, right) =>
        compareCodeUnit(left.file, right.file) ||
        compareCodeUnit(left.type, right.type),
    );
    const productionImporters = importers
      .filter((file) => !isGlobalSystemWorkTestSource(file))
      .toSorted(compareCodeUnit);
    const listedOwners = [
      ...new Set(Object.values(owners).map(({ owner }) => owner)),
    ].toSorted(compareCodeUnit);

    expect(productionCallSites).toEqual(expectedCallSites);
    expect(productionImporters).toEqual(listedOwners);
    expect(
      globalSystemWorkAllowedImports(REPO_ROOT)
        .map(({ path: file }) => file)
        .toSorted(compareCodeUnit),
    ).toEqual([...importers].toSorted(compareCodeUnit));
  });

  test("global job data can use shorthand while its intent stays literal", () => {
    const result = inspectGlobalSystemWorkSource(
      GLOBAL_SYSTEM_WORK_OWNERS,
      "apps/api/src/lib/flows/sync-flow-schedule-trigger.ts",
      'import {runGlobalSystemWork} from "@/api/lib/db/global-system-work"; export const run = (tx, originals) => runGlobalSystemWork(tx, {type: "flow-schedule-orphan-page", originals});',
    );
    expect(result.callSites.map(({ type }) => type)).toEqual([
      "flow-schedule-orphan-page",
    ]);
  });

  test("rejects a literal job call from a source outside the mapped owner", () => {
    const unownedSource = `
      import { runGlobalSystemWork as runGlobalWork } from "@/api/lib/db/global-system-work";
      runGlobalWork(tx, { type: "flow-schedule-orphan-page", originals: [] });
    `;

    expect(() =>
      inspectGlobalSystemWorkSource(
        GLOBAL_SYSTEM_WORK_OWNERS,
        "apps/api/src/lib/unowned-global-cleanup.ts",
        unownedSource,
      ),
    ).toThrow("is called outside its owner");
  });

  test("resolves sibling, normalized relative, and source-suffix imports to the guarded module", () => {
    const imports = [
      ...[
        "./global-system-work",
        "./global-system-work.ts",
        "./global-system-work.tsx",
        "./global-system-work.js",
        "./global-system-work.jsx",
        "./global-system-work.mts",
        "./global-system-work.cts",
        "./global-system-work.mjs",
        "./global-system-work.cjs",
      ].map((specifier) => ({
        file: "apps/api/src/lib/db/unowned-global-system-work.ts",
        specifier,
      })),
      ...[
        "../db/../db/global-system-work",
        "../db/../db/global-system-work.ts",
        "../db/../db/global-system-work.js",
      ].map((specifier) => ({
        file: "apps/api/src/lib/flows/unowned-global-system-work.ts",
        specifier,
      })),
      {
        file: "apps/api/src/lib/flows/unowned-global-system-work.ts",
        specifier: "@/api/lib/db/../db/global-system-work.ts",
      },
    ];

    for (const { file, specifier } of imports) {
      const source = `
        import { runGlobalSystemWork as run } from "${specifier}";
        run(tx, { type: "flow-schedule-orphan-page" });
      `;
      expect(() =>
        inspectGlobalSystemWorkSource(GLOBAL_SYSTEM_WORK_OWNERS, file, source),
      ).toThrow("is called outside its owner");
    }
  });

  test("rejects sibling and normalized relative re-exports of the guarded module", () => {
    for (const { file, specifier } of [
      {
        file: "apps/api/src/lib/db/unowned-global-system-work.ts",
        specifier: "./global-system-work",
      },
      {
        file: "apps/api/src/lib/flows/unowned-global-system-work.ts",
        specifier: "../db/../db/global-system-work.ts",
      },
    ]) {
      const source = `
        export { runGlobalSystemWork as run } from "${specifier}";
      `;
      expect(() =>
        inspectGlobalSystemWorkSource(GLOBAL_SYSTEM_WORK_OWNERS, file, source),
      ).toThrow("cannot re-export");
    }
  });

  test("shadowed helper names are not attributed to the imported function", () => {
    const shadowedSource = `
      import { runGlobalSystemWork as runGlobalWork } from "@/api/lib/db/global-system-work";
      const locallyDefined = (runGlobalWork) =>
        runGlobalWork(tx, { type: "flow-schedule-orphan-page", originals: [] });
    `;

    expect(() =>
      inspectGlobalSystemWorkSource(
        GLOBAL_SYSTEM_WORK_OWNERS,
        "apps/api/src/lib/flows/unowned-shadow.ts",
        shadowedSource,
      ),
    ).toThrow("without a direct call");
  });

  test("rejects escaped runtime references beside valid direct calls", () => {
    const escapedReferences = [
      `consume(runGlobalWork);`,
      `[runGlobalWork][0](tx, { type: "flow-schedule-orphan-page" });`,
      `runGlobalWork.call(null, tx, { type: "flow-schedule-orphan-page" });`,
      `runGlobalWork.apply(null, [tx, { type: "flow-schedule-orphan-page" }]);`,
      `const alias = runGlobalWork; consume(alias);`,
      `import * as jobs from "@/api/lib/db/global-system-work"; consume(jobs);`,
      `import * as jobs from "@/api/lib/db/global-system-work"; consume(jobs.runGlobalSystemWork);`,
      `import * as jobs from "@/api/lib/db/global-system-work"; jobs.runGlobalSystemWork.call(null, tx, { type: "flow-schedule-orphan-page" });`,
    ];

    for (const escapedReference of escapedReferences) {
      const source = `
        import { runGlobalSystemWork as runGlobalWork } from "@/api/lib/db/global-system-work";
        runGlobalWork(tx, { type: "flow-schedule-orphan-page" });
        ${escapedReference}
      `;
      expect(() =>
        inspectGlobalSystemWorkSource(
          GLOBAL_SYSTEM_WORK_OWNERS,
          "apps/api/src/lib/db/global-system-work.test.ts",
          source,
        ),
      ).toThrow("runGlobalSystemWork");
    }
  });

  test("rejects decoded require specifiers without an ESM import", () => {
    const sources = [
      'const jobs = require("@/api/lib/db/global\\u002dsystem\\u002dwork"); jobs.runGlobalSystemWork(tx, { type: "flow-schedule-orphan-page" });',
      'const jobs = r\\u0065quire("@/api/lib/db/global-system-work"); jobs.runGlobalSystemWork(tx, { type: "flow-schedule-orphan-page" });',
    ];
    for (const source of sources) {
      expect(() =>
        inspectGlobalSystemWorkSource(
          GLOBAL_SYSTEM_WORK_OWNERS,
          "apps/api/src/lib/unowned.ts",
          source,
        ),
      ).toThrow("cannot require runGlobalSystemWork");
    }
  });

  test.each([
    String.raw`r\u0065quire`,
    String.raw`\u0072equire`,
    String.raw`requ\u0069re`,
    String.raw`r\u{65}quire`,
    String.raw`\u{0000000072}equire`,
    String.raw`\u0072\u{65}\u0071\u0075\u0069\u0072\u0065`,
  ])(
    "rejects native require identifiers decoded from Unicode escapes: %s",
    (callee) => {
      expect(() =>
        inspectGlobalSystemWorkSource(
          GLOBAL_SYSTEM_WORK_OWNERS,
          "apps/api/src/lib/unowned.ts",
          `const jobs = ${callee}("@/api/lib/db/global-system-work"); jobs.runGlobalSystemWork(tx, {type: "flow-schedule-orphan-page"});`,
        ),
      ).toThrow("cannot require runGlobalSystemWork");
    },
  );

  test.each([
    String.raw`export const marker = "\u0301";`,
    String.raw`export const marker = /\u{1f680}/u;`,
    String.raw`// \u{110000} and \u{ffffffffffffffffffffffffffffffff}
      export const marker = true;`,
  ])(
    "unrelated Unicode escapes do not claim a guarded runtime import",
    (source) => {
      expect(
        inspectGlobalSystemWorkSource(
          GLOBAL_SYSTEM_WORK_OWNERS,
          "apps/api/src/lib/unrelated-unicode.test.ts",
          source,
        ),
      ).toEqual({ imported: false, callSites: [] });
    },
  );

  test("Unicode-only non-import files still reject invalid syntax", () => {
    expect(() =>
      inspectGlobalSystemWorkSource(
        GLOBAL_SYSTEM_WORK_OWNERS,
        "apps/api/src/lib/unrelated-unicode.test.ts",
        String.raw`const broken = ; const marker = "\u0301";`,
      ),
    ).toThrow("does not parse");
  });

  test("native ESM module records retain decoded static specifiers", () => {
    const file = "apps/api/src/lib/db/global-system-work.test.ts";
    expect(
      inspectGlobalSystemWorkSource(
        GLOBAL_SYSTEM_WORK_OWNERS,
        file,
        String.raw`import {runGlobalSystemWork} from "@/api/lib/db/global\u002dsystem\u002dwork";
        runGlobalSystemWork(tx, {type: "flow-schedule-orphan-page"});`,
      ).callSites,
    ).toEqual([{ file, type: "flow-schedule-orphan-page" }]);
  });

  test("keeps lexical shadowing separate from named and namespace imports", () => {
    const sources = [
      `
        import { runGlobalSystemWork as runGlobalWork } from "@/api/lib/db/global-system-work";
        runGlobalWork(tx, { type: "flow-schedule-orphan-page" });
        const local = (runGlobalWork) => consume(runGlobalWork);
      `,
      `
        import * as jobs from "@/api/lib/db/global-system-work";
        jobs.runGlobalSystemWork(tx, { type: "flow-schedule-orphan-page" });
        const local = (jobs) => consume(jobs);
      `,
    ];

    for (const source of sources) {
      expect(
        inspectGlobalSystemWorkSource(
          GLOBAL_SYSTEM_WORK_OWNERS,
          "apps/api/src/lib/db/global-system-work.test.ts",
          source,
        ).callSites,
      ).toHaveLength(1);
    }
  });

  test("reads only the top-level exported owner map, not a nested shadow", () => {
    expect(
      parseGlobalSystemWorkOwners(
        `
          const local = () => {
            const GLOBAL_SYSTEM_JOBS = {
              "flow-schedule-orphan-page": { owner: "wrong.ts" },
            };
            return GLOBAL_SYSTEM_JOBS;
          };
          export const GLOBAL_SYSTEM_JOBS = {
            "flow-schedule-orphan-page": { owner: "right.ts" },
          } as const;
        `,
        "fixture.ts",
      ),
    ).toEqual({ "flow-schedule-orphan-page": { owner: "right.ts" } });
  });

  test("ignores a type-only import as a runtime importer", () => {
    expect(
      inspectGlobalSystemWorkSource(
        GLOBAL_SYSTEM_WORK_OWNERS,
        "apps/api/src/lib/db/global-system-work-type.ts",
        `
          import { type runGlobalSystemWork } from "@/api/lib/db/global-system-work";
          type Runner = typeof runGlobalSystemWork;
        `,
      ),
    ).toEqual({ imported: false, callSites: [] });
  });

  test("recognizes an unaliased imported identifier as a direct call", () => {
    expect(
      inspectGlobalSystemWorkSource(
        GLOBAL_SYSTEM_WORK_OWNERS,
        "apps/api/src/lib/scheduler/tasks/flow-run.ts",
        `
          import { runGlobalSystemWork } from "@/api/lib/db/global-system-work";
          await runGlobalSystemWork(tx, {
            type: "flow-schedule-orphan-claim",
            definitionId: "definition",
            jobId: "job",
            lockedBy: "worker",
          });
        `,
      ).callSites,
    ).toEqual([
      {
        file: "apps/api/src/lib/scheduler/tasks/flow-run.ts",
        type: "flow-schedule-orphan-claim",
      },
    ]);
  });
});

describe("workspace search actor constructor census", () => {
  const owner = "apps/api/src/lib/db/recovery-bookkeeping/search.ts";

  test("the neutral actor contract has exactly one production constructor caller", async () => {
    const inventory =
      await readWorkspaceSearchActivityActorInventory(REPO_ROOT);
    expect(inventory).toEqual({
      importers: [owner],
      callSites: [{ file: owner }],
    });
  });

  test("rejects constructor calls outside the search bookkeeping owner", () => {
    expect(() =>
      inspectWorkspaceSearchActivityActorSource(
        "apps/api/src/lib/unowned-search-actor.ts",
        `import { createWorkspaceSearchActivityActor } from "@/api/lib/db/workspace-search-activity-actor";
        createWorkspaceSearchActivityActor();`,
      ),
    ).toThrow("outside its owner");
  });

  test.each([
    [
      "@/api/lib/db/../db/workspace-search-activity-actor",
      "apps/api/src/lib/unowned-search-actor.ts",
    ],
    [
      "../db/../db/workspace-search-activity-actor",
      "apps/api/src/lib/other/unowned-search-actor.ts",
    ],
  ])("resolves normalized constructor imports %s", (specifier, file) => {
    expect(() =>
      inspectWorkspaceSearchActivityActorSource(
        file,
        `import { createWorkspaceSearchActivityActor } from "${specifier}";
        createWorkspaceSearchActivityActor();`,
      ),
    ).toThrow("outside its owner");
  });

  test("rejects a constructor escape beside the owning direct call", () => {
    expect(() =>
      inspectWorkspaceSearchActivityActorSource(
        owner,
        `import { createWorkspaceSearchActivityActor as createActor } from "@/api/lib/db/workspace-search-activity-actor";
        createActor();
        consume(createActor);`,
      ),
    ).toThrow("only as a direct call or const alias");
  });

  test("type-only contract imports do not count as constructor use", () => {
    expect(
      inspectWorkspaceSearchActivityActorSource(
        "apps/api/src/db/org-scope.ts",
        `import type { WorkspaceSearchActivityActor } from "@/api/lib/db/workspace-search-activity-actor";
        type Actor = WorkspaceSearchActivityActor;`,
      ),
    ).toEqual({ imported: false, callSites: [] });
  });
});

describe("delegated organization write graph", () => {
  const entry = "apps/api/src/lib/other/root-caller.ts";
  const owner = "apps/api/src/lib/db/recovery-bookkeeping/claims.ts";
  const header = `
    import { rootDb } from "@/api/db/root";
    import { flowRuns, schedulerJobs } from "@/api/db/schema";
    import { withOrgScope } from "@/api/db/org-scope";
    import { write } from "@/api/lib/db/recovery-bookkeeping/claims";
  `;
  const analyze = (
    content: string,
    helper: string,
    extra: Readonly<Record<string, string>> = {},
  ) =>
    scanOrgWriteGraph({
      sources: new Map(
        Object.entries({
          "apps/api/src/db/root.ts": "export const rootDb = {};",
          "apps/api/src/db/org-scope.ts":
            "export const withOrgScope = () => {};",
          [entry]: content,
          [owner]: helper,
          ...extra,
        }),
      ),
      rootDoorFiles: new Set(),
      policyEntryFiles: new Set(),
      recoveryOwnerFiles: new Set([owner]),
      orgTables: new Set(["flowRuns"]),
      globalTables: new Set(["schedulerJobs"]),
      sqlTables: new Map([
        ["flow_runs", "flowRuns"],
        ["scheduler_jobs", "schedulerJobs"],
      ]),
    });
  const helper = `
    export function write(operation) {
      switch (operation.type) {
        case "write": return operation.tx.update(operation.table).set({ status: "running" });
        case "unrelated": return operation.tx.delete(missingTable);
        default: throw new Error("Unknown fixture operation");
      }
    }
  `;

  test("drizzle conditions over columns are predicates, not opaque delegates", () => {
    const result = analyze(
      `${header}
      import { and, eq, inArray } from "drizzle-orm";
      export const reach = () => withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
      export const run = (id) => rootDb.update(flowRuns).set({ status: "running" }).where(and(eq(flowRuns.id, id), inArray(flowRuns.status, ["pending"])));
      `,
      helper,
    );
    expect(
      result.hits.map(({ table, operation }) => `${table}#${operation}`),
    ).toEqual(["flowRuns#update"]);
  });

  test("a drizzle condition still refuses a database handle or a callable", () => {
    for (const argument of ["rootDb", "() => rootDb"]) {
      expect(() =>
        analyze(
          `${header}
          import { eq } from "drizzle-orm";
          export const reach = () => withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
          export const run = () => rootDb.update(flowRuns).set({ status: "running" }).where(eq(flowRuns.id, ${argument}));
          `,
          helper,
        ),
      ).toThrow(/delegate/iu);
    }
  });

  test("a canonical TaggedError subclass keeps its primitive metadata", () => {
    const routeErrorFile = "apps/api/src/lib/other/route-error.ts";
    const result = analyze(
      `${header}
      import { RouteGenerationError } from "./route-error";
      export const run = () => {
        const error = new RouteGenerationError("invalid route");
        if (error.message === "invalid route") {
          return write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
      helper,
      {
        [routeErrorFile]: `
          import { TaggedError } from "better-result";
          const RouteGenerationErrorBase = TaggedError("RouteGenerationError");
          export class RouteGenerationError extends RouteGenerationErrorBase {
            constructor(message) {
              super({message});
            }
          }
        `,
      },
    );
    expect(result.hits).toHaveLength(1);
  });

  test("canonical TaggedError wrappers preserve any literal tag", () => {
    const result = analyze(
      `${header}
      import { DomainFailure } from "./domain-failure";
      export const run = () => {
        const error = new DomainFailure("invalid input");
        if (error._tag === "DomainFailure") {
          return write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
      helper,
      {
        "apps/api/src/lib/other/domain-failure.ts": `
          import { TaggedError } from "better-result";
          const DomainFailureBase = TaggedError("DomainFailure");
          export class DomainFailure extends DomainFailureBase {
            constructor(message) {
              super({message});
            }
          }
        `,
      },
    );
    expect(result.hits).toHaveLength(1);
  });

  test.each([
    {
      label: "constructor body writes",
      source: `
        import { TaggedError } from "better-result";
        import { rootDb } from "@/api/db/root";
        import { flowRuns } from "@/api/db/schema";
        const RouteGenerationErrorBase = TaggedError("RouteGenerationError");
        export class RouteGenerationError extends RouteGenerationErrorBase {
          constructor(message) {
            super({message});
            rootDb.update(flowRuns).set({status: "running"});
          }
        }
      `,
    },
    {
      label: "extra metadata reference",
      source: `
        import { TaggedError } from "better-result";
        import { rootDb } from "@/api/db/root";
        const RouteGenerationErrorBase = TaggedError("RouteGenerationError");
        export class RouteGenerationError extends RouteGenerationErrorBase {
          constructor(message) {
            super({message, detail: rootDb});
          }
        }
      `,
    },
    {
      label: "extra superclass argument",
      source: `
        import { TaggedError } from "better-result";
        import { rootDb } from "@/api/db/root";
        const RouteGenerationErrorBase = TaggedError("RouteGenerationError");
        export class RouteGenerationError extends RouteGenerationErrorBase {
          constructor(message) {
            super({message}, rootDb);
          }
        }
      `,
    },
    {
      label: "extra instance field",
      source: `
        import { TaggedError } from "better-result";
        const RouteGenerationErrorBase = TaggedError("RouteGenerationError");
        export class RouteGenerationError extends RouteGenerationErrorBase {
          detail = "extra";
          constructor(message) {
            super({message});
          }
        }
      `,
    },
    {
      label: "extra method",
      source: `
        import { TaggedError } from "better-result";
        const RouteGenerationErrorBase = TaggedError("RouteGenerationError");
        export class RouteGenerationError extends RouteGenerationErrorBase {
          constructor(message) {
            super({message});
          }
          get detail() { return "extra"; }
        }
      `,
    },
    {
      label: "noncanonical factory shadow",
      expected: /source constructor dispatch requires an owner model/iu,
      source: `
        const TaggedError = (tag) => class {};
        const RouteGenerationErrorBase = TaggedError("RouteGenerationError");
        export class RouteGenerationError extends RouteGenerationErrorBase {
          constructor(message) {
            super({message});
          }
        }
      `,
    },
    {
      label: "ordinary Error base",
      expected: /source constructor dispatch requires an owner model/iu,
      source: `
        export class RouteGenerationError extends Error {
          constructor(message) {
            super(message);
          }
        }
      `,
    },
  ])(
    "rejects noncanonical TaggedError subclass behavior: %s",
    ({ source, expected }) => {
      expect(() =>
        analyze(
          `${header}
        import { RouteGenerationError } from "./route-error";
        export const run = () => {
          withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
          return new RouteGenerationError("invalid route");
        };
      `,
          helper,
          { "apps/api/src/lib/other/route-error.ts": source },
        ),
      ).toThrow(
        expected ??
          /tagged-error subclass has unsupported constructor behavior/iu,
      );
    },
  );

  test("a TaggedError constructor rejects transaction metadata arguments", () => {
    expect(() =>
      analyze(
        `${header}
        import { RouteGenerationError } from "./route-error";
        export const run = () => new RouteGenerationError(rootDb);
      `,
        helper,
        {
          "apps/api/src/lib/other/route-error.ts": `
            import { TaggedError } from "better-result";
            const RouteGenerationErrorBase = TaggedError("RouteGenerationError");
            export class RouteGenerationError extends RouteGenerationErrorBase {
              constructor(message) {
                super({message});
              }
            }
          `,
        },
      ),
    ).toThrow(/tagged-error metadata requires primitive values/iu);
  });

  test.each([
    {
      label: "required own property",
      source: "const source = {present: () => rootDb.delete(flowRuns)};",
      key: '"present"',
      expected: ["delete"],
    },
    {
      label: "primitive numeric key",
      source: 'const source = {"0": true};',
      key: "0",
      expected: ["delete"],
    },
    {
      label: "closed missing property",
      source: "const source = {present: () => rootDb.delete(flowRuns)};",
      key: '"missing"',
      expected: [],
    },
    {
      label: "optional property",
      source: "const source = input ? {present: true} : {};",
      key: '"present"',
      expected: ["delete"],
    },
    {
      label: "open object",
      source: "const source = {...input};",
      key: '"missing"',
      expected: ["delete"],
    },
    {
      label: "untracked input object",
      source: "const source = input;",
      key: '"missing"',
      expected: ["delete"],
    },
    {
      label: "dynamic proven string key",
      source:
        "const source = {present: true}; const key = v.parse(v.string(), candidate);",
      key: "key",
      expected: ["delete"],
    },
  ])(
    "Object.hasOwn models $label without reading stored values",
    ({ source, key, expected }) => {
      const result = analyze(
        `${header}
      import * as v from "valibot";
      export const run = (input, candidate) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${source}
        if (Object.hasOwn(source, ${key})) rootDb.delete(flowRuns);
      };`,
        helper,
      );
      expect(result.hits.map(({ operation }) => operation)).toEqual([
        ...expected,
      ]);
    },
  );

  test.each([
    'Object.hasOwn("abc", "0")',
    'Object.hasOwn(["value"], "0")',
    'Object.hasOwn({__proto__: {present: true}}, "present")',
  ])("Object.hasOwn refuses unsupported target shape: %s", (expression) => {
    expect(() =>
      analyze(
        `${header}
        export const run = () => {
          withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
          return ${expression};
        };`,
        helper,
      ),
    ).toThrow(
      /Object\.hasOwn requires a tracked object or opaque input object/iu,
    );
  });

  test("Object.hasOwn refuses keys that may invoke coercion callbacks", () => {
    expect(() =>
      analyze(
        `${header}
        export const run = () => {
          const source = {present: true};
          const key = {toString: () => rootDb.delete(flowRuns)};
          if (Object.hasOwn(source, key)) rootDb.delete(flowRuns);
        };`,
        helper,
      ),
    ).toThrow(
      /Object\.hasOwn key requires a primitive literal or proven string/iu,
    );
  });

  test("export-star lookup continues when an earlier star omits the requested name", () => {
    const first = "apps/api/src/lib/other/star-first.ts";
    const second = "apps/api/src/lib/other/star-second.ts";
    const result = analyze(
      `
      import { rootDb } from "@/api/db/root";
      import { flowRuns } from "@/api/db/schema";
      import { write } from "./star-relay";
      export const run = () => write({ type: "write", tx: rootDb, table: flowRuns });`,
      helper,
      {
        "apps/api/src/lib/other/star-relay.ts": `export * from "./star-first"; export * from "./star-second";`,
        [first]: `export const unrelated = "value";`,
        [second]: `export { write } from "@/api/lib/db/recovery-bookkeeping/claims";`,
      },
    );
    expect(
      result.hits.map(({ file, table, operation }) => ({
        file,
        table,
        operation,
      })),
    ).toEqual([{ file: owner, table: "flowRuns", operation: "update" }]);
  });

  test("a literal operation carries its actual table through a delegated binding", () => {
    const result = analyze(
      `${header}
      export const run = () => write({ type: "write", tx: rootDb, table: flowRuns });`,
      helper,
    );
    expect(
      result.hits.map(({ file, table, operation }) => ({
        file,
        table,
        operation,
      })),
    ).toEqual([{ file: owner, table: "flowRuns", operation: "update" }]);
    expect(result.analyzedEntries).toEqual(
      result.entries.map(({ file }) => file).toSorted(),
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
  });

  test("array updates retain delegated writes and possible branch targets", () => {
    expect(
      analyze(
        `${header}
      export const run = () => write({tx: rootDb, table: flowRuns});
    `,
        `
      export function write(operation) {
        const operations = [];
        operations.push(operation);
        for (const item of operations) item.tx.update(item.table).set({status: "running"});
      }
    `,
      ).hits,
    ).toHaveLength(1);
    const branching = `
      import { flowRuns, schedulerJobs } from "@/api/db/schema";
      export function write(operation) {
        const tables = [schedulerJobs];
        if (operation.flag) tables.unshift(flowRuns);
        else tables.pop();
        const table = tables.at(0);
        if (table === undefined) return null;
        return operation.tx.update(table).set({status: "running"});
      }
    `;
    expect(
      analyze(
        `${header}
      export const run = (flag) => write({tx: rootDb, flag});
    `,
        branching,
      ).hits,
    ).toHaveLength(1);
    expect(
      analyze(
        `${header}
      export const run = (flag) => withOrgScope({tx: rootDb, scope, actor, fn: (tx) => write({tx, flag})});
    `,
        branching,
      ).hits,
    ).toHaveLength(0);
  });

  test("root-free data projections do not require a transaction heap model", () => {
    const result = analyze(
      `${header}
      import { project } from "./projection";
      export const run = (value) => {
        project(value);
        return write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
      helper,
      {
        "apps/api/src/lib/other/projection.ts": `
        export const project = (input) => {
          const output = {};
          output.value = input.value;
          return output;
        };
      `,
      },
    );
    expect(result.hits).toHaveLength(1);
  });

  test("mutable iterable alternatives deduplicate primitive element values", () => {
    const values = [
      "write",
      ...Array.from({ length: 99 }, (_, index) => `item-${index}`),
    ];
    const valueList = values.map((value) => JSON.stringify(value)).join(", ");
    const result = analyze(
      `${header}
      export const run = (flag) => {
        const values = [${valueList}];
        const fixed = [...values];
        const mutable = [...values];
        mutable.push("extra");
        const choices = flag ? fixed : mutable;
        for (const value of [...choices]) {
          if (value === "write") write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
      helper,
    );
    expect(result.hits.map(({ table }) => table)).toEqual(["flowRuns"]);
  });

  test("mutable iterable alternatives preserve distinct object identities", () => {
    const objects = Array.from({ length: 65 }, () => '{ value: "write" }').join(
      ", ",
    );
    expect(() =>
      analyze(
        `${header}
        export const run = (flag) => {
          const fixed = [${objects}];
          const mutable = [${objects}];
          mutable.push({ value: "write" });
          const choices = flag ? fixed : mutable;
          for (const value of [...choices]) {
            if (value.value === "write") {
              write({ type: "write", tx: rootDb, table: flowRuns });
            }
          }
        };
      `,
        helper,
      ),
    ).toThrow(/distinct values: 129/iu);
  });

  test("a fixed iterable keeps repeated values in its finite domain", () => {
    const repeated = Array.from({ length: 129 }, () =>
      JSON.stringify("write"),
    ).join(", ");
    expect(() =>
      analyze(
        `${header}
        export const run = () => {
          const values = [${repeated}];
          const copied = [...values];
          for (const value of copied) {
            if (value === "write") {
              write({ type: "write", tx: rootDb, table: flowRuns });
            }
          }
        };
      `,
        helper,
      ),
    ).toThrow(/abstract (?:array|iterable) exceeds its finite domain/iu);
  });

  test("for-of continuation preserves later iteration write obligations", () => {
    const result = analyze(
      `${header}
      import { schedulerJobs } from "@/api/db/schema";
      export const run = (skip) => {
        for (const table of [schedulerJobs, flowRuns]) {
          if (skip) continue;
          write({type: "write", tx: rootDb, table});
        }
      };
    `,
      helper,
    );
    expect(result.hits.map(({ table }) => table)).toEqual(["flowRuns"]);
  });

  test("data object aliases retain every branch's possible write target", () => {
    const result = analyze(
      `${header}
      import { schedulerJobs } from "@/api/db/schema";
      export const run = (flag) => {
        const target = { table: schedulerJobs };
        const alias = target;
        if (flag) alias.table = flowRuns;
        return write({type: "write", tx: rootDb, table: target.table});
      };
    `,
      helper,
    );
    expect(result.hits.map(({ table }) => table)).toEqual(["flowRuns"]);
  });

  test("computed data fields retain possible targets and evaluate key expressions", () => {
    const result = analyze(
      `${header}
      import { schedulerJobs } from "@/api/db/schema";
      export const run = (name) => {
        const target = {table: schedulerJobs};
        const alias = target;
        alias[name] = flowRuns;
        write({type: "write", tx: rootDb, table: target.table});
        const data = {};
        return data[(write({type: "write", tx: rootDb, table: flowRuns}), "key")];
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(2);
  });

  test("conditional object spreads retain each possible organization target", () => {
    const result = analyze(
      `${header}
      import { schedulerJobs } from "@/api/db/schema";
      export const run = (flag) => write({
        type: "write", tx: rootDb,
        ...(flag ? {table: flowRuns} : {table: schedulerJobs}),
      });
    `,
      helper,
    );
    expect(result.hits.map(({ table }) => table)).toEqual(["flowRuns"]);
  });

  test("an optional spread cannot erase the original root receiver", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => withOrgScope({tx: rootDb, scope, actor,
        fn: (scopedTx) => write({
          type: "write", tx: rootDb, table: flowRuns,
          ...(flag ? {tx: scopedTx} : {}),
        }),
      });
    `,
      helper,
    );
    expect(result.hits).toHaveLength(1);
  });

  test("array membership is data-only and cannot hide an offset callback", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        if (["running", "waiting"].includes("running")) {
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        const values = ["running"];
        values.includes("running", {valueOf: () => write({type: "write", tx: rootDb, table: flowRuns})});
      };
    `,
        helper,
      ),
    ).toThrow(/array offset.*callable/iu);
  });

  test.each(["filter", "flatMap", "find"])(
    "%s retains the collection's actual delegated table",
    (method) => {
      const expression = method === "flatMap" ? "[table]" : "true";
      const consume =
        method === "find"
          ? "write({type: 'write', tx: rootDb, table: selected})"
          : "selected.forEach((table) => write({type: 'write', tx: rootDb, table}))";
      expect(
        analyze(
          `${header}
      export const run = () => {
        const selected = [flowRuns].${method}((table) => ${expression});
        return ${consume};
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test.each([
    "[...operations]",
    "[...new Set(operations)]",
    "new Set(operations)",
  ])("iterable %s preserves delegated transaction values", (expression) => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const operations = [{type: "write", tx: rootDb, table: flowRuns}];
        const selected = ${expression};
        for (const operation of selected) write(operation);
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each(["map", "flatMap", "filter", "some", "every", "find", "forEach"])(
    "a user-defined %s method retains its own writes",
    (method) => {
      expect(
        analyze(
          `${header}
      const receiver = {${method}: async (callback) => { await rootDb.delete(flowRuns); return callback(); }};
      export const run = async () => {
        await receiver.${method}(() => null);
        return write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(2);
    },
  );

  test.each([
    "tx",
    "() => write({type: 'write', tx, table: flowRuns})",
    "{prepared: tx.update(flowRuns).set({status: 'running'})}",
  ])("scoped result %s cannot export a transaction capability", (result) => {
    expect(() =>
      analyze(
        `${header}
      export const run = async () => {
        const result = await withOrgScope({tx: rootDb, scope, actor, fn: (tx) => (${result})});
        return write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ),
    ).toThrow(/scoped.*result.*capability/iu);
  });

  test("awaited query results are data collections, including scoped returns", () => {
    expect(
      analyze(
        `${header}
      export const run = async () => {
        const rows = await rootDb.select().from(flowRuns);
        await withOrgScope({tx: rootDb, scope, actor, fn: (tx) => tx.update(flowRuns).set({status: "running"})});
        rows.forEach(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    {
      imports: 'import * as v from "valibot";',
      schema: "v.array(v.string())",
      prepare: "const outcome = v.safeParse(schema, raw);",
      expression: "outcome.success ? outcome.output : []",
    },
    {
      imports:
        'import { array as list, string as text, parse as parseList } from "valibot";',
      schema: "list(text())",
      prepare: "",
      expression: "parseList(schema, raw)",
    },
  ])(
    "Valibot array output preserves native callbacks: $expression",
    ({ imports, schema, prepare, expression }) => {
      const result = analyze(
        `${header}
      ${imports}
      export const run = (raw) => {
        const schema = ${schema};
        ${prepare}
        const parsed = ${expression};
        parsed.some(() => write({type: "write", tx: rootDb, table: flowRuns}));
        rootDb.delete(flowRuns);
      };
    `,
        helper,
      );
      expect(result.hits.map(({ operation }) => operation).toSorted()).toEqual([
        "delete",
        "update",
      ]);
    },
  );

  test("Valibot array parsing leaves success and failure paths reachable", () => {
    const result = analyze(
      `${header}
      import * as v from "valibot";
      export const run = (raw) => {
        const parsed = v.safeParse(v.array(v.string()), raw);
        if (!parsed.success) {
          rootDb.delete(flowRuns);
          return;
        }
        parsed.output.forEach(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation).toSorted()).toEqual([
      "delete",
      "update",
    ]);
  });

  test.each(["some", "forEach"])(
    "unguarded failed safeParse output cannot dispatch native %s callbacks",
    (method) => {
      expect(() =>
        analyze(
          `${header}
      import * as v from "valibot";
      export const run = (raw) => {
        v.safeParse(v.array(v.string()), raw).output.${method}(() => write({type: "write", tx: rootDb, table: flowRuns}));
        rootDb.delete(flowRuns);
      };
    `,
          helper,
        ),
      ).toThrow(/unresolved callable/iu);
    },
  );

  test.each(["return", 'throw new Error("invalid")'])(
    "an immediately rejecting native result branch preserves failure effects and following callback effects: %s",
    (terminal) => {
      const result = analyze(
        `${header}
      import * as v from "valibot";
      export const run = (raw) => {
        const parsed = v.safeParse(v.array(v.string()), raw);
        if (!parsed.success) {
          rootDb.delete(flowRuns);
          ${terminal};
        }
        parsed.output.some(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
        helper,
      );
      expect(result.hits.map(({ operation }) => operation).toSorted()).toEqual([
        "delete",
        "update",
      ]);
    },
  );

  test.each([
    "if (!other.success) {return;}",
    "if (parsed.success) {return;}",
    "if (!parsed.success) {if (flag) return;}",
  ])(
    "a wrong or conditional rejection cannot prove native output callbacks: %s",
    (guard) => {
      expect(() =>
        analyze(
          `${header}
      import * as v from "valibot";
      export const run = (raw, different, flag) => {
        const parsed = v.safeParse(v.array(v.string()), raw);
        const other = v.safeParse(v.array(v.string()), different);
        ${guard}
        parsed.output.forEach(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
          helper,
        ),
      ).toThrow(/unresolved callable/iu);
    },
  );

  test.each(["parsed.output = raw;", "observe();"])(
    "intervening statements prevent a native success proof from reaching callback dispatch: %s",
    (statement) => {
      expect(() =>
        analyze(
          `${header}
      import * as v from "valibot";
      const observe = () => true;
      export const run = (raw) => {
        const parsed = v.safeParse(v.array(v.string()), raw);
        if (!parsed.success) return;
        ${statement}
        parsed.output.forEach(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
          helper,
        ),
      ).toThrow(/unresolved callable/iu);
    },
  );

  test("a native success proof cannot cross into an escaped callback body", () => {
    expect(() =>
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = (raw) => {
        const parsed = v.safeParse(v.array(v.string()), raw);
        const later = () => parsed.output.forEach(() => write({type: "write", tx: rootDb, table: flowRuns}));
        if (!parsed.success) return;
        later();
      };
    `,
        helper,
      ),
    ).toThrow(/unresolved callable/iu);
  });

  test("same-statement replacement cannot borrow another native result's success", () => {
    expect(() =>
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = (raw, different) => {
        const holder = {parsed: v.safeParse(v.array(v.string()), raw)};
        const other = v.safeParse(v.array(v.string()), different);
        if (!holder.parsed.success) return;
        (holder.parsed = other, holder.parsed.output.forEach(() => write({type: "write", tx: rootDb, table: flowRuns})));
      };
    `,
        helper,
      ),
    ).toThrow(/unresolved callable/iu);
  });

  test("effectful callback arguments cannot extend native receiver success proof", () => {
    expect(() =>
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = (raw, different) => {
        const holder = {parsed: v.safeParse(v.array(v.string()), raw)};
        const other = v.safeParse(v.array(v.string()), different);
        const choose = () => {holder.parsed = other; return () => write({type: "write", tx: rootDb, table: flowRuns});};
        if (!holder.parsed.success) return;
        holder.parsed.output.forEach(choose());
      };
    `,
        helper,
      ),
    ).toThrow(/unresolved callable/iu);
  });

  test("nested modeled Valibot arrays preserve native output shape", () => {
    expect(
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = (raw) => v.parse(v.array(v.array(v.string())), raw)
        .forEach((values) => values.forEach(() => write({type: "write", tx: rootDb, table: flowRuns})));
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each(["safeParse", "parse"])(
    "Valibot %s never erases known input capabilities",
    (parse) => {
      for (const value of [
        "rootDb",
        "[{tx: rootDb}]",
        "[() => rootDb.delete(flowRuns)]",
        "new Set([{tx: rootDb}])",
      ]) {
        expect(() =>
          analyze(
            `${header}
        import * as v from "valibot";
        export const run = () => v.${parse}(v.array(v.string()), ${value});
      `,
            helper,
          ),
        ).toThrow(
          /Valibot validation receives a transaction capability or callable/iu,
        );
      }
    },
  );

  test("Valibot array schemas reject capability-bearing schema arguments", () => {
    expect(() =>
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = () => v.array({tx: rootDb});
    `,
        helper,
      ),
    ).toThrow(
      /Valibot array schema receives a transaction capability or callable/iu,
    );
  });

  test.each([
    { label: "object", schema: "v.object({name: v.string()})" },
    { label: "record", schema: "v.record(v.string(), v.string())" },
    {
      label: "variant",
      schema:
        'v.variant("type", [v.object({type: v.literal("known"), value: v.string()})])',
    },
    {
      label: "pipe and string validations",
      schema: "v.pipe(v.string(), v.minLength(1), v.maxLength(32))",
    },
    { label: "optional", schema: "v.optional(v.string())" },
    { label: "picklist", schema: 'v.picklist(["read", "write"])' },
    { label: "boolean", schema: "v.boolean()" },
    { label: "number", schema: "v.number()" },
    { label: "literal", schema: 'v.literal("known")' },
    {
      label: "integer and numeric bounds",
      schema: "v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10))",
    },
    { label: "unknown", schema: "v.unknown()" },
  ])("Valibot $label builders do not grant string output", ({ schema }) => {
    expect(
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = (raw) => {
        const parsed = v.parse(${schema}, raw);
        if (typeof parsed !== "string") write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each(["parse", "safeParse"])(
    "Valibot %s preserves direct string fields in fresh object outputs",
    (parse) => {
      const read =
        parse === "parse"
          ? "const output = v.parse(schema, raw);"
          : "const parsed = v.safeParse(schema, raw); if (!parsed.success) return null; const output = parsed.output;";
      const result = analyze(
        `${header}
      import * as v from "valibot";
      export const run = (raw) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const schema = v.object({id: v.string(), child: v.object({name: v.string()})});
        ${read}
        const [domain, ...tail] = output.id.split(".");
        output.child.name.toLowerCase();
        for (const segment of tail) segment.toUpperCase();
      };
    `,
        helper,
      );
      expect(result.hits).toHaveLength(0);
    },
  );

  test.each(["v.optional(v.string())", "v.unknown()"])(
    "object validation preserves possible absence of %s",
    (child) => {
      const result = analyze(
        `${header}
      import * as v from "valibot";
      export const run = (raw) => {
        const output = v.parse(v.object({name: ${child}}), raw);
        if (!Object.hasOwn(output, "name")) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      );
      expect(result.hits).toHaveLength(1);
    },
  );

  test.each([
    'const [name] = flag ? ["safe"] : [];',
    'const {name} = flag ? {name: "safe"} : {name: undefined};',
    'const {child: [name]} = {child: flag ? ["safe"] : []};',
  ])(
    "a guarded destructured const retains its non-nullish value: %s",
    (declaration) => {
      const result = analyze(
        `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${declaration}
        if (name === undefined || name === null || flag) return null;
        name.toLowerCase();
      };
    `,
        helper,
      );
      expect(result.hits).toHaveLength(0);
    },
  );

  test.each([
    [
      "v.array(v.string())",
      "output.items?.flatMap((item) => [item.toUpperCase()]);",
    ],
    ["v.object({name: v.string()})", "output.items?.name.toUpperCase();"],
  ])(
    "optional native containers retain their validated child outputs: %s",
    (schema, read) => {
      const result = analyze(
        `${header}
      import * as v from "valibot";
      export const run = (raw) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const output = v.parse(v.object({items: v.optional(${schema})}), raw);
        ${read}
      };
    `,
        helper,
      );
      expect(result.hits).toHaveLength(0);
    },
  );

  test("a local validated string return retains its type after a null exit", () => {
    const result = analyze(
      `${header}
      const refName = (node) => {
        const ref = node["$ref"];
        if (Object.keys(node).length !== 1 || typeof ref !== "string" || !ref.startsWith("#/$defs/")) return null;
        const name = ref.slice("#/$defs/".length);
        return name.length === 0 || name.includes("/") ? null : name;
      };
      export const run = (raw) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const name = refName(raw);
        if (name === null) return null;
        Object.hasOwn({}, name);
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(0);
  });

  test.each([
    'const value = raw; if (typeof value === "string") return null; Object.hasOwn({}, value);',
    'const value = raw; const other = raw; if (typeof other !== "string") return null; Object.hasOwn({}, value);',
    'let value = raw; if (typeof value !== "string") return null; Object.hasOwn({}, value);',
    'const value = raw; const read = () => Object.hasOwn({}, value); if (typeof value !== "string") return null; read();',
  ])(
    "a string exit guard does not lend proof outside its immutable binding: %s",
    (body) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (raw) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${body}
      };
    `,
          helper,
        ),
      ).toThrow(/Object.hasOwn key requires/iu);
    },
  );

  test.each(["const [value] = [raw];", "const {value} = {value: raw};"])(
    "string exit proofs apply to destructured const bindings: %s",
    (declaration) => {
      const result = analyze(
        `${header}
      export const run = (raw) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${declaration}
        if (typeof value !== "string") return null;
        Object.hasOwn({}, value);
      };
    `,
        helper,
      );
      expect(result.hits).toHaveLength(0);
    },
  );

  test.each(["'parts'", "rawKey"])(
    "computed opaque data reads retain data provenance: %s",
    (key) => {
      const result = analyze(
        `${header}
      export const run = (raw, rawKey) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const key = ${key};
        const value = raw[key];
        if (Array.isArray(value)) {
          const output = [];
          for (const item of value) output.push(item);
        }
      };
    `,
        helper,
      );
      expect(result.hits).toHaveLength(0);
    },
  );

  test.each([
    { source: "[scoped]", expected: [] },
    { source: "[rootDb]", expected: ["delete"] },
  ])(
    "a native array branch filters non-array const alternatives: $source",
    ({ source, expected }) => {
      const result = analyze(
        `${header}
      export const run = (flag) => withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
        write({type: "write", tx: scoped, table: flowRuns});
        const values = flag ? ${source} : undefined;
        if (Array.isArray(values)) {
          const output = [];
          for (const tx of values) { output.push("seen"); tx.delete(flowRuns); }
        }
        return null;
      }});
    `,
        helper,
      );
      expect(result.hits.map(({ operation }) => operation)).toEqual([
        ...expected,
      ]);
    },
  );

  test("a native array branch filters non-array parameter alternatives", () => {
    const result = analyze(
      `${header}
      const iterate = (values) => {
        if (Array.isArray(values)) {
          const output = [];
          for (const tx of values) {output.push("seen"); tx.delete(flowRuns);}
        }
      };
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        iterate(flag ? [rootDb] : undefined);
      };
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test.each([
    "globalThis.eval('Array.isArray = () => true');",
    "const evaluate = globalThis.eval; evaluate('Array.isArray = () => true');",
    "globalThis.Function('Array.isArray = () => true')();",
    "new globalThis.Function('Array.isArray = () => true')();",
  ])(
    "native code evaluation cannot preserve interpreter intrinsic identities: %s",
    (evaluation) => {
      expect(() =>
        analyze(
          `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const operations = new Set([{type: "write", tx: rootDb, table: flowRuns}]);
        ${evaluation}
        if (Array.isArray(operations)) for (const operation of operations) write(operation);
      };
    `,
          helper,
        ),
      ).toThrow(/native code evaluation requires an explicit owner model/iu);
    },
  );

  test("a stable parameter record rejection excludes primitive alternatives", () => {
    const result = analyze(
      `${header}
      const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
      const keys = (value) => {
        if (!isRecord(value)) return [];
        return Object.keys(value);
      };
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        keys(flag ? {name: "safe"} : undefined);
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(0);
  });

  test.each([
    { source: "{tx: scoped}", expected: [] },
    { source: "{tx: rootDb}", expected: ["delete"] },
  ])(
    "a stable record parameter retains its actual value authority: $source",
    ({ source, expected }) => {
      const result = analyze(
        `${header}
      const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
      const remove = (value) => {
        if (!isRecord(value)) return null;
        for (const tx of Object.values(value)) tx.delete(flowRuns);
      };
      export const run = (flag) => withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
        write({type: "write", tx: scoped, table: flowRuns});
        remove(flag ? ${source} : undefined);
        return null;
      }});
    `,
        helper,
      );
      expect(result.hits.map(({ operation }) => operation)).toEqual([
        ...expected,
      ]);
    },
  );

  test.each([
    "const inspect = (value) => {const read = () => Object.keys(value); if (!isRecord(value)) return []; return read();};",
    "const inspect = (input) => {let value = input; if (!isRecord(value)) return []; return Object.keys(value);};",
    "const inspect = (value) => {const other = {}; if (!isRecord(other)) return []; return Object.keys(value);};",
  ])(
    "record exit proof stays with its stable local read: %s",
    (declaration) => {
      expect(() =>
        analyze(
          `${header}
      const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
      ${declaration}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        inspect(flag ? {} : undefined);
      };
    `,
          helper,
        ),
      ).toThrow(/Object.keys requires a non-null input/iu);
    },
  );

  test.each(["node:vm", "vm"])(
    "native evaluator module %s requires an explicit owner",
    (module) => {
      expect(() =>
        analyze(
          `${header}
      import {runInThisContext} from "${module}";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        runInThisContext("Array.isArray = () => true");
      };
    `,
          helper,
        ),
      ).toThrow(/native code evaluation requires an explicit owner model/iu);
    },
  );

  test("composing a Valibot string schema leaves the original schema intact", () => {
    const result = analyze(
      `${header}
      import * as v from "valibot";
      export const run = (raw) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const base = v.string();
        v.pipe(base, v.minLength(1));
        v.parse(base, raw).toLowerCase();
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toContain(owner);
    expect(result.hits).toHaveLength(0);
  });

  test.each([
    {
      label: "object entry capability",
      expression: "v.object({token: rootDb})",
    },
    {
      label: "record value capability",
      expression: "v.record(v.string(), rootDb)",
    },
    {
      label: "variant callback",
      expression:
        'v.variant("type", [v.object({type: v.literal("known"), onSelect: () => write({type: "write", tx: rootDb, table: flowRuns})})])',
    },
    {
      label: "pipe callback",
      expression:
        'v.pipe(v.string(), () => write({type: "write", tx: rootDb, table: flowRuns}))',
    },
  ])("Valibot $label arguments are refused", ({ expression }) => {
    expect(() =>
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = () => ${expression};
    `,
        helper,
      ),
    ).toThrow(/Valibot schema factory .*transaction capability.*callable/iu);
  });

  test("Valibot builders reject a native identity stored in their schema inputs", () => {
    expect(() =>
      analyze(
        `${header}
      import * as v from "valibot";
      import {readFileSync} from "node:fs";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        v.object({reader: readFileSync});
      };
    `,
        helper,
      ),
    ).toThrow(/Valibot schema factory .*native identity/iu);
  });

  test("Valibot optional does not retain a mutable object default", () => {
    expect(() =>
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        v.optional(v.unknown(), []);
      };
    `,
        helper,
      ),
    ).toThrow(/Valibot optional default cannot alias mutable data/iu);
  });

  test("Valibot unknown output does not grant array callback dispatch", () => {
    expect(() =>
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = (raw) => v.safeParse(v.unknown(), raw).output
        .some(() => write({type: "write", tx: rootDb, table: flowRuns}));
    `,
        helper,
      ),
    ).toThrow(/unresolved delegate.*receives a transaction or callable/iu);
  });

  test("shadowed Valibot namespace methods retain their actual delegated values", () => {
    expect(
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = () => {
        const v = {
          array: (schema) => schema,
          safeParse: (_schema, value) => ({success: true, output: value}),
        };
        v.safeParse(v.array({}), [{type: "write", tx: rootDb, table: flowRuns}])
          .output.forEach(write);
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("local parse bindings retain their actual delegated values", () => {
    expect(
      analyze(
        `${header}
      import { parse } from "valibot";
      export const run = () => {
        const parse = (_schema, value) => value;
        parse({}, [{type: "write", tx: rootDb, table: flowRuns}]).forEach(write);
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each(["push", "unshift", "splice"])(
    "%s cannot retain a scoped capability in a mutable container",
    (method) => {
      const args = method === "splice" ? "0, 0, tx" : "tx";
      expect(() =>
        analyze(
          `${header}
      export const run = async () => {
        const retained = [];
        await withOrgScope({tx: rootDb, scope, actor, fn: (tx) => { retained.${method}(${args}); }});
        retained.forEach((tx) => write({type: "write", tx, table: flowRuns}));
      };
    `,
          helper,
        ),
      ).toThrow(/scoped.*mutable.*container/iu);
    },
  );

  test("a scoped immutable collection stays inside its callback", () => {
    expect(
      analyze(
        `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {
        const operations = [{type: "write", tx, table: flowRuns}];
        operations.forEach((operation) => write(operation));
      }});
    `,
        helper,
      ).hits,
    ).toHaveLength(0);
  });

  test.each(["values", "holder.required"])(
    "native array guard proves only its immediate true-arm receiver: %s",
    (reference) => {
      expect(
        analyze(
          `${header}
      export const run = (values, holder) => Array.isArray(${reference})
        ? ${reference}.filter(() => write({type: "write", tx: rootDb, table: flowRuns}))
        : [];
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("renamed native array predicates retain their actual identity", () => {
    expect(
      analyze(
        `${header}
      const isArray = Array.isArray;
      export const run = (value) => isArray(value)
        ? value.some(() => write({type: "write", tx: rootDb, table: flowRuns}))
        : false;
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("native array guard retains actual transaction-bearing array alternatives", () => {
    expect(
      analyze(
        `${header}
      export const run = (flag) => {
        const operations = flag ? [{type: "write", tx: rootDb, table: flowRuns}] : null;
        return Array.isArray(operations) ? operations.forEach(write) : undefined;
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    "Array.isArray(other) ? value.filter(callback) : []",
    "Array.isArray(value) ? [] : value.filter(callback)",
    "Array.isArray(value) ? (observe(), value.filter(callback)) : []",
    "Array.isArray(value, observe()) ? value.filter(callback) : []",
  ])(
    "array guard does not grant unrelated or effect-separated provenance: %s",
    (expression) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (value, other) => {
        const observe = () => undefined;
        const callback = () => write({type: "write", tx: rootDb, table: flowRuns});
        return ${expression};
      };
    `,
          helper,
        ),
      ).toThrow(/receives a transaction or callable/iu);
    },
  );

  test("a local array predicate cannot mint native receiver provenance", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = (value) => {
        const Array = {isArray: () => true};
        return Array.isArray(value)
          ? value.filter(() => write({type: "write", tx: rootDb, table: flowRuns}))
          : [];
      };
    `,
        helper,
      ),
    ).toThrow(/receives a transaction or callable/iu);
  });

  test.each(["block", "direct"] as const)(
    "native array if-guard proves its first return receiver: %s",
    (body) => {
      const returned =
        'return value.filter(() => write({type: "write", tx: rootDb, table: flowRuns}));';
      expect(
        analyze(
          `${header}
      export const run = (value) => {
        if (Array.isArray(value)) ${body === "block" ? `{${returned}}` : returned}
        return [];
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("native array if-guard retains transaction-bearing array alternatives", () => {
    expect(
      analyze(
        `${header}
      export const run = (flag) => {
        const holder = {operations: flag ? [{type: "write", tx: rootDb, table: flowRuns}] : null};
        if (Array.isArray(holder.operations)) {
          return holder.operations.forEach(write);
        }
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    "if (Array.isArray(other)) { return value.filter(callback); }",
    "if (Array.isArray(value)) {} else { return value.filter(callback); }",
    "if (Array.isArray(value)) { return (() => value.filter(callback))(); }",
  ])(
    "array if-guard does not grant provenance across unrelated paths or effects: %s",
    (body) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (value, other) => {
        const observe = () => undefined;
        const callback = () => write({type: "write", tx: rootDb, table: flowRuns});
        ${body}
        return [];
      };
    `,
          helper,
        ),
      ).toThrow(/receives a transaction or callable/iu);
    },
  );

  test("a shadowed array if-predicate cannot mint native provenance", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = (value) => {
        const Array = {isArray: () => true};
        if (Array.isArray(value)) {
          return value.filter(() => write({type: "write", tx: rootDb, table: flowRuns}));
        }
      };
    `,
        helper,
      ),
    ).toThrow(/receives a transaction or callable/iu);
  });

  test("a stable array branch preserves callback effects after a source call", () => {
    const result = analyze(
      `${header}
      export const run = (value) => {
        const observe = () => undefined;
        const callback = () => write({type: "write", tx: rootDb, table: flowRuns});
        if (Array.isArray(value)) {observe(); return value.filter(callback);}
        return [];
      };
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation)).toEqual(["update"]);
  });

  test.each([
    "let values = flag ? [] : undefined; if (Array.isArray(values)) {for (const item of values) {}}",
    "const values = flag ? [] : undefined; const Array = {isArray: () => true}; if (Array.isArray(values)) {for (const item of values) {}}",
    "const holder = {values: flag ? [] : undefined}; if (Array.isArray(holder.values)) {for (const item of holder.values) {}}",
    "const values = flag ? [] : undefined; const iterate = () => {for (const item of values) {}}; if (Array.isArray(values)) iterate();",
  ])(
    "array branch proof stays within its native stable binding: %s",
    (body) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${body}
      };
    `,
          helper,
        ),
      ).toThrow(/unsupported for-of iterable/iu);
    },
  );

  test("native Set add returns its receiver and retains raw transaction values", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const operations = new Set();
        const same = operations.add({type: "write", tx: rootDb, table: flowRuns});
        for (const operation of same) write(operation);
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each(["delete(operation)", "clear()"])(
    "native Set %s retains values reachable on another branch",
    (mutation) => {
      expect(
        analyze(
          `${header}
      export const run = (flag) => {
        const operation = {type: "write", tx: rootDb, table: flowRuns};
        const operations = new Set([operation]);
        if (flag) operations.${mutation};
        for (const candidate of operations) write(candidate);
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("native Set mutations retain callable captures", () => {
    expect(
      analyze(
        `${header}
      export const run = (flag) => {
        const callback = () => write({type: "write", tx: rootDb, table: flowRuns});
        const callbacks = new Set();
        callbacks.add(callback);
        if (flag) callbacks.delete(callback);
        if (flag) callbacks.clear();
        for (const call of callbacks) call();
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each(["has", "delete"])(
    "native Set %s uses exact fixed literal membership",
    (method) => {
      for (const [needle, count] of [
        ["present", 1],
        ["missing", 0],
      ] as const) {
        const result = analyze(
          `${header}
        export const run = () => {
          withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {
            write({type: "write", tx, table: flowRuns});
            return null;
          }});
          const values = new Set(["present"]);
          if (values.${method}("${needle}")) write({type: "write", tx: rootDb, table: flowRuns});
        };
      `,
          helper,
        );
        expect(result.reachedRecoveryOwners).toEqual([owner]);
        expect(result.hits).toHaveLength(count);
      }
    },
  );

  test.each(["has", "delete", "clear"])(
    "native Set %s does not invoke callable search or ignored arguments",
    (method) => {
      expect(
        analyze(
          `${header}
      export const run = () => {
        const values = new Set();
        values.${method}(() => rootDb.delete(flowRuns));
        return write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("mutable native Set membership retains possible write paths", () => {
    expect(
      analyze(
        `${header}
      export const run = (flag) => {
        const values = new Set();
        if (flag) values.add("present");
        if (values.has("present")) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("native Set clear returns undefined and omitted add stores undefined", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const values = new Set();
        if (values.clear()) rootDb.delete(flowRuns);
        values.add();
        for (const value of values) {
          if (value === undefined) write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    "tx",
    "() => write({type: 'write', tx, table: flowRuns})",
    "{prepared: tx.update(flowRuns).set({status: 'running'})}",
  ])(
    "native Set add rejects a scoped mutable-container escape: %s",
    (value) => {
      expect(() =>
        analyze(
          `${header}
      export const run = async () => {
        const values = new Set();
        await withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {values.add(${value}); return null;}});
      };
    `,
          helper,
        ),
      ).toThrow(/scoped capability cannot enter a mutable container/iu);
    },
  );

  test.each(["add", "has", "delete", "clear"])(
    "a user-defined %s method retains its actual writes",
    (method) => {
      expect(
        analyze(
          `${header}
      const receiver = {${method}: () => write({type: "write", tx: rootDb, table: flowRuns})};
      export const run = () => receiver.${method}();
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test.each(["insert", "update", "delete"])(
    "known object %s delegates retain actual transaction arguments",
    (method) => {
      expect(
        analyze(
          `${header}
      const receiver = {${method}: (operation) => write(operation)};
      export const run = () => receiver.${method}({type: "write", tx: rootDb, table: flowRuns});
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test.each(["union(new Set())", "[method]()"])(
    "unsupported native Set methods stay fail closed: %s",
    (method) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (method) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {
          write({type: "write", tx, table: flowRuns});
          return null;
        }});
        const values = new Set();
        values${method.startsWith("[") ? "" : "."}${method};
      };
    `,
          helper,
        ),
      ).toThrow(/(?:unsupported|dynamic) native Set method/iu);
    },
  );

  test("native Set insertion retains its finite domain guard", () => {
    const additions = Array.from(
      { length: 129 },
      (_, index) => `values.add("value-${index}");`,
    ).join("\n");
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {
          write({type: "write", tx, table: flowRuns});
          return null;
        }});
        const values = new Set();
        ${additions}
      };
    `,
        helper,
      ),
    ).toThrow(/abstract mutable Set exceeds its finite domain/iu);
  });

  test("native Object.keys data supports callback writes without invoking stored values", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        const source = {tx: rootDb, callback: () => rootDb.delete(flowRuns)};
        return Object.keys(source).find((key) => {
          if (key === "tx") write({type: "write", tx: rootDb, table: flowRuns});
          return false;
        });
      };
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation)).toEqual(["update"]);
  });

  test("native Object.keys returns only data from scoped value properties", () => {
    expect(
      analyze(
        `${header}
      export const run = async () => {
        const keys = await withOrgScope({tx: rootDb, scope, actor, fn: (tx) => Object.keys({tx})});
        return keys.forEach(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("native Object.keys preserves argument evaluation writes", () => {
    expect(
      analyze(
        `${header}
      const source = () => {rootDb.delete(flowRuns); return {value: true};};
      export const run = () => Object.keys(source()).forEach(() => write({type: "write", tx: rootDb, table: flowRuns}));
    `,
        helper,
      ).hits,
    ).toHaveLength(2);
  });

  test("native Object.keys uses exact closed-object key ordering", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const keys = Object.keys({z: 0, "10": 0, "2": 0, a: 0});
        if (keys.at(0) === "2") rootDb.update(flowRuns);
        if (keys.at(1) === "10") rootDb.delete(flowRuns);
        if (keys.includes("absent")) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation).toSorted()).toEqual([
      "delete",
      "update",
    ]);
  });

  test.each(["value", "open", "[,]"])(
    "native Object.keys keeps uncertain extent mutable: %s",
    (value) => {
      expect(
        analyze(
          `${header}
      export const run = (value) => {
        const open = {known: true};
        open[value] = true;
        return Object.keys(${value}).forEach(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test.each(["source", "{...source}"])(
    "native Object.keys retains optional keys after mutation: %s",
    (value) => {
      expect(
        analyze(
          `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const source = {};
        if (flag) source.extra = true;
        if (!Object.keys(${value}).includes("extra")) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("native Object.keys keeps keys from union spreads optional", () => {
    expect(
      analyze(
        `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const source = flag ? {a: true} : {b: true};
        if (!Object.keys({...source}).includes("a")) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("native Object.keys does not assume a prototype initializer is an own key", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const source = {__proto__: {value: true}};
        if (!Object.keys(source).includes("__proto__")) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("native Object.keys aliases preserve the bound global identity", () => {
    expect(
      analyze(
        `${header}
      const keys = Object.keys;
      export const run = () => keys({key: true}).forEach(() => write({type: "write", tx: rootDb, table: flowRuns}));
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each(["namespace", "alias"])(
    "shadowed Object.keys %s keeps actual transaction-valued output",
    (binding) => {
      const local =
        binding === "namespace"
          ? "const Object = {keys: (operation) => [operation]};"
          : "const keys = (operation) => [operation];";
      const call = binding === "namespace" ? "Object.keys" : "keys";
      expect(
        analyze(
          `${header}
      const keys = Object.keys;
      export const run = () => {
        ${local}
        return ${call}({type: "write", tx: rootDb, table: flowRuns}).forEach(write);
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("unrelated external keys exports cannot erase transaction values", () => {
    expect(() =>
      analyze(
        `${header}
      import {keys} from "unrelated-library";
      export const run = () => keys({type: "write", tx: rootDb, table: flowRuns});
    `,
        helper,
      ),
    ).toThrow(/receives a transaction or callable/iu);
  });

  test("native Object.keys never projects object values as callable keys", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const source = {callback: () => rootDb.delete(flowRuns)};
        Object.keys(source).forEach((key) => {if (key === "callback") write({type: "write", tx: rootDb, table: flowRuns});});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    { operator: "&&", prefix: "" },
    { operator: "||", prefix: "!" },
  ] as const)(
    "native array guard proves an immediate $prefix predicate $operator receiver",
    ({ operator, prefix }) => {
      for (const reference of ["value", "holder.values"]) {
        expect(
          analyze(
            `${header}
        export const run = (value, holder) => ${prefix}Array.isArray(${reference}) ${operator}
          ${reference}.every(() => write({type: "write", tx: rootDb, table: flowRuns}));
      `,
            helper,
          ).hits,
        ).toHaveLength(1);
      }
    },
  );

  test.each([
    { operator: "&&", prefix: "" },
    { operator: "||", prefix: "!" },
  ] as const)(
    "logical array guard $operator retains actual transaction-bearing alternatives",
    ({ operator, prefix }) => {
      expect(
        analyze(
          `${header}
      export const run = (flag) => {
        const values = flag ? [{type: "write", tx: rootDb, table: flowRuns}] : null;
        return ${prefix}Array.isArray(values) ${operator} values.every(write);
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("logical array guard follows a renamed native predicate", () => {
    expect(
      analyze(
        `${header}
      const isArray = Array.isArray;
      export const run = (values) => isArray(values) && values.some(() => write({type: "write", tx: rootDb, table: flowRuns}));
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    "Array.isArray(other) && value.every(callback)",
    "!Array.isArray(other) || value.every(callback)",
    "Array.isArray(value) || value.every(callback)",
    "!Array.isArray(value) && value.every(callback)",
    "(Array.isArray(value), observe()) && value.every(callback)",
    "Array.isArray(value) && (observe(), value.every(callback))",
    "!Array.isArray(value) || (observe(), value.every(callback))",
    "Array.isArray(value, observe()) && value.every(callback)",
  ])(
    "logical array guard rejects unrelated, negative or effect-separated proofs: %s",
    (expression) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (value, other) => {
        const observe = () => true;
        const callback = () => write({type: "write", tx: rootDb, table: flowRuns});
        return ${expression};
      };
    `,
          helper,
        ),
      ).toThrow(/receives a transaction or callable/iu);
    },
  );

  test.each([
    { operator: "&&", prefix: "" },
    { operator: "||", prefix: "!" },
  ] as const)(
    "shadowed logical array predicate cannot mint $operator provenance",
    ({ operator, prefix }) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (value) => {
        const Array = {isArray: () => true};
        return ${prefix}Array.isArray(value) ${operator}
          value.every(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
          helper,
        ),
      ).toThrow(/receives a transaction or callable/iu);
    },
  );

  test("closed absent optional fields select an empty iterable fallback", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const sub = {};
        for (const item of [...(sub?.required ?? [])]) write(item);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("optional metadata chains retain present and missing iterable branches", () => {
    expect(
      analyze(
        `${header}
      export const run = (key) => {
        const annotations = {present: {discriminator: {subcommands: {create: {required: ["name"]}}}}, absent: {}};
        const annotation = annotations[key];
        const sub = annotation?.discriminator?.subcommands[key];
        const required = new Set([...(sub?.required ?? [])]);
        for (const value of required) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each(["null", "undefined"])(
    "nullish union with %s retains actual transaction values and fallback effects",
    (missing) => {
      expect(
        analyze(
          `${header}
      export const run = (flag) => {
        const selected = flag ? [{type: "write", tx: rootDb, table: flowRuns}] : ${missing};
        const fallback = () => {rootDb.delete(flowRuns); return [];};
        for (const operation of [...(selected ?? fallback())]) write(operation);
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(2);
    },
  );

  test("optional chains do not erase the empty fallback alternative", () => {
    expect(
      analyze(
        `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const selected = flag ? {items: ["present"]} : undefined;
        const items = selected?.items ?? [];
        if (!items.includes("present")) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("optional iterable chains retain actual transaction-bearing elements", () => {
    expect(
      analyze(
        `${header}
      export const run = (flag) => {
        const selected = flag ? {config: {items: [{type: "write", tx: rootDb, table: flowRuns}]}} : {};
        for (const operation of [...(selected?.config?.items ?? [])]) write(operation);
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("known non-null iterables skip nullish fallback effects", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const fallback = () => {rootDb.delete(flowRuns); return [];};
        for (const operation of ([{type: "write", tx: rootDb, table: flowRuns}] ?? fallback())) write(operation);
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("nullish fallback never grants unknown values iterable provenance", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = (value) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        return [...(value ?? [])];
      };
    `,
        helper,
      ),
    ).toThrow(/unsupported unknown\/custom iterable expansion/iu);
  });

  test("an absent optional receiver skips computed keys and call arguments", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const absent = undefined;
        absent?.[rootDb.delete(flowRuns)];
        absent?.method(rootDb.delete(flowRuns));
        absent?.(rootDb.delete(flowRuns));
        return write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("partial native result shapes do not claim absent runtime fields", () => {
    expect(
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = (raw) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const parsed = v.safeParse(v.array(v.string()), raw);
        if (parsed.issues !== undefined) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("a missing ordinary callable stays fail closed", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        return {}.missing();
      };
    `,
        helper,
      ),
    ).toThrow(/unresolved callable/iu);
  });

  test("unmodeled inherited iterable properties stay fail closed", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        const source = {__proto__: {items: [{type: "write", tx: rootDb, table: flowRuns}]}};
        for (const operation of [...(source?.items ?? [])]) write(operation);
      };
    `,
        helper,
      ),
    ).toThrow(/prototype initializer carries a transaction or callable/iu);
  });

  test.each(["holder", "{...holder}"])(
    "conditional spread keeps an optionally absent array field: %s",
    (source) => {
      expect(
        analyze(
          `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const holder = {...(flag ? {required: ["present"]} : {})};
        const selected = ${source};
        const required = selected.required ?? [];
        if (!required.includes("present")) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test.each(["holder.required", "alias.required", "holder[key]"])(
    "conditional mutation preserves an absent array field: %s",
    (target) => {
      const outcome = Result.try({
        try: () =>
          analyze(
            `${header}
      export const run = (flag, key) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const holder = {};
        const alias = holder;
        if (flag) ${target} = ["present"];
        const required = holder.required ?? [];
        if (!required.includes("present")) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
            helper,
          ),
        catch: (error) => error,
      });
      if (outcome.isErr()) {
        expect(target).toBe("holder[key]");
        if (!Panic.is(outcome.error)) {
          panic("Computed mutation produced an unexpected error type");
        }
        expect(outcome.error.message).toContain(
          "unresolved callable: unresolved member includes",
        );
        return;
      }
      expect(outcome.value.hits).toHaveLength(1);
    },
  );

  test("optional spread retains a guaranteed prior field value", () => {
    expect(
      analyze(
        `${header}
      export const run = (flag) => {
        const holder = {required: ["prior"], ...(flag ? {required: ["next"]} : {})};
        if (!holder.required.includes("prior")) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("unmodeled property deletion cannot silently retain a present array field", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const holder = {required: ["present"]};
        delete holder.required;
        if (!(holder.required ?? []).includes("present")) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ),
    ).toThrow(/unmodeled delete mutation/iu);
  });

  test("mixed optional calls retain their nullish fallback write", () => {
    expect(
      analyze(
        `${header}
      export const run = (flag) => {
        const receiver = flag ? {call: () => true} : undefined;
        return receiver?.call() ?? write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("live optional call alternatives retain argument effects and actual callable bodies", () => {
    expect(
      analyze(
        `${header}
      export const run = (flag) => {
        const receiver = flag ? {call: () => write({type: "write", tx: rootDb, table: flowRuns})} : undefined;
        receiver?.call(rootDb.delete(flowRuns));
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(2);
  });

  test("dynamic writes cannot make a guaranteed array field absent", () => {
    expect(
      analyze(
        `${header}
      export const run = (key) => {
        const holder = {required: ["present"]};
        holder[key] = ["other"];
        for (const value of holder.required) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    "Array.isArray(values)",
    'Array.isArray(values) && values.every((value) => typeof value === "string")',
  ])(
    "a native guarded array return preserves iterable data provenance: %s",
    (condition) => {
      expect(
        analyze(
          `${header}
      const validated = (values) => ${condition} ? values : undefined;
      export const run = (raw) => {
        for (const value of validated(raw) ?? []) {
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("a guarded array return retains actual transaction and callable values", () => {
    expect(
      analyze(
        `${header}
      const validated = (values) => Array.isArray(values) && values.every((value) => typeof value === "function") ? values : undefined;
      export const run = () => {
        const operation = {type: "write", tx: rootDb, table: flowRuns};
        const callbacks = [() => write(operation)];
        for (const callback of validated(callbacks) ?? []) callback();
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    'Array.isArray(values) && values.every((value) => (observe(), typeof value === "string")) ? values : undefined',
    'Array.isArray(values) && values.every((value) => typeof value.field === "string") ? values : undefined',
    'Array.isArray(values) && values.every((value) => typeof value === "string") ? other : undefined',
  ])(
    "a guarded array return rejects effects or unrelated references: %s",
    (expression) => {
      expect(() =>
        analyze(
          `${header}
      const validated = (values, other) => {const observe = () => true; return ${expression};};
      export const run = (raw, other) => {
        for (const value of [...(validated(raw, other) ?? [])]) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
          helper,
        ),
      ).toThrow(/unsupported unknown\/custom iterable expansion/iu);
    },
  );

  test("a local predicate cannot mint guarded return provenance", () => {
    expect(() =>
      analyze(
        `${header}
      const Array = {isArray: () => true};
      const validated = (values) => Array.isArray(values) ? values : undefined;
      export const run = (raw) => {
        for (const value of [...(validated(raw) ?? [])]) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ),
    ).toThrow(/unsupported unknown\/custom iterable expansion/iu);
  });

  test.each([
    "!Array.isArray(values)",
    "!Array.isArray(values) || values.length !== 2",
    "!Array.isArray(values) || values.length === 0",
  ])(
    "an immediate rejecting array guard proves the next receiver: %s",
    (condition) => {
      expect(
        analyze(
          `${header}
      export const run = (values) => {
        if (${condition}) {return undefined;}
        const selected = values.filter(() => write({type: "write", tx: rootDb, table: flowRuns}));
        return selected;
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("an immediate rejecting guard retains actual transaction and callback values", () => {
    expect(
      analyze(
        `${header}
      const validate = (values) => {
        if (!Array.isArray(values) || values.length !== 2) return undefined;
        return values.filter(() => true);
      };
      export const run = () => {
        const operation = {type: "write", tx: rootDb, table: flowRuns};
        for (const callback of validate([() => write(operation), () => null]) ?? []) callback();
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    { test: "!Array.isArray(other)", body: "return undefined;", between: "" },
    {
      test: "!Array.isArray(values) || observe()",
      body: "return undefined;",
      between: "",
    },
    {
      test: "!Array.isArray(values) || other.length !== 2",
      body: "return undefined;",
      between: "",
    },
    { test: "!Array.isArray(values)", body: "observe();", between: "" },
    {
      test: "!Array.isArray(values)",
      body: "return undefined;",
      between: "observe();",
    },
    {
      test: "!Array.isArray(values)",
      body: "return undefined;",
      between: "const alias = values;",
    },
  ])(
    "a rejecting guard cannot admit unrelated or intervening effects: $test / $between",
    ({ test: condition, body, between }) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (values, other) => {
        const observe = () => false;
        if (${condition}) {${body}}
        ${between}
        const selected = values.filter(() => write({type: "write", tx: rootDb, table: flowRuns}));
        return selected;
      };
    `,
          helper,
        ),
      ).toThrow(/receives a transaction or callable/iu);
    },
  );

  test("a shadowed rejecting predicate cannot mint native array provenance", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = (values) => {
        const Array = {isArray: () => true};
        if (!Array.isArray(values)) return undefined;
        const selected = values.filter(() => write({type: "write", tx: rootDb, table: flowRuns}));
        return selected;
      };
    `,
        helper,
      ),
    ).toThrow(/receives a transaction or callable/iu);
  });

  test.each([
    "",
    "const literals = [];",
    "const fields = {};",
    "const count = 0; const name = 'data'; const ready = true; const absent = null;",
    "const literals = [] as const; const fields = {};",
    "const literals = [], fields = {}, count = 0;",
  ])(
    "a rejecting native array guard reaches for-of across inert declarations: %s",
    (between) => {
      expect(
        analyze(
          `${header}
      export const run = (raw, flag) => {
        const schema = flag ? {anyOf: raw} : {};
        const branches = schema["anyOf"];
        if (!Array.isArray(branches) || branches.length === 0) return undefined;
        ${between}
        for (const branch of branches) {
          branch["const"].toString();
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("the same array proof supports a member receiver for-of and a renamed predicate", () => {
    expect(
      analyze(
        `${header}
      const isArray = Array.isArray;
      export const run = (raw, flag) => {
        const holder = flag ? {values: raw} : {};
        if (!isArray(holder.values)) {return undefined;}
        const literals = [];
        for (const value of holder.values) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("inert declaration proof is shared with existing native array call receivers", () => {
    expect(
      analyze(
        `${header}
      export const run = (raw, flag) => {
        const branches = flag ? raw : undefined;
        if (!Array.isArray(branches)) return undefined;
        const literals = [];
        branches.forEach(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    ['[{type: "write", tx: rootDb, table: flowRuns}]', "write(value);"],
    ["[rootDb]", 'write({type: "write", tx: value, table: flowRuns});'],
    ['[() => write({type: "write", tx: rootDb, table: flowRuns})]', "value();"],
  ])(
    "rejecting for-of guards retain every actual transaction and callable value: %s",
    (values, statement) => {
      expect(
        analyze(
          `${header}
      export const run = (flag) => {
        const branches = flag ? ${values} : undefined;
        if (!Array.isArray(branches)) return undefined;
        const literals = [];
        for (const value of branches) {${statement}}
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("an admitted for-of keeps scoped elements scoped inside their original callback", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {
        const branches = flag ? [tx] : undefined;
        if (!Array.isArray(branches)) return null;
        const literals = [];
        for (const value of branches) write({type: "write", tx: value, table: flowRuns});
        return null;
      }});
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("a real rejecting array guard excludes known non-array Sets", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const branches = new Set([{type: "write", tx: rootDb, table: flowRuns}]);
        if (!Array.isArray(branches)) return undefined;
        const literals = [];
        for (const value of branches) write(value);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("custom predicates do not erase actual iterable Set capabilities", () => {
    expect(
      analyze(
        `${header}
      const Array = {isArray: () => true};
      export const run = () => {
        const branches = new Set([{type: "write", tx: rootDb, table: flowRuns}]);
        if (!Array.isArray(branches)) return undefined;
        const literals = [];
        for (const value of branches) write(value);
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    "const alias = branches;",
    "const literals = (() => [])();",
    "const literals = [raw];",
    "const literals = [rootDb];",
    "const fields = {raw};",
    "const callback = () => write({type: 'write', tx: rootDb, table: flowRuns});",
    "const {missing = observe()} = {};",
    "let literals = [];",
    "observe();",
    "const pattern = /data/u;",
  ])(
    "for-of proof cannot cross alias reads, callbacks, effects or nonempty containers: %s",
    (between) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (raw, flag) => {
        const observe = () => null;
        const branches = flag ? raw : undefined;
        if (!Array.isArray(branches)) return undefined;
        ${between}
        for (const value of branches) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
          helper,
        ),
      ).toThrow(/unsupported for-of iterable/iu);
    },
  );

  test("an alias mutation invalidates member-reference for-of evidence", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = (raw, flag) => {
        const holder = flag ? {values: raw} : {};
        const alias = holder;
        if (!Array.isArray(holder.values)) return undefined;
        alias.values = undefined;
        const literals = [];
        for (const value of holder.values) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ),
    ).toThrow(/unsupported for-of iterable/iu);
  });

  test.each([
    "!Array.isArray(other)",
    "!Array.isArray(branches) || observe()",
    "!Array.isArray(branches) || other.length === 0",
  ])(
    "for-of cannot borrow an unrelated or effectful rejecting guard: %s",
    (condition) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (raw, other, flag) => {
        const observe = () => false;
        const branches = flag ? raw : undefined;
        if (${condition}) return undefined;
        const literals = [];
        for (const value of branches) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
          helper,
        ),
      ).toThrow(/unsupported for-of iterable/iu);
    },
  );

  test.each([
    "const Array = {isArray: () => true};",
    "const isArray = () => true;",
  ])(
    "a shadowed predicate cannot manufacture for-of array provenance: %s",
    (binding) => {
      const predicate = binding.startsWith("const Array")
        ? "Array.isArray"
        : "isArray";
      expect(() =>
        analyze(
          `${header}
      ${binding}
      export const run = (raw, flag) => {
        const branches = flag ? raw : undefined;
        if (!${predicate}(branches)) return undefined;
        const literals = [];
        for (const value of branches) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
          helper,
        ),
      ).toThrow(/unsupported for-of iterable/iu);
    },
  );

  test("undefined collection alternatives remain errors without a native rejecting guard", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = (raw, flag) => {
        const branches = flag ? raw : undefined;
        const literals = [];
        for (const value of branches) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ),
    ).toThrow(/unsupported for-of iterable/iu);
  });

  test.each([
    { elements: '["null"]', separator: '","', expected: "null" },
    {
      elements: '["a", null, undefined, true, 3]',
      separator: '"|"',
      expected: "a|||true|3",
    },
    { elements: '["a", "b"]', separator: "undefined", expected: "a,b" },
    { elements: '["a", "b"]', separator: "null", expected: "anullb" },
    { elements: '[, "b"]', separator: '","', expected: ",b" },
  ])(
    "native Array.join folds primitive data with its real separator: $expected",
    ({ elements, separator, expected }) => {
      expect(
        analyze(
          `${header}
      export const run = () => {
        if (${elements}.join(${separator}) === ${JSON.stringify(expected)}) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("native Array.join preserves receiver and separator evaluation effects", () => {
    expect(
      analyze(
        `${header}
      const values = () => {rootDb.delete(flowRuns); return ["a"];};
      const separator = () => {write({type: "write", tx: rootDb, table: flowRuns}); return ",";};
      export const run = () => values().join(separator());
    `,
        helper,
      ).hits,
    ).toHaveLength(2);
  });

  test("native Array.join of validated data keeps later write paths", () => {
    expect(
      analyze(
        `${header}
      const validate = (values) => Array.isArray(values) ? values : undefined;
      export const run = (raw) => {
        const values = validate(raw) ?? [];
        if (values.join(",") === "match") write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("mutable Array.join output never invents exact extent", () => {
    expect(
      analyze(
        `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const values = [];
        if (flag) values.push("present");
        if (values.join(",") === "") write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    '[rootDb].join(",")',
    '[() => write({type: "write", tx: rootDb, table: flowRuns})].join(",")',
    '[{toString: () => write({type: "write", tx: rootDb, table: flowRuns})}].join(",")',
    '["a"].join({toString: () => write({type: "write", tx: rootDb, table: flowRuns})})',
  ])(
    "native Array.join cannot erase capability-bearing coercion: %s",
    (expression) => {
      expect(() =>
        analyze(
          `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        return ${expression};
      };
    `,
          helper,
        ),
      ).toThrow(
        /array join cannot coerce a transaction capability or callable/iu,
      );
    },
  );

  test.each([
    '[{value: true}].join(",")',
    '["a"].join({value: true})',
    '[new Date()].join(",")',
  ])(
    "unmodeled Array.join object coercion stays fail closed: %s",
    (expression) => {
      expect(() =>
        analyze(
          `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        return ${expression};
      };
    `,
          helper,
        ),
      ).toThrow(/array join requires primitive or opaque data coercion/iu);
    },
  );

  test("a custom join method still executes its own definition", () => {
    expect(
      analyze(
        `${header}
      const receiver = {join: () => write({type: "write", tx: rootDb, table: flowRuns})};
      export const run = () => receiver.join(",");
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("object rest preserves literal schema fields while excluding the source key", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const schema = {anyOf: ["ignored"], type: "string", minimum: 1};
        const {anyOf: ignored, ...outer} = schema;
        if (outer.anyOf === undefined && outer.type === "string") write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("object rest retains actual root transaction fields", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const {ignored: renamed, ...operation} = {ignored: true, type: "write", tx: rootDb, table: flowRuns};
        return write(operation);
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("object rest accepts an exact computed literal source key", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const {["ignored"]: renamed, ...operation} = {ignored: true, type: "write", tx: rootDb, table: flowRuns};
        return write(operation);
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("object rest retains captured callable values", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const {ignored, ...rest} = {ignored: true, callback: () => write({type: "write", tx: rootDb, table: flowRuns})};
        return rest.callback();
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("object rest excludes only the bound static source key", () => {
    expect(
      analyze(
        `${header}
      export const run = async () => {
        await withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {
          const {tx: discarded, ...rest} = {tx, retained: true};
          return rest;
        }});
        return write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("object rest cannot erase a retained scoped transaction", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = async () => withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {
        const {ignored, ...rest} = {ignored: true, tx};
        return rest;
      }});
    `,
        helper,
      ),
    ).toThrow(/scoped.*result.*capability/iu);
  });

  test("open object rest cannot erase a retained scope capability", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = async (input) => withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {
        const {ignored: first, ...data} = input;
        const source = {...data, tx};
        const {ignored: second, ...rest} = source;
        return rest;
      }});
    `,
        helper,
      ),
    ).toThrow(/scoped.*result.*capability/iu);
  });

  test("object rest from data input retains open fields", () => {
    expect(
      analyze(
        `${header}
      export const run = (input) => {
        const {ignored, ...rest} = input;
        return Object.keys(rest).forEach(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("object rest binding defaults preserve undefined and actual callable alternatives", () => {
    expect(
      analyze(
        `${header}
      export const run = (flag) => {
        const source = flag ? {callback: () => rootDb.delete(flowRuns)} : {};
        const {callback = () => write({type: "write", tx: rootDb, table: flowRuns}), ...rest} = source;
        return callback();
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(2);
  });

  test("object rest retains conditional field absence", () => {
    expect(
      analyze(
        `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const source = {...(flag ? {required: ["present"]} : {}), ignored: true};
        const {ignored, ...rest} = source;
        if (!(rest.required ?? []).includes("present")) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    "const source = {}; const {[key]: ignored, ...rest} = source;",
    'const source = {}; const {[{toString: () => write({type: "write", tx: rootDb, table: flowRuns})}]: ignored, ...rest} = source;',
  ])("object rest refuses unmodeled computed binding keys: %s", (body) => {
    expect(() =>
      analyze(
        `${header}
      export const run = (key) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${body}
      };
    `,
        helper,
      ),
    ).toThrow(/dynamic destructuring key/iu);
  });

  test("object rest keeps own getter sources fail closed", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        const {ignored, ...rest} = {get retained() {return write({type: "write", tx: rootDb, table: flowRuns});}};
        return rest;
      };
    `,
        helper,
      ),
    ).toThrow(/dynamic\/accessor object property/iu);
  });

  test.each([
    "rootDb",
    "new Date()",
    "new (function Source(){})()",
    "{__proto__: {value: true}}",
  ])("object rest refuses unmodeled source shape: %s", (source) => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const {ignored, ...rest} = ${source};
        return rest;
      };
    `,
        helper,
      ),
    ).toThrow(
      /object rest requires a plain object or opaque input data|source constructor dispatch requires an owner model/iu,
    );
  });

  test.each(["entries", "values"])(
    "native Object.%s retains actual root-owned operation values",
    (method) => {
      const binding = method === "entries" ? "[, operation]" : "operation";
      expect(
        analyze(
          `${header}
      export const run = () => {
        const source = {write: {type: "write", tx: rootDb, table: flowRuns}};
        for (const ${binding} of Object.${method}(source)) write(operation);
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test.each(["entries", "values"])(
    "native Object.%s retains callable captures",
    (method) => {
      const binding = method === "entries" ? "[, callback]" : "callback";
      expect(
        analyze(
          `${header}
      export const run = () => {
        const source = {call: () => write({type: "write", tx: rootDb, table: flowRuns})};
        for (const ${binding} of Object.${method}(source)) callback();
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("native enumeration preserves own-key order without invoking stored functions", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const rows = Object.entries({z: () => rootDb.delete(flowRuns), "10": true, "2": true});
        const [key] = rows.at(0);
        if (key === "2") write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each(["entries", "values"])(
    "native Object.%s retains own fields and refuses possible prototype setters",
    (method) => {
      const binding = method === "entries" ? "[, table]" : "table";
      expect(() =>
        analyze(
          `${header}
        export const run = (name) => {
          const source = {table: schedulerJobs};
          const alias = source;
          alias[name] = flowRuns;
          for (const ${binding} of Object.${method}(source)) write({type: "write", tx: rootDb, table});
        };
      `,
          helper,
        ),
      ).toThrow(
        /object enumeration requires a plain object or opaque input data/iu,
      );
      const result = analyze(
        `${header}
        export const run = (input) => {
          const name = input;
          const key = typeof name === "string" ? name : "table";
          const source = {table: schedulerJobs, [key]: flowRuns};
          const alias = source;
          for (const ${binding} of Object.${method}(alias)) write({type: "write", tx: rootDb, table});
        };
      `,
        helper,
      );
      expect(result.hits).toHaveLength(1);
    },
  );

  test("native entries data keeps tuple values open through schema rest", () => {
    expect(
      analyze(
        `${header}
      export const run = (input) => {
        for (const [name, schema] of Object.entries(input)) {
          const {anyOf, ...rest} = schema;
          Object.keys(rest).forEach(() => write({type: "write", tx: rootDb, table: flowRuns}));
        }
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("native entries preserve missing-field binding defaults and callback alternatives", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const source = {op: {type: "write", tx: rootDb, table: flowRuns}};
        for (const [name, {missing = "fallback", ...operation}] of Object.entries(source)) {
          if (missing === "fallback") write(operation);
        }
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each(["entries", "values"])(
    "native Object.%s cannot export scoped transactions",
    (method) => {
      expect(() =>
        analyze(
          `${header}
      export const run = async () => withOrgScope({tx: rootDb, scope, actor, fn: (tx) => Object.${method}({tx})});
    `,
          helper,
        ),
      ).toThrow(/scoped.*result.*capability/iu);
    },
  );

  test("native entries alias retains the actual global binding", () => {
    expect(
      analyze(
        `${header}
      const entries = Object.entries;
      export const run = () => {
        for (const [, operation] of entries({write: {type: "write", tx: rootDb, table: flowRuns}})) write(operation);
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each(["entries", "values"])(
    "shadowed Object.%s follows its actual implementation",
    (method) => {
      const body = method === "entries" ? '[["op", operation]]' : "[operation]";
      const binding = method === "entries" ? "[, operation]" : "operation";
      expect(
        analyze(
          `${header}
      export const run = () => {
        const Object = {${method}: (operation) => ${body}};
        for (const ${binding} of Object.${method}({type: "write", tx: rootDb, table: flowRuns})) write(operation);
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("an unrelated external entries export cannot erase actual capabilities", () => {
    expect(() =>
      analyze(
        `${header}
      import {entries} from "unrelated-library";
      export const run = () => entries({tx: rootDb});
    `,
        helper,
      ),
    ).toThrow(/receives a transaction or callable/iu);
  });

  test.each([
    "rootDb",
    "new Date()",
    "new (function Source(){})()",
    "{__proto__: {value: true}}",
  ])("native entries rejects unmodeled source shapes: %s", (source) => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        return Object.entries(${source});
      };
    `,
        helper,
      ),
    ).toThrow(
      /object enumeration requires a plain object or opaque input data|source constructor dispatch requires an owner model/iu,
    );
  });

  test("native entries keeps getters fail closed instead of discarding their effects", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => Object.entries({get value(){return write({type: "write", tx: rootDb, table: flowRuns});}});
    `,
        helper,
      ),
    ).toThrow(/dynamic\/accessor object property/iu);
  });

  test.each(["entries", "values"])(
    "native Object.%s enumerates native arrays without erasing root/callback values",
    (method) => {
      const binding = method === "entries" ? "[, callback]" : "callback";
      expect(
        analyze(
          `${header}
      export const run = () => {
        const values = [() => write({type: "write", tx: rootDb, table: flowRuns})];
        for (const ${binding} of Object.${method}(values)) callback();
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("native array entry positions preserve known transaction values", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const values = [{type: "write", tx: rootDb, table: flowRuns}];
        for (const [key, operation] of Object.entries(values)) {
          if (key === "0") write(operation);
        }
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each(["entries", "keys"])(
    "native Object.%s marks only enumerated keys as primitive strings",
    (method) => {
      const loop =
        method === "entries"
          ? "for (const [childName] of Object.entries(source)) kebabCase(childName);"
          : "for (const childName of Object.keys(source)) kebabCase(childName);";
      expect(
        analyze(
          `${header}
      const kebabCase = (value) => value.replace(/_/gu, "-").toLowerCase();
      export const run = (source) => {
        ${loop}
        write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("native entries alias preserves string provenance for input keys", () => {
    expect(
      analyze(
        `${header}
      const entries = Object.entries;
      const kebabCase = (value) => value.replace(/_/gu, "-").toLowerCase();
      export const run = (source) => {
        for (const [childName] of entries(source)) kebabCase(childName);
        write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    "Object.values(source)",
    "Object.entries(source).map(([, value]) => value)",
  ])(
    "native Object enumeration preserves opaque entry values: %s",
    (values) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (source) => {
        for (const value of ${values}) value.replace(/x/u, "y");
        write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
          helper,
        ),
      ).toThrow(/unmodeled delegate receives a native identity/iu);
    },
  );

  test("native array enumeration cannot export scoped transaction elements", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = async () => withOrgScope({tx: rootDb, scope, actor, fn: (tx) => Object.entries([tx])});
    `,
        helper,
      ),
    ).toThrow(/scoped.*result.*capability/iu);
  });

  test.each(["undefined", "null", '"not a record"', "true", '["array"]'])(
    "native typeof record guards reject known non-record properties: %s",
    (value) => {
      const result = analyze(
        `${header}
      const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
      const properties = (schema) => {
        const raw = schema.properties;
        if (!isRecord(raw)) return [];
        return Object.entries(raw);
      };
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        for (const entry of properties({properties: ${value}})) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test("native typeof record guards retain actual known record values", () => {
    expect(
      analyze(
        `${header}
      const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
      const properties = (schema) => {
        const raw = schema.properties;
        if (!isRecord(raw)) return [];
        return Object.entries(raw);
      };
      export const run = () => {
        for (const [, operation] of properties({properties: {op: {type: "write", tx: rootDb, table: flowRuns}}})) write(operation);
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("an exact record guard refines a captured optional properties value", () => {
    expect(
      analyze(
        `${header}
      const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
      export const run = (missing) => {
        const schema = {
          properties: missing
            ? undefined
            : {operation: {type: "write", tx: rootDb, table: flowRuns}},
        };
        const properties = schema["properties"];
        if (!isRecord(properties)) return [];
        for (const [, operation] of Object.entries(properties)) write(operation);
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("a record name and type predicate annotation do not replace its body", () => {
    expect(() =>
      analyze(
        `${header}
      const isRecord = (value): value is Record<string, unknown> => true;
      export const run = (missing) => {
        const schema = {
          properties: missing
            ? undefined
            : {operation: {type: "write", tx: rootDb, table: flowRuns}},
        };
        const properties = schema["properties"];
        if (!isRecord(properties)) return [];
        return Object.entries(properties);
      };
    `,
        helper,
      ),
    ).toThrow(
      /object enumeration requires a plain object or opaque input data|source constructor dispatch requires an owner model/iu,
    );
  });

  test("record refinement preserves scoped callbacks and opaque input", () => {
    const result = analyze(
      `${header}
      const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
      export const run = (missing) => withOrgScope({
        tx: rootDb,
        scope,
        actor,
        fn: (tx) => {
          const schema = {
            properties: missing
              ? undefined
              : {callback: () => write({type: "write", tx, table: flowRuns})},
          };
          const properties = schema["properties"];
          if (!isRecord(properties)) return null;
          for (const callback of Object.values(properties)) callback();
        },
      });
      export const retainPrivileged = (missing) => {
        const properties = missing ? undefined : {callback: () => write({type: "write", tx: rootDb, table: flowRuns})};
        if (!isRecord(properties)) return null;
        for (const callback of Object.values(properties)) callback();
      };
      export const retainInput = (properties) => {
        const raw = properties ? properties : undefined;
        if (!isRecord(raw)) return [];
        return Object.entries(raw);
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(1);
    expect(result.reachedRecoveryOwners).toContain(owner);
  });

  test("a read inside its containing call argument keeps the active discriminant fact", () => {
    const result = analyze(
      `${header}
      const keyFor = (spec) => spec.flag.slice(2);
      export const run = (properties, mode) => {
        for (const [prop] of Object.entries(properties)) {
          const classification = mode === "input"
            ? {kind: "input-only"}
            : {kind: "flag", spec: {flag: \`--\${prop}\`}};
          if (classification.kind === "input-only") continue;
          const candidates = [];
          candidates.push({...classification.spec});
          for (const candidate of candidates) {
            keyFor(candidate);
            write({type: "write", tx: rootDb, table: flowRuns});
          }
        }
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(1);
  });

  test("a later argument mutation cannot change a captured primitive property value", () => {
    const result = analyze(
      `${header}
      const mutate = (spec) => {spec.flag = undefined; return null;};
      const consume = (flag, _after) => flag.slice(2);
      export const run = (mode) => {
        const classification = mode === "input"
          ? {kind: "input-only"}
          : {kind: "flag", spec: {flag: "--query"}};
        if (classification.kind === "input-only") return;
        consume(classification.spec.flag, mutate(classification.spec));
        write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(1);
  });

  test("later replacement of a parent field cannot change a captured object reference", () => {
    const result = analyze(
      `${header}
      const keyFor = (spec) => spec.flag.slice(2);
      const replace = (value) => {value.spec = {flag: undefined}; return null;};
      const consume = (spec, _after) => keyFor(spec);
      export const run = (mode) => {
        const classification = mode === "input"
          ? {kind: "input-only"}
          : {kind: "flag", spec: {flag: "--query"}};
        if (classification.kind === "input-only") return;
        consume(classification.spec, replace(classification));
        write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(1);
  });

  test("later mutation of a captured object does not preserve its old field proof", () => {
    expect(() =>
      analyze(
        `${header}
        const keyFor = (spec) => spec.flag.slice(2);
        const mutate = (spec) => {spec.flag = undefined; return null;};
        const consume = (spec, _after) => keyFor(spec);
        export const run = (mode) => {
          const classification = mode === "input"
            ? {kind: "input-only"}
            : {kind: "flag", spec: {flag: "--query"}};
          if (classification.kind === "input-only") return;
          consume(classification.spec, mutate(classification.spec));
          write({type: "write", tx: rootDb, table: flowRuns});
        };
      `,
        helper,
      ),
    ).toThrow(/native string method requires a proven string receiver/iu);
  });

  test.each([
    {
      label: "earlier argument",
      call: "consume(mutate(classification), classification.spec);",
    },
    {
      label: "callee",
      call: "mutatingCallee(classification)(null, classification.spec);",
    },
  ])(
    "a $label mutation before a discriminant property read prevents narrowing",
    ({ call }) => {
      expect(() =>
        analyze(
          `${header}
        const keyFor = (spec) => spec.flag.slice(2);
        const mutate = (value) => {value.spec = {flag: undefined}; return null;};
        const consume = (_before, spec) => keyFor(spec);
        const mutatingCallee = (value) => {value.spec = {flag: undefined}; return consume;};
        export const run = (mode) => {
          const classification = mode === "input"
            ? {kind: "input-only"}
            : {kind: "flag", spec: {flag: "--query"}};
          if (classification.kind === "input-only") return;
          ${call}
          write({type: "write", tx: rootDb, table: flowRuns});
        };
      `,
          helper,
        ),
      ).toThrow(/native string method requires a proven string receiver/iu);
    },
  );

  test("a later discriminant guard cannot prove an earlier property read", () => {
    expect(() =>
      analyze(
        `${header}
        const keyFor = (spec) => spec.flag.slice(2);
        export const run = (mode) => {
          const classification = mode === "flag"
            ? {kind: "flag", spec: {flag: "--query"}}
            : {kind: "input-only"};
          keyFor(classification.spec);
          if (classification.kind === "input-only") return;
          write({type: "write", tx: rootDb, table: flowRuns});
        };
      `,
        helper,
      ),
    ).toThrow(/native string method requires a proven string receiver/iu);
  });

  test("an outer guard cannot narrow a discriminant read in a captured function", () => {
    expect(() =>
      analyze(
        `${header}
        const keyFor = (spec) => spec.flag.slice(2);
        export const run = (mode) => {
          const classification = mode === "input"
            ? {kind: "input-only"}
            : {kind: "flag", spec: {flag: "--query"}};
          if (classification.kind === "input-only") return;
          const readLater = () => keyFor(classification.spec);
          readLater();
          write({type: "write", tx: rootDb, table: flowRuns});
        };
      `,
        helper,
      ),
    ).toThrow(/native string method requires a proven string receiver/iu);
  });

  test("discriminant reads narrow const variants across a continuing loop path", () => {
    expect(
      analyze(
        `${header}
      export const run = (mode) => {
        const required = new Set(["name"]);
        const skipped = [];
        for (const prop of new Set(["name"])) {
          const classification = mode === "input"
            ? {kind: "input-only"}
            : mode === "flag"
              ? {kind: "flag"}
              : {kind: "children", children: [{type: "write", tx: rootDb, table: flowRuns}]};
          if (classification.kind === "input-only") {
            skipped.push(prop);
            continue;
          }
          const isRequired = required.has(prop);
          if (classification.kind === "flag") continue;
          for (const child of classification.children) {
            if (isRequired) write(child);
          }
        }
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    {
      effect: "classification.kind = mode;",
      diagnostic:
        /mutable field retains a transaction capability or callable/iu,
    },
    {
      effect: "mutate(classification);",
      diagnostic:
        /mutable field retains a transaction capability or callable/iu,
    },
  ])(
    "discriminant refinement stops across mutable or opaque paths: $effect",
    ({ effect, diagnostic }) => {
      expect(() =>
        analyze(
          `${header}
      const mutate = (value) => {value.kind = "input-only";};
      export const run = (mode) => {
        for (const prop of new Set(["name"])) {
          const classification = mode === "input"
            ? {kind: "input-only"}
            : {kind: "children", children: [{type: "write", tx: rootDb, table: flowRuns}]};
          if (classification.kind === "input-only") continue;
          ${effect}
          for (const child of classification.children) write(child);
        }
      };
    `,
          helper,
        ),
      ).toThrow(diagnostic);
    },
  );

  test("an immutable alias retains the refined variant's raw write", () => {
    const result = analyze(
      `${header}
      export const run = (mode) => {
        for (const prop of new Set(["name"])) {
          const classification = mode === "input"
            ? {kind: "input-only"}
            : {kind: "children", children: [{type: "write", tx: rootDb, table: flowRuns}]};
          if (classification.kind === "input-only") continue;
          const alias = classification;
          for (const child of classification.children) write(child);
        }
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["update"]);
  });

  test("unresolved discriminant alternatives remain in the read", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = (mode, opaque) => {
        for (const prop of new Set(["name"])) {
          const classification = mode === "input"
            ? {kind: "input-only"}
            : mode === "known"
              ? {kind: "children", children: [{type: "write", tx: rootDb, table: flowRuns}]}
              : opaque;
          if (classification.kind === "input-only") continue;
          if (classification.kind === "flag") continue;
          for (const child of classification.children) write(child);
        }
      };
    `,
        helper,
      ),
    ).toThrow(/unresolved update table \(input\)/iu);
  });

  test.each([
    "mode",
    "rootDb",
    '() => write({type: "write", tx: rootDb, table: flowRuns})',
  ])("discriminant narrowing retains non-object alternatives: %s", (other) => {
    expect(() =>
      analyze(
        `${header}
      export const run = (mode) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        for (const prop of new Set(["name"])) {
          const classification = mode === "input"
            ? {kind: "input-only"}
            : ${other};
          if (classification.kind === "input-only") continue;
          for (const child of classification.children) write(child);
        }
      };
    `,
        helper,
      ),
    ).toThrow(
      other === "mode"
        ? /unresolved update table \(input\)/iu
        : /unsupported for-of iterable/iu,
    );
  });

  test("a continue in a nested loop cannot narrow the outer iteration", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = (mode) => {
        for (const prop of new Set(["name"])) {
          const classification = mode === "input"
            ? {kind: "input-only"}
            : {kind: "children", children: [{type: "write", tx: rootDb, table: flowRuns}]};
          for (const nested of ["nested"]) {
            if (classification.kind === "input-only") continue;
          }
          for (const child of classification.children) write(child);
        }
      };
    `,
        helper,
      ),
    ).toThrow(/unsupported for-of iterable/iu);
  });

  test.each([
    {
      label: "while",
      loop: `while (nested) { if (classification.kind === "input-only") continue; }`,
      failure: /loop form requires an abstract state fixed point/iu,
    },
    {
      label: "for",
      loop: `for (let index = 0; index < 1; index += 1) { if (classification.kind === "input-only") continue; }`,
      failure: /unsupported for-of iterable/iu,
    },
    {
      label: "do while",
      loop: `do { if (classification.kind === "input-only") continue; } while (nested);`,
      failure: /loop form requires an abstract state fixed point/iu,
    },
  ])(
    "a continue in a nested $label loop cannot narrow the outer iteration",
    ({ loop, failure }) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (mode, nested) => {
        for (const prop of new Set(["name"])) {
          const classification = mode === "input"
            ? {kind: "input-only"}
            : {kind: "children", children: [{type: "write", tx: rootDb, table: flowRuns}]};
          ${loop}
          for (const child of classification.children) write(child);
        }
      };
    `,
          helper,
        ),
      ).toThrow(failure);
    },
  );

  test("a non-exiting tag mutation still exposes its missing child collection", () => {
    expect(() =>
      analyze(
        `${header}
      const changeTag = (value) => {value.kind = "children";};
      export const run = (mode) => {
        for (const prop of new Set(["name"])) {
          const classification = mode === "first"
            ? {kind: "first"}
            : {kind: "children", children: [{type: "write", tx: rootDb, table: flowRuns}]};
          if (classification.kind === "first") changeTag(classification);
          if (classification.kind === "children") {
            for (const child of classification.children) write(child);
          }
        }
      };
    `,
        helper,
      ),
    ).toThrow(/unsupported for-of iterable \(unknown\)/iu);
  });

  test("a discriminator helper alias does not authorize narrowing", () => {
    expect(() =>
      analyze(
        `${header}
      const isInputOnly = (value) => value.kind === "input-only";
      export const run = (mode) => {
        for (const prop of new Set(["name"])) {
          const classification = mode === "input"
            ? {kind: "input-only"}
            : {kind: "children", children: [{type: "write", tx: rootDb, table: flowRuns}]};
          if (isInputOnly(classification)) continue;
          for (const child of classification.children) write(child);
        }
      };
    `,
        helper,
      ),
    ).toThrow(/unsupported for-of iterable/iu);
  });

  test("a nonliteral discriminator value cannot select a union alternative", () => {
    expect(
      analyze(
        `${header}
      export const run = (kind) => {
        for (const prop of new Set(["name"])) {
          const classification = {kind, children: [{type: "write", tx: rootDb, table: flowRuns}]};
          if (classification.kind === "input-only") continue;
          for (const child of classification.children) write(child);
        }
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("a labelled continue cannot establish a local discriminant fact", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = (mode) => {
        outer: for (const prop of new Set(["name"])) {
          const classification = mode === "input"
            ? {kind: "input-only"}
            : {kind: "children", children: [{type: "write", tx: rootDb, table: flowRuns}]};
          if (classification.kind === "input-only") continue outer;
          for (const child of classification.children) write(child);
        }
      };
    `,
        helper,
      ),
    ).toThrow(
      /unsupported VariableDeclarator carries a transaction\/callback/iu,
    );
  });

  test("unmodeled handle method existence does not become a proven function", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const method = rootDb.unmodeledMember;
        if (typeof method === "undefined") write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("custom prototype sources do not become plain data after a record guard", () => {
    expect(() =>
      analyze(
        `${header}
      const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const value = {__proto__: {data: true}};
        if (!isRecord(value)) return [];
        return Object.entries(value);
      };
    `,
        helper,
      ),
    ).toThrow(
      /object enumeration requires a plain object or opaque input data|source constructor dispatch requires an owner model/iu,
    );
  });

  test("for-of data input retains data member provenance", () => {
    expect(
      analyze(
        `${header}
      export const run = (rows) => {
        for (const row of rows) {
          row.inputSchema.properties.toString();
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("for-of data input retains native entry tuples and open schema remainders", () => {
    expect(
      analyze(
        `${header}
      export const run = (rows) => {
        for (const row of rows) {
          for (const [key, schema] of Object.entries(row.inputSchema.properties)) {
            const {anyOf, ...outer} = schema;
            Object.keys(outer).forEach(() => write({type: "write", tx: rootDb, table: flowRuns}));
          }
        }
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    'tx.update(flowRuns).set({status: "running"})',
    'tx.transaction((nested) => nested.update(flowRuns).set({status: "running"}))',
  ])("data loop inputs never grant organization scope: %s", (mutation) => {
    expect(
      analyze(
        `${header}
      export const run = (rows) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        for (const tx of rows) ${mutation};
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("data loop callbacks cannot receive a raw connection", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = (rows) => {
        for (const callback of rows) callback(rootDb);
      };
    `,
        helper,
      ),
    ).toThrow(/unresolved delegate input receives a transaction or callable/iu);
  });

  test("input and concrete loop alternatives keep their actual transaction values", () => {
    expect(
      analyze(
        `${header}
      export const run = (rows, flag) => {
        const values = flag ? rows : [{tx: rootDb}];
        for (const row of values) write({type: "write", tx: row.tx, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each(["array", "set"])(
    "concrete %s loops keep their callable captures",
    (kind) => {
      const source = kind === "array" ? "[callback]" : "new Set([callback])";
      expect(
        analyze(
          `${header}
      export const run = () => {
        const callback = () => write({type: "write", tx: rootDb, table: flowRuns});
        for (const invoke of ${source}) invoke();
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test.each([
    "new Date()",
    "new (function Values(){})()",
    "{values: []}",
    "rootDb",
  ])("unmodeled for-of sources cannot become input data: %s", (source) => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        for (const value of ${source}) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ),
    ).toThrow(
      /unsupported for-of iterable|source constructor dispatch requires an owner model/iu,
    );
  });

  test("unmodeled external iterables remain refused", () => {
    expect(() =>
      analyze(
        `${header}
      import {values} from "opaque-provider";
      export const run = () => {
        for (const value of values()) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ),
    ).toThrow(/unsupported for-of iterable/iu);
  });

  test.each([
    ['import {readdirSync as read} from "node:fs";', "read(directory)"],
    ['import * as fs from "node:fs";', 'fs.readdirSync(directory, "utf8")'],
    [
      'import fs from "node:fs";',
      'fs.readdirSync(directory, {encoding: "utf-8", withFileTypes: false})',
    ],
    [
      'import {readdirSync as read} from "fs";',
      "read(directory, {recursive: true})",
    ],
  ])(
    "native directory reads preserve filename data through sorting: %s",
    (imports, read) => {
      expect(
        analyze(
          `${header}
      ${imports}
      export const run = (directory) => {
        for (const filename of ${read}.toSorted()) {
          filename.replace(".json", "");
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test.each(['"utf8"', '"utf-8"', '{encoding: "utf8"}'])(
    "UTF-8 file reads and JSON parsing retain open record data: %s",
    (options) => {
      expect(
        analyze(
          `${header}
      import {readFileSync as read} from "node:fs";
      const {parse} = JSON;
      export const run = (directory) => {
        const data = parse(read(new URL("entry.json", directory), ${options}));
        for (const [, schema] of Object.entries(data.properties)) {
          schema.type.toString();
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("JSON data cannot serve as a delegate for raw connections", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => JSON.parse("{}").callback(rootDb);
    `,
        helper,
      ),
    ).toThrow(/unresolved delegate input receives a transaction or callable/iu);
  });

  test("JSON data cannot grant scoped transaction authority", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const tx = JSON.parse("{}");
        tx.update(flowRuns).set({status: "running"});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("native read arguments still execute their root write effects", () => {
    expect(
      analyze(
        `${header}
      import {readdirSync} from "node:fs";
      const directory = () => {write({type: "write", tx: rootDb, table: flowRuns}); return "./";};
      export const run = () => readdirSync(directory()).toSorted();
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    ['readdirSync(".", "buffer")', /native file read requires/iu],
    ['readdirSync(".", {withFileTypes: true})', /native file read requires/iu],
    ['readdirSync(".", options)', /native file read requires/iu],
    ['readdirSync(".", {encoding: "latin1"})', /native file read requires/iu],
    [
      'readdirSync(".", {encoding: {encoding: "utf8"}})',
      /native file read requires/iu,
    ],
    ['readFileSync("./file")', /native file read requires/iu],
    ['readFileSync("./file", "buffer")', /native file read requires/iu],
    [
      'readFileSync({toString: () => "file"}, "utf8")',
      /native data read cannot receive/iu,
    ],
    [
      'readdirSync(".", () => rootDb.delete(flowRuns))',
      /native data read cannot receive/iu,
    ],
    [
      'readFileSync("file", {encoding: "utf8", signal: rootDb})',
      /native data read cannot receive/iu,
    ],
    [
      'JSON.parse("{}", () => rootDb.delete(flowRuns))',
      /native data read cannot receive/iu,
    ],
    [
      'JSON.parse("{}", reviver)',
      /JSON.parse requires data text and no reviver/iu,
    ],
    ['JSON.parse({toString: () => "{}"})', /native data read cannot receive/iu],
    ["JSON.parse(rootDb)", /native data read cannot receive/iu],
  ])(
    "unsupported native read shapes never become proven data: %s",
    (expression, error) => {
      expect(() =>
        analyze(
          `${header}
      import {readdirSync, readFileSync} from "node:fs";
      export const run = (options, reviver) => {const result = ${expression}; write({type: "write", tx: rootDb, table: flowRuns}); return result;};
    `,
          helper,
        ),
      ).toThrow(error);
    },
  );

  test.each([
    ['import {readdirSync} from "some-fs-provider";', 'readdirSync(".")'],
    [
      'import {readFileSync} from "some-fs-provider";',
      'readFileSync("file", "utf8")',
    ],
    ['import {parse} from "some-json-provider";', 'parse("[]")'],
  ])(
    "external read names alone never grant iterable data: %s",
    (imports, read) => {
      expect(() =>
        analyze(
          `${header}
      ${imports}
      export const run = () => {for (const item of ${read}) write({type: "write", tx: rootDb, table: flowRuns});};
    `,
          helper,
        ),
      ).toThrow(/unsupported for-of iterable/iu);
    },
  );

  test("shadowed JSON and filesystem names execute their actual implementations", () => {
    expect(
      analyze(
        `${header}
      const JSON = {parse: (callback) => callback()};
      const fs = {readdirSync: (callback) => callback()};
      export const run = () => {
        JSON.parse(() => write({type: "write", tx: rootDb, table: flowRuns}));
        fs.readdirSync(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(2);
  });

  test("fixed primitive default sorting retains exact native ordering and original indices", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const original = [2, 10, undefined];
        const sorted = original.toSorted(undefined);
        if (sorted[0] === 10 && sorted[1] === 2 && sorted[2] === undefined && original[0] === 2) {
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each(["undefined", "null", "0", "false", "true"])(
    "primitive spread %s contributes no fields and preserves object order",
    (source) => {
      expect(
        analyze(
          `${header}
      export const run = () => {
        const before = {...{tx: rootDb, table: flowRuns}, ...(${source})};
        const after = {...(${source}), tx: rootDb, table: flowRuns};
        write({type: "write", tx: before.tx, table: before.table});
        write({type: "write", tx: after.tx, table: after.table});
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(2);
    },
  );

  test("primitive string spreads preserve ordered indexed overwrites", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const explicitWins = {..."x", "0": {type: "write", tx: rootDb, table: flowRuns}};
        const stringWins = {...{"0": {type: "write", tx: rootDb, table: flowRuns}}, ..."x"};
        write(explicitWins["0"]);
        stringWins["0"].toLowerCase();
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("primitive string spread enumerates UTF-16 code-unit indices", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        write({type: "write", tx: rootDb, table: flowRuns});
        const copy = {..."A😀"};
        return copy["2"].toLowerCase();
      };
    `,
        helper,
      ),
    ).not.toThrow();
  });

  test("primitive spreads preserve scoped fields before and after the spread", () => {
    const result = analyze(
      `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {
        const before = {...{tx}, ...42};
        const after = {...false, tx};
        write({type: "write", tx: before.tx, table: flowRuns});
        write({type: "write", tx: after.tx, table: flowRuns});
        return null;
      }});
    `,
      helper,
    );
    expect(result.hits).toHaveLength(0);
    expect(result.reachedRecoveryOwners).toEqual([owner]);
  });

  test.each([
    "rootDb",
    '() => write({type: "write", tx: rootDb, table: flowRuns})',
  ])(
    "singleton sorting preserves actual capabilities without coercion: %s",
    (value) => {
      const statement =
        value === "rootDb"
          ? 'write({type: "write", tx: sorted[0], table: flowRuns});'
          : "sorted[0]();";
      expect(
        analyze(
          `${header}
      export const run = () => {const sorted = [${value}].toSorted(); ${statement}};
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("sorting singleton alternatives retains known raw values alongside data", () => {
    expect(
      analyze(
        `${header}
      export const run = (flag, data) => {
        const sorted = [flag ? rootDb : data].toSorted();
        write({type: "write", tx: sorted[0], table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("custom singleton sorting preserves an undefined element alternative", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const sorted = [flag ? undefined : "safe"].toSorted(() => 0);
        if (sorted[0] === undefined) rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test("custom sorting preserves undefined in a mixed union slot", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const sorted = [flag ? undefined : rootDb, undefined].toSorted(() => 0);
        if (sorted[0] === undefined) rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test("sorted arrays have independent element containers", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const source = ["b", "a"];
        const sorted = source.toSorted();
        sorted.push("c");
        if (source[0] === "b") write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("sorted input arrays retain mutable element data provenance", () => {
    expect(
      analyze(
        `${header}
      import {readdirSync} from "node:fs";
      export const run = () => {
        const source = readdirSync(".");
        const sorted = source.toSorted();
        sorted.forEach((entry) => {entry.replace("a", "b"); write({type: "write", tx: rootDb, table: flowRuns});});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    '[rootDb, "x"].toSorted()',
    '[() => rootDb.delete(flowRuns), "x"].toSorted()',
    '[{toString: () => rootDb.delete(flowRuns)}, "x"].toSorted()',
    '[{value: true}, "x"].toSorted()',
    "[1, 2].toSorted(comparator)",
  ])(
    "unmodeled sorting coercions and comparators fail closed: %s",
    (expression) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (comparator) => {const result = ${expression}; write({type: "write", tx: rootDb, table: flowRuns}); return result;};
    `,
          helper,
        ),
      ).toThrow(/array sorting|toSorted comparator/iu);
    },
  );

  test.each([
    { label: "raw comparator", receiver: "rootDb", operations: ["update"] },
    { label: "scoped comparator", receiver: "scoped", operations: [] },
  ])(
    "native sorting analyzes actual source-function effects: $label",
    ({ receiver, operations }) => {
      const result = analyze(
        `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
        write({type: "write", tx: scoped, table: flowRuns});
        [2, 1].toSorted((left, right) => {
          write({type: "write", tx: ${receiver}, table: flowRuns});
          return 0;
        });
        return null;
      }});
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits.map(({ operation }) => operation)).toEqual([
        ...operations,
      ]);
    },
  );

  test.each([
    { source: "[rootDb, scoped]", expected: [] },
    { source: "[scoped, rootDb]", expected: ["delete"] },
    { source: "[scoped, rootDb, scoped]", expected: ["delete"] },
  ])("array rest keeps tail authority from $source", ({ source, expected }) => {
    const result = analyze(
      `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
        write({type: "write", tx: scoped, table: flowRuns});
        const [head, ...tail] = ${source};
        for (const tx of tail) tx.delete(flowRuns);
        return null;
      }});
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation)).toEqual([
      ...expected,
    ]);
  });

  test("array rest creates a fresh container while preserving element references", () => {
    const result = analyze(
      `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
        write({type: "write", tx: scoped, table: flowRuns});
        const source = [scoped, {kind: "skip"}];
        const [head, ...tail] = source;
        tail[0].kind = "write";
        tail.push(rootDb);
        if (source[1].kind === "write") rootDb.delete(flowRuns);
        return null;
      }});
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test("array rest mutation does not append to its source container", () => {
    const result = analyze(
      `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
        write({type: "write", tx: scoped, table: flowRuns});
        const source = [scoped, scoped];
        const [head, ...tail] = source;
        tail.push(rootDb);
        for (const tx of source) tx.delete(flowRuns);
        return null;
      }});
    `,
      helper,
    );
    expect(result.hits).toHaveLength(0);
  });

  test("array rest refuses a custom iterable instead of omitting iterator effects", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const [...tail] = {0: rootDb, [Symbol.iterator]: () => {rootDb.delete(flowRuns); return null;}};
      };
    `,
        helper,
      ),
    ).toThrow(/dynamic\/accessor object property/iu);
  });

  test("native sorting passes the actual two element references to its comparator", () => {
    const result = analyze(
      `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
        write({type: "write", tx: scoped, table: flowRuns});
        [rootDb, scoped].toSorted((left, right) => {
          left.delete(flowRuns);
          right.update(flowRuns);
          return 0;
        });
        return null;
      }});
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation).toSorted()).toEqual([
      "delete",
      "update",
    ]);
  });

  test("native comparator arguments preserve scoped-only authority", () => {
    const result = analyze(
      `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
        write({type: "write", tx: scoped, table: flowRuns});
        [scoped, scoped].toSorted((left, right) => {
          left.delete(flowRuns);
          right.update(flowRuns);
          return 0;
        });
        return null;
      }});
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("a native comparator receives no array callback third argument", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        [2, 1].toSorted((left, right, third) => {
          if (third !== undefined) rootDb.delete(flowRuns);
          return 0;
        });
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("native comparator argument absence evaluates its actual default parameter", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        [2, 1].toSorted((left, right, third = () => rootDb.delete(flowRuns)) => {
          third();
          return 0;
        });
      };
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test.each([
    "[]",
    '["only"]',
    "[undefined, undefined]",
    '[undefined, "only", undefined]',
    "[undefined, rootDb, undefined]",
  ])(
    "sorting at most one defined item never calls a valid comparator: %s",
    (source) => {
      const result = analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${source}.toSorted(() => {rootDb.delete(flowRuns); return 0;});
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test("sorting uses a finite singleton extent instead of its possible-value count", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const source = [...(flag ? ["a"] : ["b"])];
        source.toSorted(() => {rootDb.delete(flowRuns); return 0;});
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(0);
  });

  test.each(["null", "false", "123", '"comparator"', "{}"])(
    "an empty sort still rejects an invalid comparator: %s",
    (comparator) => {
      expect(() =>
        analyze(
          `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        [].toSorted(${comparator});
      };
    `,
          helper,
        ),
      ).toThrow(/toSorted comparator/iu);
    },
  );

  test.each([
    "async () => 0",
    "function* () { yield 0; }",
    "() => asyncValue()",
  ])("native sorting refuses asynchronous source execution: %s", (callback) => {
    expect(() =>
      analyze(
        `${header}
      const asyncValue = async () => 0;
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ["a", "b"].toSorted(${callback});
      };
    `,
        helper,
      ),
    ).toThrow(/toSorted comparator/iu);
  });

  test("sorting snapshots after argument evaluation rather than before it", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const source = ["first"];
        const compare = () => {rootDb.delete(flowRuns); return 0;};
        const choose = () => {source.push("second"); return compare;};
        source.toSorted(choose());
      };
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test("comparator array mutation cannot add an item to the sorted snapshot", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const source = [{kind: "skip"}, {kind: "skip"}];
        const sorted = source.toSorted(() => {source.push({kind: "write"}); return 0;});
        for (const item of sorted) {
          if (item.kind === "write") rootDb.delete(flowRuns);
        }
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("comparator mutation cannot invalidate the sorted snapshot's copied extent", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const source = ["first", "second"];
        const sorted = source.toSorted(() => {source.push("third"); return 0;});
        for (let index = 0; index < sorted.length; index += 1) {
          if (index === 2) rootDb.delete(flowRuns);
        }
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("sorted snapshots retain element-object aliases mutated by a comparator", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const item = {kind: "skip"};
        const source = [item, {kind: "skip"}];
        const sorted = source.toSorted(() => {item.kind = "write"; return 0;});
        for (const value of sorted) {
          if (value.kind === "write") rootDb.delete(flowRuns);
        }
      };
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test("a custom comparator does not coerce element objects on its own", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const item = {toString: () => {rootDb.delete(flowRuns); return "item";}};
        [item, item].toSorted(() => 0);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test.each(["0", '"0"', "false", "null", "undefined"])(
    "source comparators may return native primitive comparison data: %s",
    (returned) => {
      const result = analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        [2, 1].toSorted(() => ${returned});
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test.each([
    "rootDb",
    "flowRuns",
    "Array",
    "() => rootDb.delete(flowRuns)",
    "({valueOf: () => rootDb.delete(flowRuns)})",
    "rootDb.delete(flowRuns)",
  ])(
    "comparator result coercion cannot erase tracked authority or callbacks: %s",
    (returned) => {
      expect(() =>
        analyze(
          `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        [2, 1].toSorted(() => ${returned});
      };
    `,
          helper,
        ),
      ).toThrow(/operator coercion may invoke mutable tracked data/iu);
    },
  );

  test("custom toSorted methods execute actual callback bodies", () => {
    expect(
      analyze(
        `${header}
      const values = {toSorted: (callback) => callback()};
      export const run = () => values.toSorted(() => write({type: "write", tx: rootDb, table: flowRuns}));
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    [
      'import path from "node:path";',
      'path.join(import.meta.dir, "./snapshot.json")',
    ],
    [
      'import * as path from "node:path";',
      'path.resolve(import.meta.dirname, "./snapshot.json")',
    ],
    [
      'import {resolve as makePath} from "node:path";',
      'makePath(base, "snapshot.json")',
    ],
    [
      'import {join as makePath} from "path";',
      'makePath(base, "snapshot.json")',
    ],
  ])(
    "native path strings feed UTF-8 reads without losing later writes: %s",
    (imports, expression) => {
      expect(
        analyze(
          `${header}
      import {readFileSync} from "node:fs";
      ${imports}
      export const run = (base) => {
        const parsed = JSON.parse(readFileSync(${expression}, "utf8"));
        for (const value of parsed) {
          value.name.toString();
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test.each(["dir", "dirname", "file", "filename", "url"])(
    "native import metadata string %s retains data provenance",
    (field) => {
      expect(
        analyze(
          `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {
        for (const value of JSON.parse(readFileSync(import.meta.${field}, "utf8"))) {
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test.each([
    ["join(rootDb)", /native path construction cannot receive/iu],
    [
      "join(() => rootDb.delete(flowRuns))",
      /native path construction cannot receive/iu,
    ],
    [
      'join({toString: () => "file"})',
      /native path construction cannot receive/iu,
    ],
    [
      'resolve({name: "file"})',
      /native path construction requires string data/iu,
    ],
    [
      'join(new URL("file:///snapshot.json"))',
      /native path construction requires string data/iu,
    ],
    ["join(5)", /native path construction requires string data/iu],
    ["join(unknownPath())", /native path construction requires string data/iu],
  ])(
    "unsupported native path inputs never become data: %s",
    (expression, error) => {
      expect(() =>
        analyze(
          `${header}
      import {join, resolve} from "node:path";
      import {unknownPath} from "opaque-provider";
      export const run = () => {${expression}; write({type: "write", tx: rootDb, table: flowRuns});};
    `,
          helper,
        ),
      ).toThrow(error);
    },
  );

  test("native path argument evaluation preserves actual writes", () => {
    expect(
      analyze(
        `${header}
      import {resolve} from "node:path";
      const base = () => {write({type: "write", tx: rootDb, table: flowRuns}); return ".";};
      export const run = () => resolve(base(), "snapshot.json");
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("unrelated path methods and shadowed names retain their implementations", () => {
    expect(
      analyze(
        `${header}
      const path = {join: (callback) => callback()};
      const resolve = (callback) => callback();
      export const run = () => {
        path.join(() => write({type: "write", tx: rootDb, table: flowRuns}));
        resolve(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(2);
  });

  test("external names cannot launder file paths into native read data", () => {
    expect(() =>
      analyze(
        `${header}
      import {join} from "unrelated-path-provider";
      import {readFileSync} from "node:fs";
      export const run = () => {readFileSync(join(".", "file"), "utf8"); write({type: "write", tx: rootDb, table: flowRuns});};
    `,
        helper,
      ),
    ).toThrow(
      /native file read requires a data path.*external:unrelated-path-provider/iu,
    );
  });

  test("unmodeled import metadata members never become data paths", () => {
    expect(() =>
      analyze(
        `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {readFileSync(import.meta.customPath, "utf8"); write({type: "write", tx: rootDb, table: flowRuns});};
    `,
        helper,
      ),
    ).toThrow(/native file read requires a data path/iu);
  });

  test("numeric array indices preserve actual callbacks and transaction identities", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const values = [rootDb, () => write({type: "write", tx: rootDb, table: flowRuns})];
        write({type: "write", tx: values[0], table: flowRuns});
        values[1]();
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(2);
  });

  test("sorted primitive indices prove both exact order and independent source order", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const source = [2, 10, undefined];
        const sorted = source.toSorted();
        if (sorted[0] !== 10 || sorted[1] !== 2 || sorted[2] !== undefined || source[0] !== 2) {
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("dynamic array indices remain fail closed for actual capabilities", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = (index) => {
        const values = [rootDb];
        write({type: "write", tx: values[index], table: flowRuns});
      };
    `,
        helper,
      ),
    ).toThrow(/dynamic capability\/callback member access/iu);
  });

  test("dynamic object lookup retains the missing-property alternative", () => {
    const result = analyze(
      `${header}
      export const run = (key) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const fields = {present: "value"};
        if (fields[key] === undefined) rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toContain("delete");
  });

  test("computed member key coercion keeps custom conversion writes", () => {
    expect(() =>
      analyze(
        `${header}
        export const run = () => {
          withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
          const fields = {present: "value"};
          const key = {toString: () => rootDb.delete(flowRuns)};
          fields[key];
        };
      `,
        helper,
      ),
    ).toThrow(/operator coercion may invoke mutable tracked data/iu);
  });

  test("dynamic member calls reject callbacks that can create a raw client", () => {
    expect(() =>
      analyze(
        `${header}
        import {createDatabase} from "@/api/db/sql-client";
        export const run = (key) => {
          withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
          const methods = {known: 0};
          const build = () => createDatabase().delete(flowRuns);
          methods[key](build);
        };
      `,
        helper,
        {
          "apps/api/src/db/sql-client.ts":
            "export const createDatabase = () => ({})",
        },
      ),
    ).toThrow(/dynamic transaction\/delegate member/iu);
  });

  test("data-only dynamic member calls remain unresolved data", () => {
    const result = analyze(
      `${header}
      export const run = (key) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const methods = {known: 0};
        methods[key]("data");
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("find results remain non-null on the continuing side of their rejecting const guard", () => {
    expect(
      analyze(
        `${header}
      export const run = (flag) => {
        const variants = flag ? [{type: "string"}] : [];
        const branches = variants.filter((branch) => typeof branch === "object" && branch !== null && !Array.isArray(branch));
        const nullBranch = branches.find(() => true);
        const valueBranch = branches.find(() => true);
        if (nullBranch === undefined || valueBranch === undefined) return {};
        const valueTypes = [valueBranch["type"]];
        const valueType = valueTypes.at(0);
        if (valueType === undefined) return {};
        const {anyOf, ...outer} = {anyOf: branches};
        Object.keys(valueBranch).some(() => write({type: "write", tx: rootDb, table: flowRuns}));
        return {...outer, ...valueBranch};
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    ["value === undefined", "flag ? raw : undefined"],
    ["undefined === value", "flag ? raw : undefined"],
    ["value === null", "flag ? raw : null"],
    [
      "value === undefined || value === null",
      "flag ? raw : (flag ? null : undefined)",
    ],
    ["!(value !== undefined)", "flag ? raw : undefined"],
  ])(
    "rejecting strict nullish guards constrain only their stable const reads: %s",
    (condition, source) => {
      expect(
        analyze(
          `${header}
      export const run = (raw, flag) => {
        const value = ${source};
        if (${condition}) return null;
        const observe = () => null;
        observe();
        if (flag) Object.keys(value).forEach(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test.each([
    "if (flag) callbacks.push(read);",
    "if (flag) {if (flag) callbacks.push(read);}",
    "flag ? callbacks.push(read) : undefined;",
    "switch (flag) {case true: callbacks.push(read); break; default: break;}",
    "for (const item of [1]) callbacks.push(read);",
    "try {callbacks.push(read);} catch {}",
    "try {throw null;} catch {callbacks.push(read);}",
  ])(
    "a forked closure sees later initialization and mutation: %s",
    (placement) => {
      const collect = placement.replaceAll(
        "read",
        () => "() => {if (state.active) rootDb.delete(flowRuns);}",
      );
      const result = analyze(
        `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const callbacks = [];
        ${collect}
        const state = {active: false};
        state.active = true;
        for (const callback of callbacks) callback();
      };
    `,
        helper,
      );
      expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
    },
  );

  test.each([
    "try {throw scoped;} catch (tx) {tx.delete(flowRuns);}",
    "try {throw {tx: scoped};} catch ({tx}) {tx.delete(flowRuns);}",
    "const choose = () => {try {return null;} finally {return scoped;}}; choose().delete(flowRuns);",
  ])("abrupt completions retain their actual receiver: %s", (statements) => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
          write({type: "write", tx: scoped, table: flowRuns});
          ${statements}
          return null;
        }});
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test.each([
    ["-0", "0"],
    ["0", "-0"],
  ])(
    "strict numeric discriminator equality retains both signed zeros: %s/%s",
    (rawTag, scopedTag) => {
      const result = analyze(
        `${header}
      export const run = (flag) => withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
        write({type: "write", tx: scoped, table: flowRuns});
        const operation = flag ? {type: "write", mode: ${rawTag}, tx: rootDb, table: flowRuns} : {type: "write", mode: ${scopedTag}, tx: scoped, table: flowRuns};
        if (operation.mode !== 0) return null;
        operation.tx.delete(flowRuns);
        return null;
      }});
    `,
        helper,
      );
      expect(result.hits).toHaveLength(1);
    },
  );

  test("abrupt loop exits discard local bindings from their enclosing store", () => {
    const items = Array.from({ length: 65 }, (_, index) => String(index)).join(
      ",",
    );
    const result = analyze(
      `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const classify = (item) => flag ? {kind: "first", item} : {kind: "second", item};
        for (const item of [${items}]) {
          const classification = classify(item);
          throw null;
        }
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("a returned loop-local closure retains its original captured state", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const choose = () => {
          for (const item of [0]) {
            const state = {active: false};
            const read = () => {if (state.active) rootDb.delete(flowRuns);};
            state.active = true;
            return read;
          }
          return () => null;
        };
        choose()();
      };
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test.each([
    "var state = {active: false}; const read = () => {if (state.active) rootDb.delete(flowRuns);}; for (const item of [0]) {var state = {active: true};} read();",
    "for (var item of [0]) {const read = () => item; read();}",
  ])(
    "function-scoped var bindings require an explicit binding model: %s",
    (statements) => {
      expect(() =>
        analyze(
          `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${statements}
      };
    `,
          helper,
        ),
      ).toThrow(
        /function-scoped var bindings require an explicit binding model/iu,
      );
    },
  );

  test("an uncaptured local cursor keeps its rejecting tag guard after a counted loop", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        let node = {kind: "route", children: {}};
        const path = [0];
        for (let index = 0; index < path.length; index += 1) {
          const existing = flag ? {kind: "leaf"} : undefined;
          if (existing === undefined) {
            const created = {kind: "route", children: {}};
            node = created;
            continue;
          }
          node = existing;
        }
        if (node.kind !== "route") throw null;
        node.children.final = {kind: "leaf"};
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test.each([
    [
      "await {then: (resolve) => {rootDb.delete(flowRuns); resolve(null);}};",
      /awaited thenable requires an explicit call model/iu,
    ],
    [
      "for await (const item of [{then: (resolve) => {rootDb.delete(flowRuns); resolve(null);}}]) {}",
      /awaited thenable requires an explicit call model/iu,
    ],
    [
      "const value = {}; value.then = (resolve) => {rootDb.delete(flowRuns); resolve(null);}; await value;",
      /mutable field retains a transaction capability or callable/iu,
    ],
  ])(
    "implicit thenable calls require an explicit owner model: %s",
    (statements, diagnostic) => {
      expect(() =>
        analyze(
          `${header}
      export const run = async () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${statements}
      };
    `,
          helper,
        ),
      ).toThrow(diagnostic);
    },
  );

  test.each([
    {
      statements:
        'const value = await {then: 42, kind: "ordinary"}; if (value.kind !== "ordinary") rootDb.delete(flowRuns);',
      count: 0,
    },
    {
      statements:
        "const values = await [() => rootDb.delete(flowRuns)]; values[0]();",
      count: 1,
    },
    {
      statements: "await {then: {run: () => rootDb.delete(flowRuns)}};",
      count: 0,
    },
  ])(
    "await preserves non-thenable values and their stored references: $statements",
    ({ statements, count }) => {
      const result = analyze(
        `${header}
      export const run = async () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${statements}
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(count);
    },
  );

  test("a schema lookup guard excludes absence before same-iteration classification", () => {
    const result = analyze(
      `${header}
      const classify = (schema) => {const {anyOf, ...outer} = schema; return outer;};
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const properties = {name: {type: "string"}};
        for (const prop of Object.keys(properties)) {
          const schema = properties[prop];
          if (schema === undefined) {
            continue;
          }
          classify(schema);
        }
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test.each([
    ["value === undefined", "flag ? {} : undefined"],
    ["undefined === value", "flag ? {} : undefined"],
    ["value === null", "flag ? {} : null"],
    [
      "value === undefined || value === null",
      "flag ? {} : (flag ? null : undefined)",
    ],
    ["!(value !== undefined)", "flag ? {} : undefined"],
  ])(
    "a strict nullish continue constrains a stable const in the same iteration: %s",
    (condition, source) => {
      const result = analyze(
        `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        for (const item of [1]) {
          const value = ${source};
          if (${condition}) continue;
          Object.keys(value);
        }
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test("a rejecting continue in else preserves its matching strict nullish fact", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        for (const item of [1]) {
          const value = flag ? {} : undefined;
          if (value !== undefined) {} else {continue;}
          Object.keys(value);
        }
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(0);
  });

  test("a nullish continue preserves a surviving raw transaction", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        for (const item of [1]) {
          const tx = flag ? rootDb : undefined;
          if (tx === undefined) continue;
          write({type: "write", tx, table: flowRuns});
        }
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(1);
  });

  test("a nullish continue does not promote a surviving scoped transaction", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
        write({type: "write", tx: scoped, table: flowRuns});
        for (const item of [1]) {
          const tx = flag ? scoped : undefined;
          if (tx === undefined) continue;
          write({type: "write", tx, table: flowRuns});
        }
        return null;
      }});
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("stored closures retain the nullish alternatives rejected by a later continue", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const callbacks = [];
        for (const item of [1]) {
          const value = flag ? {} : undefined;
          callbacks.push(() => {if (value === undefined) rootDb.delete(flowRuns);});
          if (value === undefined) continue;
          Object.keys(value);
        }
        for (const callback of callbacks) callback();
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(1);
  });

  test.each([
    "const value = flag ? {} : undefined; if (other === undefined) continue; Object.keys(value);",
    "const value = flag ? {} : undefined; if (value === undefined) {if (flag) continue;} Object.keys(value);",
    "const value = flag ? {} : undefined; for (const nested of [1]) {if (value === undefined) continue;} Object.keys(value);",
    'const undefined = "sentinel"; const value = flag ? {} : [].at(0); if (value === undefined) continue; Object.keys(value);',
  ])(
    "a continue cannot certify a different binding, loop, or conditional exit: %s",
    (statements) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (flag, other) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        for (const item of [1]) {
          ${statements}
        }
      };
    `,
          helper,
        ),
      ).toThrow(/Object.keys requires a non-null input/iu);
    },
  );

  test.each([
    "let value = flag ? {} : undefined; if (value === undefined) continue; Object.keys(value);",
    "const value = flag ? {} : undefined; if (value === undefined) continue; for (const nested of [1]) {Object.keys(value);}",
  ])(
    "a surviving local nullish state remains valid through its dominated reads: %s",
    (statements) => {
      const result = analyze(
        `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        for (const item of [1]) {
          ${statements}
        }
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test("a rejecting else branch retains the true strict non-nullish comparison", () => {
    expect(
      analyze(
        `${header}
      export const run = (raw, flag) => {
        const value = flag ? raw : undefined;
        if (value !== undefined) {} else {return null;}
        Object.keys(value).forEach(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("nullish guards keep known raw transactions and callable values", () => {
    expect(
      analyze(
        `${header}
      export const run = (flag) => {
        const tx = flag ? rootDb : undefined;
        const callback = flag ? () => write({type: "write", tx: rootDb, table: flowRuns}) : undefined;
        if (tx === undefined || callback === undefined) return null;
        write({type: "write", tx, table: flowRuns});
        callback();
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(2);
  });

  test("nullish const proof does not change a surviving scoped transaction's authority", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
        const tx = flag ? scoped : undefined;
        if (tx === undefined) return null;
        write({type: "write", tx, table: flowRuns});
        return null;
      }});
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("writes evaluated in a rejecting return remain counted", () => {
    expect(
      analyze(
        `${header}
      export const run = (raw, flag) => {
        const value = flag ? raw : undefined;
        if (value === undefined) return write({type: "write", tx: rootDb, table: flowRuns});
        Object.keys(value).some(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(2);
  });

  test.each([
    "const value = flag ? raw : undefined; if (other === undefined) return null;",
    "const value = flag ? raw : undefined; if (value === undefined && other === undefined) return null;",
    "const value = flag ? raw : undefined; if (value === undefined) {observe();}",
    "const value = flag ? raw : null; if (value === undefined) return null;",
    "const value = flag ? raw : undefined; if (value === null) return null;",
    "const value = flag ? raw : undefined; const checked = value; if (checked === undefined) return null;",
    'const undefined = "sentinel"; const value = flag ? raw : [].at(0); if (value === undefined) return null;',
  ])("unproven nullish alternatives remain errors: %s", (declarations) => {
    expect(() =>
      analyze(
        `${header}
      export const run = (raw, other, flag) => {
        const observe = () => null;
        ${declarations}
        Object.keys(value).some(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
        helper,
      ),
    ).toThrow(/Object.keys requires a non-null input/iu);
  });

  test("a rejecting return preserves an uncaptured local's raw callback write", () => {
    const result = analyze(
      `${header}
      export const run = (raw, flag) => {
        const observe = () => null;
        let value = flag ? raw : undefined;
        if (value === undefined) return null;
        Object.keys(value).some(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["update"]);
  });

  test("a member guard cannot survive alias mutation as an immutable binding proof", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = (raw, flag) => {
        const holder = {value: flag ? raw : undefined};
        const alias = holder;
        if (holder.value === undefined) return null;
        alias.value = undefined;
        Object.keys(holder.value).some(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
        helper,
      ),
    ).toThrow(/Object.keys requires a non-null input/iu);
  });

  test("an exit in a sibling block does not dominate later reads", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = (raw, flag) => {
        const value = flag ? raw : undefined;
        if (flag) {if (value === undefined) return null;}
        Object.keys(value).some(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
        helper,
      ),
    ).toThrow(/Object.keys requires a non-null input/iu);
  });

  test("a caught throw and a loop break cannot export nullish proof", () => {
    for (const guarded of [
      "try {if (value === undefined) throw null;} catch {}",
      "for (const item of [1]) {if (value === undefined) break;}",
    ]) {
      expect(() =>
        analyze(
          `${header}
        export const run = (raw, flag) => {
          const value = flag ? raw : undefined;
          ${guarded}
          Object.keys(value).some(() => write({type: "write", tx: rootDb, table: flowRuns}));
        };
      `,
          helper,
        ),
      ).toThrow(/Object.keys requires a non-null input/iu);
    }
  });

  test.each([
    'const callback = () => {if (value === undefined) write({type: "write", tx: rootDb, table: flowRuns});}; if (value === undefined) return callback; return callback;',
    'if (value === undefined) return callback; function callback() {if (value === undefined) write({type: "write", tx: rootDb, table: flowRuns});} return callback;',
  ])(
    "rejecting-path closures retain their original lexical nullish alternatives: %s",
    (body) => {
      expect(
        analyze(
          `${header}
      const build = (flag) => {const value = flag ? {} : undefined; ${body}};
      export const run = (flag) => build(flag)();
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("callbacks stored before a guard retain rejecting-path debt after later guarded reads", () => {
    expect(
      analyze(
        `${header}
      const callbacks = [];
      const build = (flag) => {
        const value = flag ? {} : undefined;
        callbacks.push(() => {if (value === undefined) write({type: "write", tx: rootDb, table: flowRuns});});
        if (value === undefined) return null;
        Object.keys(value);
      };
      export const run = (flag) => {build(flag); for (const callback of callbacks) callback();};
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("opaque schema data spreads retain open field provenance after a rejecting find guard", () => {
    expect(
      analyze(
        `${header}
      const project = (schema, flag) => {
        const branches = flag ? [schema] : [];
        const valueBranch = branches.find(() => true);
        if (valueBranch === undefined) return {};
        const {anyOf, ...outer} = schema;
        return {...outer, ...valueBranch, type: ["string", "null"]};
      };
      export const run = (schema, flag) => {
        const projected = project(schema, flag);
        for (const [key, value] of Object.entries(projected)) {
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("open callback overrides retain known raw fields and refuse unknown receivers", () => {
    const source = (invoke: string) => `${header}
      export const run = (input, flag) => {
        const known = {tx: rootDb, callback: () => write({type: "write", tx: rootDb, table: flowRuns})};
        const selected = flag ? input : known;
        const copy = {...known, ...selected};
        write({type: "write", tx: copy.tx, table: flowRuns});
        ${invoke}
      };
    `;
    expect(analyze(source(""), helper).hits).toHaveLength(1);
    expect(() => analyze(source("copy.callback?.();"), helper)).toThrow(
      /unresolved delegate input receives a transaction or callable/iu,
    );
  });

  test("a known scoped field remains scoped through a closed object copy", () => {
    const result = analyze(
      `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {
        const copy = {...{tx}};
        write({type: "write", tx: copy.tx, table: flowRuns});
        return null;
      }});
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("open input fields retain uncertain override authority even beside later explicit fields", () => {
    expect(
      analyze(
        `${header}
      export const run = (input) => withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {
        const copy = {...input, tx};
        write({type: "write", tx: copy.tx, table: flowRuns});
        return null;
      }});
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each(["optional", "{...optional}", "rest"])(
    "optional presence survives materialized and rest spread sources: %s",
    (source) => {
      expect(
        analyze(
          `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const prior = {callback: () => write({type: "write", tx: rootDb, table: flowRuns})};
        const optional = {...(flag ? {callback: () => null} : {})};
        const {discard, ...rest} = optional;
        const copy = {...prior, ...${source}};
        copy.callback?.();
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test.each([
    "const explicit = {callback: undefined};",
    "const explicit = {...{callback: undefined}};",
    "const {discard, ...explicit} = {discard: true, callback: undefined};",
    "const explicit = {callback: undefined}; if (flag) explicit.other = true;",
    "const explicit = {callback: undefined}; if (flag) explicit.callback = undefined;",
    "const optional = {...(flag ? {callback: () => null} : {})}; const explicit = {...optional, callback: undefined};",
  ])(
    "an explicit own undefined key overwrites rather than restores a prior callback: %s",
    (declaration) => {
      const result = analyze(
        `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const prior = {callback: () => write({type: "write", tx: rootDb, table: flowRuns})};
        ${declaration}
        const copy = {...prior, ...explicit};
        copy.callback?.();
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test("a conditionally introduced undefined key preserves the absent-key fallback", () => {
    expect(
      analyze(
        `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const prior = {callback: () => write({type: "write", tx: rootDb, table: flowRuns})};
        const optional = {};
        if (flag) optional.callback = undefined;
        const copy = {...prior, ...optional};
        copy.callback?.();
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("spread copies retain computed own targets and refuse possible prototype setters", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = (key) => {
        const source = {table: schedulerJobs};
        source[key] = flowRuns;
        const copy = {...source};
        write({type: "write", tx: rootDb, table: copy.table});
      };
    `,
        helper,
      ),
    ).toThrow(/object spread cannot preserve unknown delegated fields/iu);
    const result = analyze(
      `${header}
      export const run = (input) => {
        const name = input;
        const key = typeof name === "string" ? name : "table";
        const source = {table: schedulerJobs, [key]: flowRuns};
        const copy = {...source};
        write({type: "write", tx: rootDb, table: copy.table});
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(1);
  });

  test("copying own callable fields performs no implicit coercion", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const copy = {...{toString: () => write({type: "write", tx: rootDb, table: flowRuns})}};
        return null;
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
    expect(
      analyze(
        `${header}
      export const run = () => {
        const copy = {...{toString: () => write({type: "write", tx: rootDb, table: flowRuns})}};
        copy.toString();
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    "rootDb",
    '() => write({type: "write", tx: rootDb, table: flowRuns})',
    "new Date()",
    'new String("data")',
    '{__proto__: {callback: () => write({type: "write", tx: rootDb, table: flowRuns})}}',
    "unmodeled()",
    "flag ? input : rootDb",
  ])(
    "unmodeled spread sources cannot become opaque input data: %s",
    (source) => {
      expect(() =>
        analyze(
          `${header}
      import {unmodeled} from "opaque-provider";
      export const run = (input, flag) => {
        const copy = {...(${source})};
        write({type: "write", tx: rootDb, table: flowRuns});
        return copy;
      };
    `,
          helper,
        ),
      ).toThrow(
        source.startsWith("{__proto__")
          ? /prototype initializer carries a transaction or callable/iu
          : /object spread cannot preserve unknown delegated fields/iu,
      );
    },
  );

  test("spread never drops known getters as if they were inert data fields", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        const copy = {...{get callback() {write({type: "write", tx: rootDb, table: flowRuns}); return null;}}};
        write({type: "write", tx: rootDb, table: flowRuns});
        return copy;
      };
    `,
        helper,
      ),
    ).toThrow(/dynamic\/accessor object property/iu);
  });

  test.each([
    { input: "  First. Second!  ", expected: "First. Second!" },
    { input: "\t\n  ", expected: "" },
    { input: "\u00a0\ufeffČeský text\u00a0", expected: "Český text" },
  ])(
    "native trim preserves literal whitespace semantics: $input",
    ({ input, expected }) => {
      const result = analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        if (${JSON.stringify(input)}.trim() !== ${JSON.stringify(expected)}) rootDb.delete(flowRuns);
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test.each([
    {
      expression: '"First. Second! End?".split(/(?<=[.!?])\\s+/u)',
      expected: ["First.", "Second!", "End?"],
    },
    { expression: '"a,b,c".split(",")', expected: ["a", "b", "c"] },
    { expression: '"a,b,c".split(",", 1.9)', expected: ["a"] },
    { expression: '"a,b".split()', expected: ["a,b"] },
    { expression: '"a,b".split(undefined)', expected: ["a,b"] },
    { expression: '"a,b".split(undefined, 0)', expected: [] },
    { expression: '"a,b".split(undefined, 4294967296)', expected: [] },
    { expression: '"ab".split(/(?:)/u)', expected: ["a", "b"] },
    { expression: '"axb".split(/x/y)', expected: ["a", "b"] },
    {
      expression: '"a1b2c".split(/(\\d)/u)',
      expected: ["a", "1", "b", "2", "c"],
    },
    {
      expression: '"a-b".split(/(-)|(,)/u)',
      expected: ["a", "-", undefined, "b"],
    },
    {
      expression: '"a-b".split(/(?<dash>-)|(?<comma>,)/u)',
      expected: ["a", "-", undefined, "b"],
    },
  ])(
    "native split retains exact literal values and unmatched captures: $expression",
    ({ expression, expected }) => {
      const checks = expected
        .map(
          (value, index) =>
            `if (values.at(${index}) !== ${value === undefined ? "undefined" : JSON.stringify(value)}) rootDb.delete(flowRuns);`,
        )
        .join("\n");
      const result = analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const values = ${expression};
        ${checks}
        if (values.at(${expected.length}) !== undefined) rootDb.delete(flowRuns);
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test.each([",", ""])(
    "native string-data split preserves string elements: %s",
    (separator) => {
      const result = analyze(
        `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {
        const text = readFileSync("description", "utf8").trim();
        for (const value of text.split(${JSON.stringify(separator)})) value.trim().toLowerCase();
        write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      );
      expect(result.hits).toHaveLength(1);
    },
  );

  test("native sentence splitting permits an absent first fragment through optional trim", () => {
    const result = analyze(
      `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {
        readFileSync("description", "utf8").trim().split(/(?<=[.!?])\\s+/u).at(0)?.trim();
        write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(1);
  });

  test("dynamic native RegExp splitting does not invent string proof for unmatched captures", () => {
    expect(() =>
      analyze(
        `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        for (const value of readFileSync("description", "utf8").split(/(-)|(,)/u)) value.trim();
      };
    `,
        helper,
      ),
    ).toThrow(/unresolved callable: unresolved member trim on literal/iu);
  });

  test("native split creates an independent array for every result", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const first = "a,b".split(",");
        const second = "a,b".split(",");
        first.push(rootDb);
        for (const value of second) if (typeof value !== "string") rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(0);
  });

  test("a custom split method retains its actual callable effects", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        const custom = {split: () => {write({type: "write", tx: rootDb, table: flowRuns}); return ["value"];}};
        custom.split(",");
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(1);
  });

  test.each([
    {
      expression: '"x".split(() => rootDb.delete(flowRuns))',
      diagnostic: /split cannot discard a callable or transaction/iu,
    },
    {
      expression: '"x".split(",", {valueOf: () => rootDb.delete(flowRuns)})',
      diagnostic: /split cannot discard a callable or transaction/iu,
    },
    {
      expression: '"x".split({toString: input})',
      diagnostic:
        /split requires a literal string, native RegExp, or undefined separator/iu,
    },
    {
      expression: '"x".split(",", input)',
      diagnostic: /split requires a literal numeric limit/iu,
    },
    {
      expression: '"x".split(",", 1, input)',
      diagnostic: /split accepts at most two arguments/iu,
    },
    {
      expression: '"x".trim(input)',
      diagnostic: /native trim requires no arguments/iu,
    },
    {
      expression: '"x".split({[Symbol.split]: () => rootDb.delete(flowRuns)})',
      diagnostic: /dynamic\/accessor object property/iu,
    },
    {
      expression: 'String.prototype.trim = input; "x".trim()',
      diagnostic: /native external mutation/iu,
    },
    {
      expression:
        'const pattern = /x/u; pattern[Symbol.split] = input; "x".split(pattern)',
      diagnostic: /native external mutation/iu,
    },
  ])(
    "native trim and split refuse unmodeled coercion or identities: $expression",
    ({ expression, diagnostic }) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (input) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${expression};
      };
    `,
          helper,
        ),
      ).toThrow(diagnostic);
    },
  );

  test.each([
    '"x".trim(rootDb.delete(missingTable))',
    '"x".split(",", 1, rootDb.delete(missingTable))',
  ])(
    "native ignored-argument effects are evaluated before arity validation: %s",
    (expression) => {
      expect(() =>
        analyze(
          `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${expression};
      };
    `,
          helper,
        ),
      ).toThrow(/unresolved delete table/iu);
    },
  );

  test("native split enforces the existing finite array domain", () => {
    const subject = Array.from({ length: 129 }, () => "x").join(",");
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${JSON.stringify(subject)}.split(",");
      };
    `,
        helper,
      ),
    ).toThrow(/native string split exceeds its supported finite domain/iu);
  });

  test.each([
    ["snake_Case", "snake-case"],
    ["camelCase", "camel-case"],
    ["UPPER_CASE", "upper-case"],
    ["ČESKÝ", "český"],
  ])(
    "literal RegExp replacement and lowercasing retain native output for %s",
    (input, expected) => {
      const result = analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const value = ${JSON.stringify(input)}.replace(/_/gu, "-").replace(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, "$<lower>-$<upper>").toLowerCase();
        if (value !== ${JSON.stringify(expected)}) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test.each([
    {
      label: "middle match context",
      subject: "xabz",
      search: "/(a)(b)/u",
      template: "[$$][$&][$`][$']",
      expected: "x[$][ab][x][z]z",
    },
    {
      label: "string search has no captures",
      subject: "xaby",
      search: '"ab"',
      template: "$声|$$|$&|$`|$'|$1|$01|$<name>",
      expected: "x$声|$|ab|x|y|$1|$01|$<name>y",
    },
    {
      label: "unmatched capture and numeric fallback",
      subject: "xabz",
      search: "/(a)(c)?b/u",
      template: "$1|$2|$02|$20|$3|$03",
      expected: "xa|||0|$3|$03z",
    },
    {
      label: "zero capture references stay literal",
      subject: "ab",
      search: "/(a)(b)/u",
      template: "$0|$00|$000|$01|$02",
      expected: "$0|$00|$000|a|b",
    },
    {
      label: "two-digit capture and fallback",
      subject: "abcdefghijkl",
      search: "/(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)/u",
      template: "$12|$13|$09|$99|$100|$001",
      expected: "l|a3|i|i9|j0|$001",
    },
    {
      label: "ninety-nine is a two-digit capture",
      subject: "a".repeat(99),
      search: `/${"(a)".repeat(99)}/u`,
      template: "$99|$100",
      expected: "a|a0",
    },
    {
      label: "missing and unmatched named captures",
      subject: "xabz",
      search: "/(?<first>a)(?<optional>c)?b/u",
      template: "$<first>|$<optional>|$<missing>|$<__proto__>",
      expected: "xa|||z",
    },
    {
      label: "prototype-like named capture is an own value",
      subject: "a",
      search: "/(?<__proto__>a)/u",
      template: "$<__proto__>",
      expected: "a",
    },
    {
      label: "named token without named captures",
      subject: "xabz",
      search: "/ab/u",
      template: "$<missing>",
      expected: "x$<missing>z",
    },
    {
      label: "nested token without named captures",
      subject: "xabz",
      search: "/ab/u",
      template: "$<foo$&>",
      expected: "x$<fooab>z",
    },
    {
      label: "named missing token consumes inner dollar",
      subject: "xabz",
      search: "/(?<first>ab)/u",
      template: "$<foo$&>",
      expected: "xz",
    },
    {
      label: "unterminated named token resumes scanning",
      subject: "xabz",
      search: "/(?<first>ab)/u",
      template: "$<foo$&",
      expected: "x$<fooabz",
    },
    {
      label: "empty missing named capture",
      subject: "xabz",
      search: "/(?<first>ab)/u",
      template: "$<>",
      expected: "xz",
    },
    {
      label: "escaped dollar is not rescanned",
      subject: "xabz",
      search: "/ab/u",
      template: "$$&",
      expected: "x$&z",
    },
    {
      label: "escaped dollar precedes a separate match token",
      subject: "xabz",
      search: "/ab/u",
      template: "$$$&",
      expected: "x$abz",
    },
    {
      label: "capture text is not rescanned",
      subject: "x$&z",
      search: "/(\\$&)/u",
      template: "[$1]-[$&]",
      expected: "x[$&]-[$&]z",
    },
    {
      label: "inserted prefix token capture is not rescanned",
      subject: "x$`z",
      search: "/(\\$`)/u",
      template: "[$1]-[$&]",
      expected: "x[$`]-[$`]z",
    },
    {
      label: "unknown and terminal dollar stay literal",
      subject: "ab",
      search: "/ab/u",
      template: "$q|$",
      expected: "$q|$",
    },
    {
      label: "global matches use their own prefix and suffix",
      subject: "a_a",
      search: "/(a)/gu",
      template: "[$1:$`:$']",
      expected: "[a::_a]_[a:a_:]",
    },
    {
      label: "global sticky matching preserves named and positional captures",
      subject: "abab",
      search: "/(?<first>a)(b)/gy",
      template: "$<first>:$2",
      expected: "a:ba:b",
    },
    {
      label: "global sticky stops at an unmatched boundary",
      subject: "ab-ab",
      search: "/(?<first>a)(b)/gy",
      template: "$<first>:$2",
      expected: "a:b-ab",
    },
    {
      label: "UTF-16 positions preserve surrounding characters",
      subject: "😀a!",
      search: "/(a)/u",
      template: "$`|$'",
      expected: "😀😀|!!",
    },
    {
      label: "empty global matches preserve every insertion position",
      subject: "ab",
      search: "/(?:)/gu",
      template: "[$`:$']",
      expected: "[:ab]a[a:b]b[ab:]",
    },
    {
      label: "unmatched search preserves the subject",
      subject: "abc",
      search: '"missing"',
      template: "$&|$1|$`|$'",
      expected: "abc",
    },
  ])(
    "native replacement substitution follows ECMAScript: $label",
    ({ subject, search, template, expected }) => {
      const result = analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const actual = ${JSON.stringify(subject)}.replace(${search}, ${JSON.stringify(template)});
        if (actual !== ${JSON.stringify(expected)}) write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  const substitutionScenarios = [
    {
      type: "anchored",
      subject: "ab",
      search: "/^(?<first>a)(?<unmatched>c)?(b)$/u",
      prefix: "",
      suffix: "",
    },
    {
      type: "middle",
      subject: "zabq",
      search: "/(?<first>a)(?<unmatched>c)?(b)/u",
      prefix: "z",
      suffix: "q",
    },
    {
      type: "unnamed",
      subject: "zabq",
      search: "/(a)(c)?(b)/u",
      prefix: "z",
      suffix: "q",
    },
    {
      type: "dollar",
      subject: "z$`q",
      search: "/(?<first>\\$`)(?<unmatched>c)?/u",
      prefix: "z",
      suffix: "q",
    },
  ] as const;

  const substitutionAtoms = [
    {
      template: "literal",
      output: {
        anchored: "literal",
        middle: "literal",
        unnamed: "literal",
        dollar: "literal",
      },
    },
    {
      template: "$",
      output: { anchored: "$", middle: "$", unnamed: "$", dollar: "$" },
    },
    {
      template: "$$",
      output: { anchored: "$", middle: "$", unnamed: "$", dollar: "$" },
    },
    {
      template: "$&",
      output: { anchored: "ab", middle: "ab", unnamed: "ab", dollar: "$`" },
    },
    {
      template: "$`",
      output: { anchored: "", middle: "z", unnamed: "z", dollar: "z" },
    },
    {
      template: "$'",
      output: { anchored: "", middle: "q", unnamed: "q", dollar: "q" },
    },
    {
      template: "$1",
      output: { anchored: "a", middle: "a", unnamed: "a", dollar: "$`" },
    },
    {
      template: "$2",
      output: { anchored: "", middle: "", unnamed: "", dollar: "" },
    },
    {
      template: "$3",
      output: { anchored: "b", middle: "b", unnamed: "b", dollar: "$3" },
    },
    {
      template: "$01",
      output: { anchored: "a", middle: "a", unnamed: "a", dollar: "$`" },
    },
    {
      template: "$02",
      output: { anchored: "", middle: "", unnamed: "", dollar: "" },
    },
    {
      template: "$03",
      output: { anchored: "b", middle: "b", unnamed: "b", dollar: "$03" },
    },
    {
      template: "$00",
      output: { anchored: "$00", middle: "$00", unnamed: "$00", dollar: "$00" },
    },
    {
      template: "$10",
      output: { anchored: "a0", middle: "a0", unnamed: "a0", dollar: "$`0" },
    },
    {
      template: "$20",
      output: { anchored: "0", middle: "0", unnamed: "0", dollar: "0" },
    },
    {
      template: "$99",
      output: { anchored: "$99", middle: "$99", unnamed: "$99", dollar: "$99" },
    },
    {
      template: "$<first>",
      output: { anchored: "a", middle: "a", unnamed: "$<first>", dollar: "$`" },
    },
    {
      template: "$<unmatched>",
      output: { anchored: "", middle: "", unnamed: "$<unmatched>", dollar: "" },
    },
    {
      template: "$<missing>",
      output: { anchored: "", middle: "", unnamed: "$<missing>", dollar: "" },
    },
    {
      template: "$<foo$&>",
      output: { anchored: "", middle: "", unnamed: "$<fooab>", dollar: "" },
    },
    {
      template: "$$&",
      output: { anchored: "$&", middle: "$&", unnamed: "$&", dollar: "$&" },
    },
    {
      template: "$1$$",
      output: { anchored: "a$", middle: "a$", unnamed: "a$", dollar: "$`$" },
    },
    {
      template: "$q",
      output: { anchored: "$q", middle: "$q", unnamed: "$q", dollar: "$q" },
    },
  ] as const satisfies readonly {
    template: string;
    output: Record<(typeof substitutionScenarios)[number]["type"], string>;
  }[];

  const SUBSTITUTION_PROPERTY =
    "native replacement templates preserve ECMAScript substitution atoms";

  test(SUBSTITUTION_PROPERTY, () => {
    assertProperty(
      SUBSTITUTION_PROPERTY,
      fc.property(
        fc.constantFrom(...substitutionScenarios),
        fc.array(fc.constantFrom(...substitutionAtoms), {
          minLength: 1,
          maxLength: 20,
        }),
        (scenario, atoms) => {
          // Every atom is complete. Separators prevent adjacent dollar/numeric
          // tokens from changing the independently listed atom meanings.
          const template = atoms.map((atom) => atom.template).join("|");
          const expected =
            scenario.prefix +
            atoms.map((atom) => atom.output[scenario.type]).join("|") +
            scenario.suffix;
          const result = analyze(
            `${header}
          export const run = () => {
            withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
            const actual = ${JSON.stringify(scenario.subject)}.replace(${scenario.search}, ${JSON.stringify(template)});
            if (actual !== ${JSON.stringify(expected)}) write({type: "write", tx: rootDb, table: flowRuns});
          };
        `,
            helper,
          );
          expect(result.reachedRecoveryOwners).toEqual([owner]);
          expect(result.hits).toHaveLength(0);
        },
      ),
    );
  });

  test("literal RegExp aliases preserve global replacement identity across repeated calls", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const pattern = /a/gu;
        pattern.test("a");
        const first = "Aa".replace(pattern, "b").toLowerCase();
        const second = "Aa".replace(pattern, "b").toLowerCase();
        if (first !== "ab" || second !== "ab") write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(0);
  });

  test.each([
    [
      '"x".replace(/x/u, () => rootDb.delete(flowRuns))',
      /native string replacement callback result requires primitive data/iu,
    ],
    ['"x".replace(/x/u, rootDb)', /cannot discard a callable or transaction/iu],
    [
      '"x".replace(/x/u, {toString: () => rootDb.delete(flowRuns)})',
      /cannot discard a callable or transaction/iu,
    ],
    ['"x".replace(/x/u, input)', /literal RegExp and string replacement/iu],
    ['"x".replace(pattern, "y")', /literal RegExp and string replacement/iu],
    [
      '"x".replace({value: "x"}, "y")',
      /literal RegExp and string replacement/iu,
    ],
    ['"x".replace(/x/y, "y")', /sticky non-global/iu],
    ['"x".replace(/x/u, undefined)', /literal RegExp and string replacement/iu],
    [
      '"x".toLowerCase(() => rootDb.delete(flowRuns))',
      /requires no arguments/iu,
    ],
    ['undefined.replace(/x/u, "y")', /unresolved callable/iu],
  ])(
    "unproved string coercion and replacement hooks fail closed: %s",
    (expression, error) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (input, pattern) => {const value = ${expression}; write({type: "write", tx: rootDb, table: flowRuns}); return value;};
    `,
          helper,
        ),
      ).toThrow(error);
    },
  );

  test("custom replace implementations keep their actual callback effects", () => {
    expect(
      analyze(
        `${header}
      const value = {replace: (callback) => callback()};
      export const run = () => value.replace(() => write({type: "write", tx: rootDb, table: flowRuns}));
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    "Array.isArray = input;",
    "const Alias = Array; Alias[key] = input;",
    "const prototype = Array.prototype; prototype.map = input;",
    "JSON.parse = input;",
    "Object.keys = input;",
    "String.prototype.replace = input;",
    "RegExp.prototype.exec = input;",
    "Set.prototype.add = input;",
    "URL.prototype.href = input;",
    "globalThis.Array = input;",
    "const globals = globalThis; globals[key] = input;",
    "const {Array: Alias} = globalThis; Alias.isArray = input;",
    "const globals = globalThis.globalThis; globals.Array = input;",
    "const globals = globalThis.global; globals.JSON = input;",
    "const pattern = /x/u; pattern.lastIndex = 1;",
    "const pattern = /x/u; pattern[key] = input;",
  ])("opaque writes cannot leave native identities trusted: %s", (mutation) => {
    expect(() =>
      analyze(
        `${header}
      export const run = (input, key) => {${mutation} write({type: "write", tx: rootDb, table: flowRuns});};
    `,
        helper,
      ),
    ).toThrow(/native external mutation/iu);
  });

  test.each([
    ['import fs from "node:fs";', "fs.readFileSync = input;"],
    ['import * as fs from "node:fs";', "const alias = fs; alias[key] = input;"],
    ['import {readFileSync as read} from "fs";', "read.extra = input;"],
    ['import path from "node:path";', "path.resolve = input;"],
    ['import * as v from "valibot";', "v.parse = input;"],
    ['import {sql} from "drizzle-orm";', "sql.raw = input;"],
  ])(
    "claimed module aliases cannot be mutated with opaque values: %s",
    (imports, mutation) => {
      expect(() =>
        analyze(
          `${header}
      ${imports}
      export const run = (input, key) => {${mutation} write({type: "write", tx: rootDb, table: flowRuns});};
    `,
          helper,
        ),
      ).toThrow(/native external mutation/iu);
    },
  );

  test.each([
    "Object.assign(Array, {isArray: input});",
    "const assign = Object.assign; const target = Array.prototype; assign(target, {map: input});",
    'Reflect.set(Array, "isArray", input);',
    'const {defineProperty} = Reflect; defineProperty(JSON, "parse", {value: input});',
    'Object.defineProperty(String.prototype, "replace", {value: input});',
    "Object.setPrototypeOf(RegExp.prototype, input);",
    "const target = {nested: [Array]}; Object.assign(target, {data: input});",
    "const pattern = /x/u; Object.defineProperty(pattern, Symbol.replace, {value: input});",
    "const pattern = /x/u; opaque(pattern);",
    'Object.assign("x".constructor, {name: input});',
    'const prototype = Object.getPrototypeOf("x"); Object.assign(prototype, {replace: input});',
  ])(
    "opaque mutators and delegates cannot retain native constructor or prototype targets: %s",
    (mutation) => {
      expect(() =>
        analyze(
          `${header}
      import {opaque} from "opaque-provider";
      export const run = (input) => {${mutation} write({type: "write", tx: rootDb, table: flowRuns});};
    `,
          helper,
        ),
      ).toThrow(/unmodeled delegate receives a native identity/iu);
    },
  );

  test.each([
    "const Alias = Array; process.env.nativeAlias = Alias;",
    "const Alias = Array; input.nativeAlias = Alias;",
  ])(
    "native aliases cannot disappear into opaque data containers: %s",
    (mutation) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (input) => {${mutation} write({type: "write", tx: rootDb, table: flowRuns});};
    `,
          helper,
        ),
      ).toThrow(
        /native identity cannot escape through an opaque external write/iu,
      );
    },
  );

  test("shadowed local namespaces and ordinary external data writes remain analyzed", () => {
    expect(
      analyze(
        `${header}
      export const run = (input, key) => {
        const Array = {isArray: false};
        Array.isArray = input;
        const JSON = {parse: null};
        JSON.parse = input;
        const fs = {readFileSync: null};
        fs.readFileSync = input;
        const local = {value: null};
        Object.assign(local, {value: input});
        Reflect.set(local, "value", input);
        process.env[key] = input;
        Object.assign(process.env, {LOCAL_TEST_VALUE: input});
        globalThis.harmlessData = input;
        write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    "Object.assign(local, {text: input})",
    'Reflect.set(local, "text", input)',
    'Object.defineProperty(local, "text", {value: input})',
    "Object.defineProperties(local, {text: {value: input}})",
  ])(
    "modeled data mutators do not leave stale string literals trusted: %s",
    (mutation) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (input) => {
        const local = {text: "safe"};
        ${mutation};
        if (local.text.toLowerCase() === "danger") write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
          helper,
        ),
      ).toThrow(/native string method requires a proven string receiver/iu);
    },
  );

  test("opaque property descriptors do not discard possible getter callbacks", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = (input) => {
        const local = {text: "safe"};
        Object.defineProperty(local, "text", {get: input});
        write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ),
    ).toThrow(/unmodeled accessor or opaque property descriptor/iu);
  });

  test("dynamic string operations preserve literal interpolation and callback output", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const flag = "first_name";
        const key = \`--\${flag}\`
          .slice(2)
          .replace(/_(?<char>[a-z])/u, (_match, char) => char.toUpperCase());
        if (key !== "firstName") write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(0);
  });

  test("dynamic templates and native slice preserve proven string data", () => {
    expect(
      analyze(
        `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const flag = readFileSync("flag", "utf8");
        const key = \`--\${flag}\`.slice(2).toUpperCase();
        if (typeof key !== "string") write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(0);
  });

  test.each([
    { expression: '"matter_index".indexOf("_")', expected: 6 },
    { expression: '"matter_index".indexOf("_", 6)', expected: 6 },
    { expression: '"matter_index".indexOf("_", undefined)', expected: 6 },
    { expression: '"matter_index".indexOf("_", 7)', expected: -1 },
  ])(
    "literal indexOf returns its exact result: $expression",
    ({ expression, expected }) => {
      const result = analyze(
        `${header}
        export const run = () => {
          withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
          if (${expression} !== ${expected}) rootDb.delete(flowRuns);
        };
      `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test("dynamic string indexOf result remains unknown numeric data", () => {
    const result = analyze(
      `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const name = readFileSync("name", "utf8");
        const underscore = name.indexOf("_");
        const head = name.slice(0, underscore);
        if (typeof head !== "string") rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("dynamic string indexOf does not prove a particular number", () => {
    const result = analyze(
      `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const name = readFileSync("name", "utf8");
        const underscore = name.indexOf("_");
        if (underscore === -1) return;
        rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toContain("delete");
  });

  test.each([
    '"matter_index".indexOf({toString: () => rootDb.delete(flowRuns)})',
    '"matter_index".indexOf("_", {valueOf: () => rootDb.delete(flowRuns)})',
    '"matter_index".indexOf("_", 0, rootDb)',
  ])("indexOf refuses coercive or ignored arguments: %s", (expression) => {
    expect(() =>
      analyze(
        `${header}
          export const run = () => {
            withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
            ${expression};
          };
        `,
        helper,
      ),
    ).toThrow(/native string indexOf requires a literal string search/iu);
  });

  test("a custom indexOf method retains its callback effects", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const name = {indexOf: () => rootDb.delete(flowRuns)};
        name.indexOf("_");
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toContain("delete");
  });

  test.each([
    { expression: '"abcdef".slice("1", true)', expected: "" },
    { expression: '"abcdef".slice(undefined, 3)', expected: "abc" },
  ])(
    "literal slice indexes use native primitive conversion: $expression",
    ({ expression, expected }) => {
      const result = analyze(
        `${header}
        export const run = () => {
          withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
          if (${expression} !== ${JSON.stringify(expected)}) rootDb.delete(flowRuns);
        };
      `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test("slice rejects known coercion callbacks and capabilities", () => {
    expect(() =>
      analyze(
        `${header}
        export const run = () => {
          withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
          "abcdef".slice({valueOf: () => rootDb.delete(flowRuns)});
        };
      `,
        helper,
      ),
    ).toThrow(/operator coercion may invoke mutable tracked data/iu);
    expect(() =>
      analyze(
        `${header}
        export const run = () => {
          withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
          "abcdef".slice(rootDb);
        };
      `,
        helper,
      ),
    ).toThrow(/operator coercion may invoke mutable tracked data/iu);
  });

  test("binary and unary operator data can flow into slice without type loss", () => {
    const result = analyze(
      `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const name = readFileSync("name", "utf8");
        const position = name.indexOf("_") + 1;
        const tail = name.slice(position);
        const unaryPosition = +name.indexOf("_");
        const head = name.slice(unaryPosition);
        if (typeof tail !== "string" || typeof head !== "string") {
          rootDb.delete(flowRuns);
        }
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("generic operator results do not acquire a string type proof", () => {
    const result = analyze(
      `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const name = readFileSync("name", "utf8");
        const position = name.indexOf("_") + 1;
        if (typeof position !== "string") return;
        rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toContain("delete");
  });

  test("logical negation retains boolean type data", () => {
    const result = analyze(
      `${header}
      export const run = (value) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const negated = !value;
        if (typeof negated !== "boolean") rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("void evaluates its operand and returns undefined", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const output = void rootDb.delete(flowRuns);
        if (output !== undefined) rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test("native replace executes callback writes while modeling the returned string", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const key = "first_name".replace(
          /_(?<char>[a-z])/u,
          (_match, char) => {
            write({type: "write", tx: rootDb, table: flowRuns});
            return "n";
          },
        );
        if (key === "firstName") return;
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    '"first".replace(/f/u, (_match, offset) => offset.toUpperCase())',
    '"first".replace(/(z)?/u, (_match, capture) => capture.toUpperCase())',
    '"first".replace(/(?<letter>f)/u, (_match, letter, offset, subject, groups) => groups.toUpperCase())',
  ])(
    "native replace callback parameters keep their actual types: %s",
    (expression) => {
      expect(() =>
        analyze(
          `${header}
      export const run = () => {
        ${expression};
        write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
          helper,
        ),
      ).toThrow(
        /unresolved callable: (?:unresolved member toUpperCase on literal|non-callable literal)/iu,
      );
    },
  );

  test("native replacement validates every callback result alternative", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = (input) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        "first".replace(/f/u, () => input ? input : {toString: () => write({type: "write", tx: rootDb, table: flowRuns})});
      };
    `,
        helper,
      ),
    ).toThrow(
      /native string replacement callback result requires primitive data/iu,
    );
  });

  test("dynamic replacement callback rest arguments stay fail closed", () => {
    expect(() =>
      analyze(
        `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        readFileSync("source", "utf8").replace(/x/u, (...args) => {
          if (args.length > 1) write({type: "write", tx: rootDb, table: flowRuns});
          return "y";
        });
      };
    `,
        helper,
      ),
    ).toThrow(/unsupported binding pattern/iu);
  });

  test("native replace rejects a callback result with custom coercion", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        "first".replace(/f/u, () => ({toString: () => write({type: "write", tx: rootDb, table: flowRuns})}));
        write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ),
    ).toThrow(
      /native string replacement callback result requires primitive data/iu,
    );
  });

  test.each(["input", "String(input)"])(
    "template results stay primitive for opaque data: %s",
    (expression) => {
      const result = analyze(
        `${header}
      export const run = (input) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const key = \`prefix-\${${expression}}\`;
        if (typeof key !== "string") write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test.each([
    {
      label: "transaction handle",
      value: "rootDb",
      diagnostic: /dynamic template interpolation requires primitive data/iu,
    },
    {
      label: "custom toString",
      value:
        '({toString: () => write({type: "write", tx: rootDb, table: flowRuns})})',
      diagnostic: /dynamic template interpolation requires primitive data/iu,
    },
    {
      label: "custom primitive hook",
      value:
        '({[Symbol.toPrimitive]: () => write({type: "write", tx: rootDb, table: flowRuns})})',
      diagnostic: /dynamic\/accessor object property/iu,
    },
  ])(
    "dynamic template interpolation rejects unproved coercion: $label",
    ({ value, diagnostic }) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (input) => {
        const source = ${value};
        const key = \`--\${source}\`;
        write({type: "write", tx: rootDb, table: flowRuns});
        return key;
      };
    `,
          helper,
        ),
      ).toThrow(diagnostic);
    },
  );

  test("native directory names retain proven string data through aliases and containers", () => {
    expect(
      analyze(
        `${header}
      import {readdirSync as read} from "node:fs";
      export const run = (directory) => {
        const values = [...new Set(read(directory))].toSorted();
        for (const filename of values) {
          const original = {value: filename};
          const {value} = {...original};
          value.replace(/_/gu, "-").replace(".json", "").toLowerCase();
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each(['"utf8"', '"utf-8"', '{encoding: "utf8"}'])(
    "native UTF-8 contents remain string data after native replacements: %s",
    (options) => {
      expect(
        analyze(
          `${header}
      import {readFileSync as read} from "node:fs";
      export const run = (filename) => {
        const text = read(filename, ${options}).replace(/_/gu, "-").toLowerCase();
        write({type: "write", tx: rootDb, table: flowRuns});
        return text;
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test.each([
    ["node:path", "join"],
    ["path", "resolve"],
  ])(
    "native path results prove primitive string provenance: %s %s",
    (module, method) => {
      expect(
        analyze(
          `${header}
      import {${method} as build} from ${JSON.stringify(module)};
      export const run = (directory) => {
        build(directory, "file_name").replace(/_/gu, "-").toLowerCase();
        write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test("native string data typeof is exact without guessing its contents", () => {
    expect(
      analyze(
        `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const data = readFileSync("file", "utf8").replace(/x/u, "y");
        if (typeof data !== "string") write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(0);
  });

  test.each([
    'flag ? readFileSync("file", "utf8") : input',
    'flag ? readFileSync("file", "utf8") : rootDb',
    'flag ? readFileSync("file", "utf8") : {replace: () => rootDb.delete(flowRuns)}',
  ])(
    "string-data joins retain every non-string alternative: %s",
    (expression) => {
      expect(() =>
        analyze(
          `${header}
      import {readFileSync} from "node:fs";
      export const run = (flag, input) => {
        const value = ${expression};
        value.replace(/x/u, "y");
        write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
          helper,
        ),
      ).toThrow(/native string method requires a proven string receiver/iu);
    },
  );

  test("string data property reads do not inherit the receiver primitive proof", () => {
    expect(
      analyze(
        `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {
        const data = readFileSync("file", "utf8");
        if (typeof data.length !== "string") write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("native mutators do not misclassify boxed string results as primitive strings", () => {
    expect(() =>
      analyze(
        `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {
        const data = readFileSync("file", "utf8");
        const boxed = Object.assign(data, {value: true});
        if (typeof boxed !== "string") write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ),
    ).toThrow(/native mutator requires a tracked plain data object/iu);
  });

  test("opaque field writes cannot retain a stale primitive string proof", () => {
    expect(() =>
      analyze(
        `${header}
      import {readFileSync} from "node:fs";
      export const run = (input) => {
        const holder = {value: readFileSync("file", "utf8")};
        holder.value = input;
        holder.value.replace(/x/u, "y");
        write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ),
    ).toThrow(/native string method requires a proven string receiver/iu);
  });

  test.each([
    'export const run = (value: string) => {value.replace(/x/u, "y"); write({type: "write", tx: rootDb, table: flowRuns});};',
    'const check = (values) => Array.isArray(values) ? values : undefined; export const run = (input) => {for (const value of check(input) ?? []) {value.replace(/x/u, "y"); write({type: "write", tx: rootDb, table: flowRuns});}};',
    'const check = (values) => Array.isArray(values) && values.every((value) => typeof value === "string") ? values : undefined; export const run = (input) => {for (const value of check(input) ?? []) {value.replace(/x/u, "y"); write({type: "write", tx: rootDb, table: flowRuns});}};',
  ])(
    "annotations and array admission do not invent native string data: %s",
    (source) => {
      expect(() => analyze(`${header}\n${source}`, helper)).toThrow(
        /unmodeled delegate receives a native identity/iu,
      );
    },
  );

  test.each([
    [
      'import * as v from "valibot";',
      "v.safeParse(v.array(v.string()), values)",
    ],
    [
      'import {array, string as text, safeParse as validate} from "valibot";',
      "validate(array(text()), values)",
    ],
  ])(
    "native string schema validates a fresh enum array on its exact success branch: %s",
    (imports, parse) => {
      expect(
        analyze(
          `${header}
      ${imports}
      const enumValues = (schema) => {
        const values = schema["enum"];
        if (values !== undefined) {
          const parsed = ${parse};
          if (!parsed.success) {throw new Error("invalid enum");}
          return parsed.output;
        }
        return undefined;
      };
      const kebabCase = (value) => value.replace(/_/gu, "-").toLowerCase();
      export const run = (schema) => {
        for (const value of enumValues(schema) ?? []) {
          kebabCase(value);
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
          helper,
        ).hits,
      ).toHaveLength(1);
    },
  );

  test.each([
    'if (!other.success) {throw new Error("invalid");}',
    'if (parsed.success) {throw new Error("invalid");}',
    "if (!parsed.success) {observe();}",
    'if (!parsed.success) {throw new Error("invalid");} observe();',
  ])(
    "only an immediate same-result rejecting throw proves native success: %s",
    (guard) => {
      expect(() =>
        analyze(
          `${header}
      import * as v from "valibot";
      const observe = () => true;
      const validated = (input, different) => {
        const parsed = v.safeParse(v.array(v.string()), input);
        const other = v.safeParse(v.array(v.string()), different);
        ${guard}
        return parsed.output;
      };
      export const run = (input, different) => {
        for (const value of validated(input, different)) {
          value.replace(/x/u, "y");
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
          helper,
        ),
      ).toThrow(
        /native string method requires a proven string receiver|unmodeled delegate receives a native identity/iu,
      );
    },
  );

  test("an early success throw cannot refine an output returned by a different closure", () => {
    expect(() =>
      analyze(
        `${header}
      import * as v from "valibot";
      const validated = (input) => {
        const parsed = v.safeParse(v.array(v.string()), input);
        const escaped = () => parsed.output;
        if (!parsed.success) {throw new Error("invalid");}
        return escaped;
      };
      export const run = (input) => {
        for (const value of validated(input)()) {
          value.replace(/x/u, "y");
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
        helper,
      ),
    ).toThrow(
      /native string method requires a proven string receiver|unmodeled delegate receives a native identity/iu,
    );
  });

  test("throwing native string-array parse establishes its returned element types", () => {
    expect(
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = (input) => {
        for (const value of v.parse(v.array(v.string()), input)) {
          value.replace(/_/gu, "-");
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    "parsed.output",
    "other.success ? parsed.output : undefined",
    "parsed.success ? other.output : undefined",
    "({...parsed}).success ? parsed.output : undefined",
  ])(
    "failure output and a different validation result cannot carry a string proof: %s",
    (output) => {
      expect(() =>
        analyze(
          `${header}
      import * as v from "valibot";
      export const run = (input, different) => {
        const parsed = v.safeParse(v.array(v.string()), input);
        const other = v.safeParse(v.array(v.string()), different);
        for (const value of (${output}) ?? []) {
          value.replace(/x/u, "y");
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
          helper,
        ),
      ).toThrow(
        /native string method requires a proven string receiver|unmodeled delegate receives a native identity/iu,
      );
    },
  );

  test("same-parser calls retain separate native result identities in context signatures", () => {
    expect(() =>
      analyze(
        `${header}
      import * as v from "valibot";
      const validate = (input) => v.safeParse(v.array(v.string()), input);
      export const run = (input, different, flag) => {
        const first = validate(input);
        const second = validate(different);
        const selected = flag ? first : second;
        for (const value of (selected.success ? second.output : undefined) ?? []) {
          value.replace(/x/u, "y");
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
        helper,
      ),
    ).toThrow(
      /native string method requires a proven string receiver|unmodeled delegate receives a native identity/iu,
    );
  });

  test.each([
    "parsed.success = true",
    "alias.success = input",
    "parsed.output = input",
    "alias[key] = input",
  ])(
    "tracked result mutation invalidates successful-output proof for every alias: %s",
    (mutation) => {
      expect(() =>
        analyze(
          `${header}
      import * as v from "valibot";
      export const run = (input, key) => {
        const parsed = v.safeParse(v.array(v.string()), input);
        const alias = parsed;
        ${mutation};
        for (const value of (parsed.success ? parsed.output : undefined) ?? []) {
          value.replace(/x/u, "y");
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
          helper,
        ),
      ).toThrow(
        /native string method requires a proven string receiver|unmodeled delegate receives a native identity/iu,
      );
    },
  );

  test.each([
    "mutate(parsed)",
    "Object.assign(parsed, {success: true})",
    'Reflect.set(parsed, "success", true)',
    "new Mutator(parsed)",
    "input.value = parsed",
  ])(
    "opaque validation-result escapes cannot retain a trusted success correlation: %s",
    (mutation) => {
      expect(() =>
        analyze(
          `${header}
      import * as v from "valibot";
      import {mutate, Mutator} from "opaque-provider";
      export const run = (input) => {
        const parsed = v.safeParse(v.array(v.string()), input);
        ${mutation};
        for (const value of (parsed.success ? parsed.output : undefined) ?? []) {
          value.replace(/x/u, "y");
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
          helper,
        ),
      ).toThrow(
        /receives a validation result|validation result cannot escape/iu,
      );
    },
  );

  test("mutating one successful parse output cannot contaminate a later parse of the same schema", () => {
    expect(
      analyze(
        `${header}
      import * as v from "valibot";
      const schema = v.array(v.string());
      export const run = (input) => {
        const first = v.parse(schema, input);
        first.push(rootDb);
        const second = v.parse(schema, input);
        for (const value of second) {
          value.replace(/x/u, "y");
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each([
    [
      'import * as v from "valibot";',
      "const string = () => ({});",
      "v.safeParse(v.array(string()), input)",
    ],
    [
      'import * as v from "valibot";',
      "const vLocal = {string: () => ({})};",
      "v.safeParse(v.array(vLocal.string()), input)",
    ],
    [
      'import * as v from "valibot";',
      "const parse = (schema, value) => ({success: true, output: value});",
      "parse(v.array(v.string()), input)",
    ],
  ])(
    "local string schemas and custom parsers do not mint native output provenance: %s",
    (imports, definitions, expression) => {
      expect(() =>
        analyze(
          `${header}
      ${imports}
      ${definitions}
      export const run = (input) => {
        const parsed = ${expression};
        for (const value of (parsed.success ? parsed.output : undefined) ?? []) {
          value.replace(/x/u, "y");
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
          helper,
        ),
      ).toThrow(/unmodeled delegate receives a native identity/iu);
    },
  );

  test.each([
    '"custom message"',
    "() => rootDb.delete(flowRuns)",
    '(rootDb.delete(flowRuns), "message")',
  ])("native string schema arguments remain unmodeled: %s", (argument) => {
    expect(() =>
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = (input) => {
        const parsed = v.safeParse(v.array(v.string(${argument})), input);
        for (const value of (parsed.success ? parsed.output : undefined) ?? []) {
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
        helper,
      ),
    ).toThrow(/Valibot string schema requires zero arguments/iu);
  });

  test.each([
    "rootDb",
    "[rootDb]",
    '[() => write({type: "write", tx: rootDb, table: flowRuns})]',
  ])(
    "native string-array validation cannot erase known delegated capabilities: %s",
    (input) => {
      expect(() =>
        analyze(
          `${header}
      import * as v from "valibot";
      export const run = () => {
        const parsed = v.safeParse(v.array(v.string()), ${input});
        for (const value of (parsed.success ? parsed.output : undefined) ?? []) {
          value.replace(/x/u, "y");
          write({type: "write", tx: rootDb, table: flowRuns});
        }
      };
    `,
          helper,
        ),
      ).toThrow(
        /Valibot validation receives a transaction capability or callable/iu,
      );
    },
  );

  test("native RegExp methods cannot hide mutable compilation or opaque receiver dispatch", () => {
    for (const operation of [
      'pattern.compile("different")',
      'pattern[method]("different")',
    ]) {
      expect(() =>
        analyze(
          `${header}
        export const run = (method) => {const pattern = /x/u; ${operation}; write({type: "write", tx: rootDb, table: flowRuns});};
      `,
          helper,
        ),
      ).toThrow(/unmodeled native prototype call|dynamic native member call/iu);
    }
  });

  test("a method keeps its scoped receiver captured before argument mutation", () => {
    expect(
      analyze(
        `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {
        write({type: "write", tx, table: flowRuns});
        const handles = [tx];
        handles.at(0).delete((handles.push(rootDb), flowRuns));
        return null;
      }});
    `,
        helper,
      ).hits,
    ).toHaveLength(0);
  });

  test("a side-effecting receiver expression is evaluated once for a method call", () => {
    expect(
      analyze(
        `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {
        write({type: "write", tx, table: flowRuns});
        const once = new Set(["first"]);
        (once.delete("first") ? tx : rootDb).delete(flowRuns);
        return null;
      }});
    `,
        helper,
      ).hits,
    ).toHaveLength(0);
  });

  test("a string method keeps the primitive receiver read before argument writes", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const holder = {value: "A"};
        const result = holder.value.replace((holder.value = "x", /A/u), "B").toLowerCase();
        if (result === "x") write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(0);
  });

  test("argument mutations remain visible through the captured receiver object", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const values = [];
        values.forEach((values.push(rootDb), (tx) => write({type: "write", tx, table: flowRuns})));
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("ordinary callee values stay captured while argument expressions execute", () => {
    expect(
      analyze(
        `${header}
      export const run = () => {
        const once = new Set(["first"]);
        const choose = () => once.has("first") ? () => write({type: "write", tx: rootDb, table: flowRuns}) : () => null;
        choose()(once.delete("first"));
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("ordinary calls retain both argument and captured callee writes", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        const invoke = () => write({type: "write", tx: rootDb, table: flowRuns});
        invoke(rootDb.delete(flowRuns));
      };
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation).toSorted()).toEqual([
      "delete",
      "update",
    ]);
  });

  test("opaque replacement of a captured callable still fails closed", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        const receiver = {f: () => write({type: "write", tx: rootDb, table: flowRuns})};
        receiver.f((receiver.f = () => undefined));
      };
    `,
        helper,
      ),
    ).toThrow(/mutable field retains a transaction capability or callable/iu);
  });

  test.each(["missing", "({}).missing", "(42)", "Array.isArray"])(
    "argument effects precede unknown/non-callable/native dispatch failures: %s",
    (callee) => {
      expect(() =>
        analyze(
          `${header}
      import * as v from "valibot";
      export const run = () => {
        ${callee}(v.string("argument must execute"));
        write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
          helper,
        ),
      ).toThrow(/Valibot string schema requires zero arguments/iu);
    },
  );

  test("computed property effects precede call argument effects", () => {
    expect(() =>
      analyze(
        `${header}
      import * as v from "valibot";
      import {join} from "node:path";
      export const run = () => {
        const receiver = {};
        receiver[(v.string("key must execute"), "missing")](join(123));
        write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ),
    ).toThrow(/Valibot string schema requires zero arguments/iu);
  });

  test("receiver effects precede both computed keys and call arguments", () => {
    expect(() =>
      analyze(
        `${header}
      import * as v from "valibot";
      import {join} from "node:path";
      const receiver = () => join(123);
      export const run = () => {
        receiver()[v.string("key")](v.string("argument"));
        write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ),
    ).toThrow(/native path construction requires string data/iu);
  });

  test("a null optional receiver skips computed keys and argument expressions", () => {
    expect(
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const receiver = null;
        receiver?.[v.string("key")](v.string("argument"));
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(0);
  });

  const assertOpaqueMutationCannotReturnFalseZero = (source: string) => {
    const outcome = Result.try({
      try: () => analyze(source, helper),
      catch: (error) => error,
    });
    if (outcome.isErr()) {
      if (!Panic.is(outcome.error)) {
        panic("Opaque mutation guard produced an unexpected error type");
      }
      expect(outcome.error.message).toContain(
        ": opaque delegate receives mutable tracked data; entry ",
      );
      return;
    }
    expect(outcome.value.reachedRecoveryOwners).toEqual([owner]);
    expect(outcome.value.hits.map(({ operation }) => operation)).toEqual([
      "delete",
    ]);
  };

  test("catch cannot erase a mutable object thrown by the try block", () => {
    const source = (effect: string) => `${header}
      import {opaqueMutate} from "opaque-provider";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const state = {type: "skip"};
        try {
          throw state;
        } catch (error) {
          ${effect}
        }
        if (state.type === "write") rootDb.delete(flowRuns);
      };
    `;
    const baseline = analyze(source(""), helper);
    expect(baseline.reachedRecoveryOwners).toEqual([owner]);
    expect(baseline.hits).toHaveLength(0);
    assertOpaqueMutationCannotReturnFalseZero(source("opaqueMutate(error);"));
  });

  test("catch cannot erase aliases nested in a thrown Set", () => {
    const source = (effect: string) => `${header}
      import {opaqueMutate} from "opaque-provider";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const state = {type: "skip"};
        try {
          throw new Set([state]);
        } catch (error) {
          ${effect}
        }
        if (state.type === "write") rootDb.delete(flowRuns);
      };
    `;
    const baseline = analyze(source(""), helper);
    expect(baseline.reachedRecoveryOwners).toEqual([owner]);
    expect(baseline.hits).toHaveLength(0);
    assertOpaqueMutationCannotReturnFalseZero(source("opaqueMutate(error);"));
  });

  test.each([
    {
      label: "this receiver",
      effect: "opaqueMutate(this);",
      invoke: "state.run();",
    },
    {
      label: "implicit arguments alias",
      effect: "opaqueMutate(arguments[0]);",
      invoke: "state.run(state);",
    },
  ])(
    "opaque method escapes through $label cannot erase outer state",
    ({ effect, invoke }) => {
      const fixture = (methodBody: string) => `${header}
      import {opaqueMutate} from "opaque-provider";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const state = {type: "skip", run() { ${methodBody} }};
        ${invoke}
        if (state.type === "write") rootDb.delete(flowRuns);
      };
    `;
      const baseline = analyze(fixture(""), helper);
      expect(baseline.reachedRecoveryOwners).toEqual([owner]);
      expect(baseline.hits).toHaveLength(0);
      assertOpaqueMutationCannotReturnFalseZero(fixture(effect));
    },
  );

  test.each([
    {
      label: "direct object",
      setup: 'const state = {type: "skip"};',
      mutation: "opaqueMutate(state);",
      after: 'if (state.type === "write") rootDb.delete(flowRuns);',
    },
    {
      label: "aliased object",
      setup: 'const state = {type: "skip"}; const alias = state;',
      mutation: "opaqueMutate(alias);",
      after: 'if (state.type === "write") rootDb.delete(flowRuns);',
    },
    {
      label: "nested object",
      setup: 'const state = {child: {type: "skip"}};',
      mutation: "opaqueMutate(state);",
      after: 'if (state.child.type === "write") rootDb.delete(flowRuns);',
    },
    {
      label: "object wrapper",
      setup: 'const state = {type: "skip"}; const wrapper = {state};',
      mutation: "opaqueMutate(wrapper);",
      after: 'if (state.type === "write") rootDb.delete(flowRuns);',
    },
    {
      label: "array wrapper",
      setup: 'const state = {type: "skip"};',
      mutation: "opaqueMutate([state]);",
      after: 'if (state.type === "write") rootDb.delete(flowRuns);',
    },
    {
      label: "Set wrapper",
      setup: 'const state = {type: "skip"};',
      mutation: "opaqueMutate(new Set([state]));",
      after: 'if (state.type === "write") rootDb.delete(flowRuns);',
    },
    {
      label: "array index",
      setup: 'const state = ["skip"];',
      mutation: "opaqueMutate(state);",
      after: 'if (state.at(0) === "write") rootDb.delete(flowRuns);',
    },
    {
      label: "Set membership",
      setup: 'const state = new Set(["skip"]);',
      mutation: "opaqueMutate(state);",
      after: 'if (state.has("write")) rootDb.delete(flowRuns);',
    },
    {
      label: "empty array extent",
      setup: "const state = [];",
      mutation: "opaqueMutate(state);",
      after: "for (const value of state) rootDb.delete(flowRuns);",
    },
    {
      label: "empty Set extent",
      setup: "const state = new Set();",
      mutation: "opaqueMutate(state);",
      after: "for (const value of state) rootDb.delete(flowRuns);",
    },
    {
      label: "implicit method receiver",
      setup: 'const state = {type: "skip", mutate: opaqueMutate};',
      mutation: "state.mutate();",
      after: 'if (state.type === "write") rootDb.delete(flowRuns);',
    },
    {
      label: "constructor argument",
      setup: 'const state = {type: "skip"};',
      mutation: "new OpaqueMutator(state);",
      after: 'if (state.type === "write") rootDb.delete(flowRuns);',
    },
    {
      label: "external container escape",
      setup: 'const state = {type: "skip"};',
      mutation: "opaqueHolder.state = state;",
      after: 'if (state.type === "write") rootDb.delete(flowRuns);',
    },
    {
      label: "opaque input container escape",
      setup: 'const state = {type: "skip"};',
      mutation: "input.state = state;",
      after: 'if (state.type === "write") rootDb.delete(flowRuns);',
    },
  ])(
    "opaque mutation cannot preserve later privileged branch literals: $label",
    ({ setup, mutation, after }) => {
      const source = (effect: string) => `${header}
      import {opaqueMutate, OpaqueMutator, opaqueHolder} from "opaque-provider";
      export const run = (input) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${setup}
        ${effect}
        ${after}
      };
    `;
      const baseline = analyze(source(""), helper);
      expect(baseline.reachedRecoveryOwners).toEqual([owner]);
      expect(baseline.hits).toHaveLength(0);
      assertOpaqueMutationCannotReturnFalseZero(source(mutation));
    },
  );

  test.each([
    {
      setup: "const schema = v.string();",
      mutation: "opaqueMutate(schema);",
      use: 'v.parse(schema, input).replace(/x/u, "y");',
    },
    {
      setup: "const schema = v.array(v.string());",
      mutation: "opaqueMutate({schema});",
      use: 'v.parse(schema, input).forEach((value) => value.replace(/x/u, "y"));',
    },
    {
      setup: "const schema = v.string();",
      mutation: "new OpaqueMutator(schema);",
      use: 'v.parse(schema, input).replace(/x/u, "y");',
    },
    {
      setup: "const schema = v.string();",
      mutation: "input.schema = schema;",
      use: 'v.parse(schema, input).replace(/x/u, "y");',
    },
  ])(
    "opaque schema escape cannot retain native validation proof: $mutation",
    ({ setup, mutation, use }) => {
      const source = (effect: string) => `${header}
      import * as v from "valibot";
      import {opaqueMutate, OpaqueMutator} from "opaque-provider";
      export const run = (input) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${setup}
        ${effect}
        ${use}
      };
    `;
      const baseline = analyze(source(""), helper);
      expect(baseline.reachedRecoveryOwners).toEqual([owner]);
      expect(baseline.hits).toHaveLength(0);
      expect(() => analyze(source(mutation), helper)).toThrow(
        /opaque delegate receives a native schema/iu,
      );
    },
  );

  test("opaque calls cannot mutate a previously captured primitive value", () => {
    const result = analyze(
      `${header}
      import {opaqueMutate} from "opaque-provider";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const type = "skip";
        opaqueMutate(type);
        if (type === "write") rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test.each([
    '{type: "skip", tx: rootDb}',
    '{type: "skip", callback: () => rootDb.delete(flowRuns)}',
    "[{nested: {tx: rootDb}}]",
  ])(
    "opaque mutation cannot erase known transaction or callback alternatives before checking: %s",
    (value) => {
      expect(() =>
        analyze(
          `${header}
      import {opaqueMutate} from "opaque-provider";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        opaqueMutate(${value});
      };
    `,
          helper,
        ),
      ).toThrow(/receives a transaction or callable/iu);
    },
  );

  test("constructor callee effects precede its single argument evaluation", () => {
    expect(() =>
      analyze(
        `${header}
      import * as v from "valibot";
      import {join} from "node:path";
      export const run = () => {
        new (join(123))(v.string("argument"));
        write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ),
    ).toThrow(/native path construction requires string data/iu);
  });

  test.each(["schedulerJobs", "schedulerJobs.task", 'sql.raw("select 1")'])(
    "opaque calls cannot preserve mutable table/column/SQL identity: %s",
    (value) => {
      expect(() =>
        analyze(
          `${header}
      import {sql} from "drizzle-orm";
      import {opaqueMutate} from "opaque-provider";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        opaqueMutate(${value});
      };
    `,
          helper,
        ),
      ).toThrow(/opaque delegate receives mutable tracked data/iu);
    },
  );

  test("a local module namespace cannot hide an opaque mutable-reference escape", () => {
    expect(() =>
      analyze(
        `${header}
      import * as state from "./fixture-state";
      import {opaqueMutate} from "opaque-provider";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        opaqueMutate(state);
      };
    `,
        helper,
        {
          "apps/api/src/lib/other/fixture-state.ts":
            'export const data = {type: "skip"};',
        },
      ),
    ).toThrow(/opaque delegate receives mutable tracked data/iu);
  });

  test.each([
    {
      label: "Object.assign object source",
      effect:
        "const copied = Object.assign({}, {state}); opaqueMutate(copied.state);",
    },
    {
      label: "Object.assign array source",
      effect:
        "const copied = Object.assign({}, [state]); opaqueMutate(copied[0]);",
    },
    {
      label: "Object.defineProperty value",
      effect:
        'const copied = {}; Object.defineProperty(copied, "state", {value: state}); opaqueMutate(copied.state);',
    },
    {
      label: "Object.defineProperties value",
      effect:
        "const copied = {}; Object.defineProperties(copied, {state: {value: state}}); opaqueMutate(copied.state);",
    },
    {
      label: "Reflect.set value",
      effect:
        'const copied = {}; Reflect.set(copied, "state", state); opaqueMutate(copied.state);',
    },
    {
      label: "Object.setPrototypeOf inherited value",
      effect:
        "const copied = {}; Object.setPrototypeOf(copied, {state}); opaqueMutate(copied.state);",
    },
    {
      label: "native array parse unknown element",
      effect:
        "const copied = v.parse(v.array(v.unknown()), [state]); opaqueMutate(copied[0]);",
    },
    {
      label: "native array safeParse unknown element",
      effect:
        "const parsed = v.safeParse(v.array(v.unknown()), [state]); const copied = parsed.success ? parsed.output : []; opaqueMutate(copied[0]);",
    },
  ])(
    "native data projections cannot drop a mutable alias before opaque escape: $label",
    ({ effect }) => {
      const source = (operation: string) => `${header}
      import * as v from "valibot";
      import {opaqueMutate} from "opaque-provider";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const state = {type: "skip"};
        ${operation}
        if (state.type === "write") rootDb.delete(flowRuns);
      };
    `;
      const baseline = analyze(source(""), helper);
      expect(baseline.reachedRecoveryOwners).toEqual([owner]);
      expect(baseline.hits).toHaveLength(0);
      assertOpaqueMutationCannotReturnFalseZero(source(effect));
    },
  );

  test("an unresolved native schema member cannot disguise a mutable schema escape", () => {
    expect(() =>
      analyze(
        `${header}
      import * as v from "valibot";
      import {opaqueMutate} from "opaque-provider";
      export const run = (input) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const schema = v.string();
        const wrapper = v.array(schema);
        opaqueMutate(wrapper.item);
        v.parse(schema, input).replace(/x/u, "y");
      };
    `,
        helper,
      ),
    ).toThrow(/opaque delegate receives mutable tracked data/iu);
  });

  test("canonical data writes cannot drop a mutable alias into opaque external storage", () => {
    expect(() =>
      analyze(
        `${header}
      import {opaqueHolder} from "opaque-provider";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const state = {type: "skip"};
        Object.assign(opaqueHolder, {state});
        if (state.type === "write") rootDb.delete(flowRuns);
      };
    `,
        helper,
      ),
    ).toThrow(/opaque delegate receives mutable tracked data/iu);
  });

  test.each([
    "const parsed = v.safeParse(v.string(), state); opaqueMutate(parsed.output);",
    "const parsed = v.safeParse(v.array(v.string()), [state]); opaqueMutate(parsed.output[0]);",
    'const parsed = v.safeParse(v.string(), state); const issue = Object.entries(parsed).find(([key]) => key === "issues"); opaqueMutate(issue?.[1]);',
    'Reflect.set({}, "state", state, opaqueHolder);',
  ])(
    "failed validation and explicit storage receivers cannot erase original mutable aliases: %s",
    (effect) => {
      const source = (operation: string) => `${header}
      import * as v from "valibot";
      import {opaqueMutate, opaqueHolder} from "opaque-provider";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const state = {type: "skip"};
        ${operation}
        if (state.type === "write") rootDb.delete(flowRuns);
      };
    `;
      const baseline = analyze(source(""), helper);
      expect(baseline.reachedRecoveryOwners).toEqual([owner]);
      expect(baseline.hits).toHaveLength(0);
      assertOpaqueMutationCannotReturnFalseZero(source(effect));
    },
  );

  test("complete fresh string schemas still accept tracked primitive arrays", () => {
    const result = analyze(
      `${header}
      import * as v from "valibot";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const parsed = v.safeParse(v.array(v.string()), ["safe"]);
        if (!parsed.success) throw new Error("invalid");
        return parsed.output;
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("native opaque-item arrays accept tracked outer arrays of untracked JSON values", () => {
    const result = analyze(
      `${header}
      import * as v from "valibot";
      const entrySchema = v.object({id: v.string()});
      export const run = () => {
        const raw = [JSON.parse("{}")];
        const parsed = v.safeParse(v.array(entrySchema), raw);
        if (!parsed.success) return;
        parsed.output.some(() => write({type: "write", tx: rootDb, table: flowRuns}));
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(1);
  });

  test("native array parse copies its outer container without changing the source", () => {
    expect(
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const original = ["skip"];
        const copied = v.parse(v.array(v.unknown()), original);
        copied.push("write");
        if (original.includes("write")) rootDb.delete(flowRuns);
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(0);
  });

  test("native array safeParse success exposes only its fresh outer container", () => {
    expect(
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const original = ["skip"];
        const parsed = v.safeParse(v.array(v.unknown()), original);
        if (!parsed.success) return;
        const copied = parsed.output;
        copied.push("write");
        if (original.includes("write")) rootDb.delete(flowRuns);
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(0);
  });

  test("nested native array schemas recursively own the copied containers", () => {
    expect(
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const inner = ["skip"];
        const copied = v.parse(v.array(v.array(v.unknown())), [inner]);
        copied.at(0)?.push("write");
        if (inner.includes("write")) rootDb.delete(flowRuns);
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(0);
  });

  test.each(['[{type: "skip"}]', '[["skip"]]'])(
    "an opaque array item cannot drop a known mutable element: %s",
    (input) => {
      expect(() =>
        analyze(
          `${header}
      import * as v from "valibot";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        v.parse(v.array(v.unknown()), ${input});
      };
    `,
          helper,
        ),
      ).toThrow(/opaque delegate receives mutable tracked data/iu);
    },
  );

  test.each([
    ["v.object({id: v.string()})", '{id: "known"}'],
    ["v.pipe(v.array(v.string()), v.minLength(1))", '["known"]'],
  ])(
    "an opaque schema wrapper does not acquire array-container ownership: %s",
    (schema, input) => {
      expect(() =>
        analyze(
          `${header}
      import * as v from "valibot";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        v.parse(${schema}, ${input});
      };
    `,
          helper,
        ),
      ).toThrow(/opaque delegate receives mutable tracked data/iu);
    },
  );

  test("fresh opaque-item array output does not establish primitive string proof", () => {
    expect(() =>
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const raw = [JSON.parse("{}")];
        const parsed = v.safeParse(v.array(v.unknown()), raw);
        if (!parsed.success) return;
        const output = parsed.output;
        output.forEach((value) => value.replace(/x/u, "y"));
      };
    `,
        helper,
      ),
    ).toThrow(/unmodeled delegate receives a native identity/iu);
  });

  test.each(["[rootDb]", "[() => rootDb.delete(flowRuns)]"])(
    "fresh outer ownership never weakens known capability rejection: %s",
    (input) => {
      expect(() =>
        analyze(
          `${header}
      import * as v from "valibot";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        v.safeParse(v.array(v.unknown()), ${input});
      };
    `,
          helper,
        ),
      ).toThrow(
        /Valibot validation receives a transaction capability or callable/iu,
      );
    },
  );

  test("a root-owning module includes its exported state mutators", () => {
    const result = analyze(
      `${header}
      const state = {kind: "skip"};
      export const enable = () => {state.kind = "write";};
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        if (state.kind === "write") rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(1);
  });

  test("joining equal-shaped mutable objects retains every possible alias", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const first = {kind: "skip"};
        const second = {kind: "skip"};
        const selected = flag ? first : second;
        selected.kind = "write";
        if (first.kind === "write") rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(1);
  });

  test("source constructor bodies cannot disappear from the write graph", () => {
    expect(() =>
      analyze(
        `${header}
      function Mutation() {rootDb.delete(flowRuns);}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        new Mutation();
      };
    `,
        helper,
      ),
    ).toThrow(/source constructor dispatch requires an owner model/iu);
  });

  test.each([
    "v.string()",
    "v.array(v.string())",
    "v.array(v.array(v.string()))",
  ])(
    "fresh data output cannot hide mutable config aliases in failed validation issues: %s",
    (schema) => {
      const source = (effect: string) => `${header}
      import * as v from "valibot";
      import {opaqueMutate} from "opaque-provider";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const state = {type: "skip"};
        ${effect}
        if (state.type === "write") rootDb.delete(flowRuns);
      };
    `;
      const baseline = analyze(source(""), helper);
      expect(baseline.reachedRecoveryOwners).toEqual([owner]);
      expect(baseline.hits).toHaveLength(0);
      assertOpaqueMutationCannotReturnFalseZero(
        source(`
      const parsed = v.safeParse(${schema}, JSON.parse("null"), {message: state});
      opaqueMutate(parsed.issues?.[0]?.message);
    `),
      );
    },
  );

  test.each(["parse", "safeParse"])(
    "native %s has no implicit tracked-config mutation contract",
    (method) => {
      expect(() =>
        analyze(
          `${header}
      import * as v from "valibot";
      export const run = (input) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        v.${method}(v.string(), input, {abortEarly: true});
      };
    `,
          helper,
        ),
      ).toThrow(/opaque delegate receives mutable tracked data/iu);
    },
  );

  test("untracked JSON config data does not introduce a known mutable alias", () => {
    const result = analyze(
      `${header}
      import * as v from "valibot";
      export const run = (input) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        v.safeParse(v.string(), input, JSON.parse("{}"));
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("config refusal preserves the earlier known-callback diagnostic", () => {
    expect(() =>
      analyze(
        `${header}
      import * as v from "valibot";
      export const run = (input) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        v.safeParse(v.string(), input, {message: () => rootDb.delete(flowRuns)});
      };
    `,
        helper,
      ),
    ).toThrow(
      /Valibot validation receives a transaction capability or callable/iu,
    );
  });

  test.each([
    {
      label: "array references",
      setup:
        'const first = ["skip"]; const second = ["skip"]; const selected = flag ? first : second;',
      effect: 'selected.push("write");',
      after: 'if (first.includes("write")) rootDb.delete(flowRuns);',
    },
    {
      label: "Set references",
      setup:
        'const first = new Set(["skip"]); const second = new Set(["skip"]); const selected = flag ? first : second;',
      effect: 'selected.add("write");',
      after: 'if (first.has("write")) rootDb.delete(flowRuns);',
    },
    {
      label: "nested object references",
      setup:
        'const first = {state: {kind: "skip"}}; const second = {state: {kind: "skip"}}; const selected = flag ? first : second;',
      effect: 'selected.state.kind = "write";',
      after: 'if (first.state.kind === "write") rootDb.delete(flowRuns);',
    },
    {
      label: "one allocation site in distinct factory contexts",
      setup:
        'const make = (tag) => ({kind: "skip"}); const first = make("left"); const second = make("right"); const selected = flag ? first : second;',
      effect: 'selected.kind = "write";',
      after: 'if (first.kind === "write") rootDb.delete(flowRuns);',
    },
    {
      label: "same-body closures with distinct equal-shaped captures",
      setup:
        'const first = {kind: "skip"}; const second = {kind: "skip"}; const make = (state, tag) => () => {if (state.kind === "write") rootDb.delete(flowRuns);}; const left = make(first, "left"); const right = make(second, "right"); const selected = flag ? left : right;',
      effect: 'first.kind = "write";',
      after: "selected();",
    },
    {
      label: "equal-shaped arguments at one loop callsite",
      setup: 'const first = {kind: "skip"}; const second = {kind: "skip"};',
      effect:
        'const mutate = (item) => {item.kind = "write";}; for (const item of [first, second]) mutate(item);',
      after: 'if (second.kind === "write") rootDb.delete(flowRuns);',
    },
  ])(
    "mutable reference joins and contexts retain identity: $label",
    ({ setup, effect, after }) => {
      const source = (operation: string) => `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${setup}
        ${operation}
        ${after}
      };
    `;
      const baseline = analyze(source(""), helper);
      expect(baseline.reachedRecoveryOwners).toEqual([owner]);
      expect(baseline.hits).toHaveLength(0);
      const mutated = analyze(source(effect), helper);
      expect(mutated.reachedRecoveryOwners).toEqual([owner]);
      expect(mutated.hits.map(({ operation }) => operation)).toEqual([
        "delete",
      ]);
    },
  );

  test.each([
    'const first = {kind: "skip"}; const second = {kind: "skip"};',
    'const make = (tag) => ({kind: "skip"}); const first = make("left"); const second = make("right");',
  ])(
    "a union does not make its distinct original objects must-alias: %s",
    (setup) => {
      const result = analyze(
        `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${setup}
        const selected = flag ? first : second;
        first.kind = "write";
        if (second.kind === "write") rootDb.delete(flowRuns);
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test.each([
    {
      label: "a wrapper object",
      factory:
        'const make = (operation) => ({invoke: () => {if (operation.context.type === "write") write({type: "write", tx: operation.context.tx, table: flowRuns});}});',
      invoke: "wrapped.invoke();",
    },
    {
      label: "a returned closure",
      factory:
        'const make = (operation) => () => {if (operation.context.type === "write") write({type: "write", tx: operation.context.tx, table: flowRuns});};',
      invoke: "wrapped();",
    },
  ])(
    "allocation provenance separates nested raw and scoped contexts in $label",
    ({ factory, invoke }) => {
      const source = (extra: string) => `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {
          write({type: "write", tx, table: flowRuns});
          ${factory}
          const operations = [
            {context: {type: "read", tx: rootDb}},
            {context: {type: "write", tx}},
            ${extra}
          ];
          for (const operation of operations) {
            const wrapped = make(operation);
            ${invoke}
          }
          return null;
        }});
      };
    `;
      const scopedOnly = analyze(source(""), helper);
      expect(scopedOnly.reachedRecoveryOwners).toEqual([owner]);
      expect(scopedOnly.hits).toHaveLength(0);
      const rawWrite = analyze(
        source('{context: {type: "write", tx: rootDb}},'),
        helper,
      );
      expect(rawWrite.reachedRecoveryOwners).toEqual([owner]);
      expect(rawWrite.hits.map(({ operation }) => operation)).toEqual([
        "update",
      ]);
    },
  );

  test("later module initialization revisits an earlier root entry's shared state", () => {
    const stateFile = "apps/api/src/lib/other/shared-state.ts";
    const result = analyze(
      `${header}
      import {state} from "./shared-state";
      const initiallyRead = state.kind;
      withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
      export const run = () => {
        if (state.kind === "write") rootDb.delete(flowRuns);
      };
    `,
      helper,
      {
        [stateFile]: 'export const state = {kind: "skip"};',
        "apps/api/src/lib/other/z-mutate-shared-state.ts": `${header}
        import {state} from "./shared-state";
        state.kind = "write";
        export const initialized = () => null;
      `,
      },
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test.each([
    { loopKind: "const", localKind: "const" },
    { loopKind: "let", localKind: "let" },
  ])(
    "for-of drops iteration-local $loopKind/$localKind bindings without widening references",
    ({ loopKind, localKind }) => {
      const result = analyze(
        `${header}
      const make = (value) => ({value});
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        for (${loopKind} row of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p"]) {
          for (${loopKind} col of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p"]) {
            ${localKind} local = make(\`\${row}\${col}\`);
          }
        }
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test("discarding iteration bindings retains captured branch environments", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        const callbacks = [];
        for (const kind of ["skip", "write"]) {
          const local = {kind};
          callbacks.push(() => {if (local.kind === "write") write({type: "write", tx: rootDb, table: flowRuns});});
        }
        for (const callback of callbacks) callback();
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["update"]);
  });

  test.each(["const", "let", "var"])(
    "for-of %s bindings retain shared outer object mutations",
    (kind) => {
      const result = analyze(
        `${header}
      export const run = () => {
        const target = {kind: "skip"};
        for (${kind} {value} of [{value: "write"}]) {
          const local = target;
          local.kind = value;
        }
        if (target.kind === "write") write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits.map(({ operation }) => operation)).toEqual(["update"]);
    },
  );

  const assertCoercionCannotHideWrite = (source: string) => {
    const outcome = Result.try({
      try: () => analyze(source, helper),
      catch: (error) => error,
    });
    if (outcome.isErr()) {
      if (!Panic.is(outcome.error)) {
        panic("Operator coercion guard produced an unexpected error type");
      }
      expect(outcome.error.message).toMatch(
        /operator coercion may invoke mutable tracked data/iu,
      );
      return;
    }
    expect(outcome.value.reachedRecoveryOwners).toEqual([owner]);
    expect(outcome.value.hits.map(({ operation }) => operation)).toContain(
      "delete",
    );
  };

  const coercionSource = (expression: string) => `${header}
    export const run = () => {
      withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
      const coercible = {
        valueOf: () => { rootDb.delete(flowRuns); return 0; },
        toString: () => { rootDb.delete(flowRuns); return "0"; },
      };
      ${expression};
    };
  `;

  test("loose equality keeps JavaScript coercion uncertainty", () => {
    const loose = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        if ("0" == 0) rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(loose.reachedRecoveryOwners).toEqual([owner]);
    expect(loose.hits.map(({ operation }) => operation)).toContain("delete");

    const strict = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        if ("0" === 0) rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(strict.reachedRecoveryOwners).toEqual([owner]);
    expect(strict.hits).toHaveLength(0);
  });

  test("numeric literal signatures distinguish infinity from null", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const state = flag ? 1e309 : null;
        if (state !== null) rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toContain("delete");
  });

  test.each(["+coercible", "-coercible", "~coercible"])(
    "unary numeric coercion cannot hide a custom conversion write: %s",
    (expression) => assertCoercionCannotHideWrite(coercionSource(expression)),
  );

  test.each([
    { label: "addition", expression: "coercible + 1" },
    { label: "loose equality", expression: "coercible == 1" },
    { label: "relational comparison", expression: "coercible < 1" },
  ])(
    "binary coercion cannot hide a custom conversion write: $label",
    ({ expression }) =>
      assertCoercionCannotHideWrite(coercionSource(expression)),
  );

  test("property-key coercion cannot hide a custom conversion write", () => {
    assertCoercionCannotHideWrite(coercionSource("coercible in {}"));
  });

  test("instanceof cannot pass a root handle to an unknown hasInstance method", () => {
    const outcome = Result.try({
      try: () =>
        analyze(
          `${header}
          export const run = (checker) => {
            withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
            rootDb instanceof checker;
          };
        `,
          helper,
        ),
      catch: (error) => error,
    });
    if (outcome.isErr()) {
      if (!Panic.is(outcome.error)) {
        panic("instanceof capability guard produced an unexpected error type");
      }
      expect(outcome.error.message).toMatch(
        /operator coercion may invoke mutable tracked data/iu,
      );
      return;
    }
    expect(outcome.value.reachedRecoveryOwners).toEqual([owner]);
    expect(outcome.value.hits.map(({ operation }) => operation)).toContain(
      "delete",
    );
  });

  test("instanceof Error accepts an opaque error input", () => {
    const result = analyze(
      `${header}
      export const run = (error) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        if (error instanceof Error) return null;
        return null;
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("typeof and void do not invoke numeric coercion hooks", () => {
    const result = analyze(
      coercionSource("typeof coercible; void coercible"),
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("a mutable array lookup retains its out-of-range undefined branch", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const values = ["x"];
        values.push("x");
        if (values.at(99) === undefined) rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test.each([
    { argument: "", expected: "first" },
    { argument: "undefined", expected: "first" },
    { argument: "0", expected: "first" },
    { argument: "+1", expected: "second" },
    { argument: "1", expected: "second" },
    { argument: "-1", expected: "second" },
    { argument: "-2", expected: "first" },
    { argument: "2", expected: undefined },
    { argument: "-3", expected: undefined },
    { argument: "0.9", expected: "first" },
    { argument: "-1.9", expected: "second" },
    { argument: "1e999", expected: undefined },
  ])(
    "fixed array at uses the exact native index contract: $argument",
    ({ argument, expected }) => {
      const result = analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        if (["first", "second"].at(${argument}) !== ${expected === undefined ? "undefined" : JSON.stringify(expected)}) rootDb.delete(flowRuns);
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test("an unresolved array index retains actual transaction elements and absence", () => {
    const result = analyze(
      `${header}
      export const run = (index) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const values = [rootDb];
        const value = values.at(index);
        if (value === undefined) rootDb.delete(flowRuns);
        if (value !== undefined) write({type: "write", tx: value, table: flowRuns});
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation).toSorted()).toEqual([
      "delete",
      "update",
    ]);
  });

  test.each([
    {
      label: "numeric property",
      read: "const missing = values[99];",
      condition: "missing === undefined",
    },
    {
      label: "numeric string property",
      read: 'const missing = values["99"];',
      condition: "missing === undefined",
    },
    {
      label: "array destructuring",
      read: "const [,,missing] = values;",
      condition: "missing === undefined",
    },
    {
      label: "destructuring default",
      read: 'const [,,missing = "absent"] = values;',
      condition: 'missing === "absent"',
    },
  ])(
    "mutable array absence remains reachable through $label",
    ({ read, condition }) => {
      const result = analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const values = ["x"];
        values.push("x");
        ${read}
        if (${condition}) rootDb.delete(flowRuns);
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
    },
  );

  test.each(["pop", "shift"])(
    "a second native %s retains its empty-array result",
    (method) => {
      const result = analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const values = ["x"];
        values.${method}();
        if (values.${method}() === undefined) rootDb.delete(flowRuns);
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
    },
  );

  test.each([
    { method: "pop", values: '["first", "last"]', expected: "last" },
    { method: "shift", values: '["first", "last"]', expected: "first" },
    { method: "pop", values: "[]", expected: undefined },
    { method: "shift", values: "[]", expected: undefined },
  ])(
    "the first fixed-array $method returns its exact native endpoint: $values",
    ({ method, values, expected }) => {
      const result = analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const values = ${values};
        if (values.${method}() !== ${expected === undefined ? "undefined" : JSON.stringify(expected)}) rootDb.delete(flowRuns);
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test.each([
    { method: "pop", values: "[rootDb, tx]", count: 0 },
    { method: "shift", values: "[tx, rootDb]", count: 0 },
    { method: "pop", values: "[tx, rootDb]", count: 1 },
    { method: "shift", values: "[rootDb, tx]", count: 1 },
  ])(
    "fixed-array $method preserves its actual transaction endpoint: $values",
    ({ method, values, count }) => {
      const result = analyze(
        `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {
        write({type: "write", tx, table: flowRuns});
        const values = ${values};
        const selected = values.${method}();
        selected.delete(flowRuns);
        return null;
      }});
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(count);
    },
  );

  test.each(["pop", "shift"])(
    "native %s retains aliases reachable on a non-removal branch",
    (method) => {
      const result = analyze(
        `${header}
      export const run = (flag) => {
        const callback = () => write({type: "write", tx: rootDb, table: flowRuns});
        const values = [callback];
        if (flag) values.${method}();
        for (const effect of values) effect();
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits.map(({ operation }) => operation)).toEqual(["update"]);
    },
  );

  test.each([
    { key: "00", condition: "=== undefined", count: 1 },
    { key: "01", condition: "=== undefined", count: 1 },
    { key: "0", condition: '!== "first"', count: 0 },
    { key: "1", condition: '!== "last"', count: 0 },
  ])(
    "array numeric property recognition preserves canonical spelling: $key",
    ({ key, condition, count }) => {
      const result = analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const values = ["first", "last"];
        if (values[${JSON.stringify(key)}] ${condition}) rootDb.delete(flowRuns);
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(count);
    },
  );

  test.each([
    {
      label: "continue update",
      statements:
        "const values = [0, 1]; for (let index = 0; index < values.length; index += 1) {if (index === 0) continue; rootDb.delete(flowRuns);}",
      operations: ["delete"],
    },
    {
      label: "normal slot update",
      statements:
        'let tx = rootDb; const values = [0]; for (let index = 0; index < values.length; index += 1) {tx = scoped;} write({type: "write", tx, table: flowRuns});',
      operations: [],
    },
    {
      label: "continuing slot update",
      statements:
        'let tx = scoped; const values = [0, 1]; for (let index = 0; index < values.length; index += 1) {if (index === 0) {tx = rootDb; continue;} write({type: "write", tx, table: flowRuns});}',
      operations: ["update"],
    },
    {
      label: "breaking slot update",
      statements:
        'let tx = scoped; const values = [0, 1]; for (let index = 0; index < values.length; index += 1) {tx = rootDb; break;} write({type: "write", tx, table: flowRuns});',
      operations: ["update"],
    },
    {
      label: "return completion",
      statements:
        'const choose = () => {const values = [0]; for (let index = 0; index < values.length; index += 1) {return scoped;} return rootDb;}; write({type: "write", tx: choose(), table: flowRuns});',
      operations: [],
    },
    {
      label: "throw completion",
      statements:
        "const values = [0]; for (let index = 0; index < values.length; index += 1) {rootDb.delete(flowRuns); throw null; rootDb.update(flowRuns);}",
      operations: ["delete"],
    },
    {
      label: "saved receiver",
      statements:
        'let tx = rootDb; const saved = tx; const values = [0]; for (let index = 0; index < values.length; index += 1) {tx = scoped;} write({type: "write", tx: saved, table: flowRuns});',
      operations: ["update"],
    },
    {
      label: "finite allocation positions",
      statements:
        "const root = {next: null}; let node = root; const values = [0, 1]; for (let index = 0; index < values.length; index += 1) {const created = {next: null}; node.next = created; node = created;} return root;",
      operations: [],
    },
    {
      label: "zero iterations",
      statements:
        'let tx = scoped; for (let index = 0; index < 0; index += 1) {tx = rootDb;} write({type: "write", tx, table: flowRuns});',
      operations: [],
    },
  ])(
    "bounded counted-for preserves control and receiver state: $label",
    ({ statements, operations }) => {
      const result = analyze(
        `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
        write({type: "write", tx: scoped, table: flowRuns});
        ${statements}
        return null;
      }});
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits.map(({ operation }) => operation)).toEqual([
        ...operations,
      ]);
    },
  );

  test.each([
    {
      source:
        'let tx = scoped; const later = () => write({type: "write", tx, table: flowRuns}); for (let index = 0; index < 1; index += 1) {tx = rootDb;} later();',
      failure: /captured mutable binding/iu,
    },
    {
      source:
        "for (let index = 0; index < 1; index += 1) {const later = () => index; later();}",
      failure: /captured mutable binding/iu,
    },
    {
      source:
        "let tx = scoped; try {for (let index = 0; index < 1; index += 1) {tx = rootDb;}} catch {}",
      failure: /exception boundary/iu,
    },
    {
      source:
        'let tx = scoped; for (let index = 0; index < 1; index += 1) {eval("tx = rootDb");}',
      failure: /dynamic lexical evaluation/iu,
    },
    {
      source: "for (let index = 0; index < 1; index += 1) {index = 0;}",
      failure: /induction variable/iu,
    },
    {
      source:
        "const values = {length: 1}; for (let index = 0; index < values.length; index += 1) {}",
      failure: /finite array extent/iu,
    },
    {
      source:
        "const tx = scoped; for (let index = 0; index < 1; index += 1) {tx = rootDb;}",
      failure: /local let binding/iu,
    },
    {
      source:
        'let tx = scoped; for (let index = 0; index < 1; index += 1) {tx += "suffix";}',
      failure: /local slot assignment/iu,
    },
    {
      source: "for (let index = 0; index < 1; index++) {}",
      failure: /counted loop update/iu,
    },
    {
      source: "for (let index = 0; index < 100001; index += 1) {}",
      failure: /finite work budget/iu,
    },
    {
      source:
        "const values = [0]; for (let index = 0; index < values.length; index += 1) {values.push(0);}",
      failure: /finite array extent/iu,
    },
  ])(
    "bounded counted-for refuses an unproved state transition: $source",
    ({ source, failure }) => {
      expect(() =>
        analyze(
          `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
        write({type: "write", tx: scoped, table: flowRuns});
        ${source}
        return null;
      }});
    `,
          helper,
        ),
      ).toThrow(failure);
    },
  );

  test.each([
    {
      label: "literal",
      source: 'const values = ["x", "y"];',
      forbiddenIndex: 2,
    },
    {
      label: "alternative maximum",
      source:
        'const selected = flag ? ["a"] : ["b", "c", "d"]; const values = ["first", ...selected, "last"];',
      forbiddenIndex: 5,
    },
    {
      label: "callback outputs",
      source:
        "const values = [1, 2, 3].map((value) => value).filter(() => flag).toSorted();",
      forbiddenIndex: 3,
    },
    {
      label: "fixed literal Set",
      source: 'const values = [...new Set(["a", "a", "b"])];',
      forbiddenIndex: 2,
    },
    {
      label: "literal split",
      source: 'const values = "a,b".split(",");',
      forbiddenIndex: 2,
    },
    {
      label: "delegated spread",
      source:
        'const copy = (source) => [...source]; const values = copy(flag ? ["a"] : ["b", "c", "d"]);',
      forbiddenIndex: 3,
    },
  ])(
    "bounded counted-for consumes truthful finite extent: $label",
    ({ source, forbiddenIndex }) => {
      const result = analyze(
        `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${source}
        for (let index = 0; index < values.length; index += 1) {
          if (index === ${forbiddenIndex}) rootDb.delete(flowRuns);
        }
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test("bounded counted-for sums separate spread maxima rather than taking their maximum", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const first = flag ? ["a"] : ["b", "c"];
        const values = [...first, "d", "e"];
        for (let index = 0; index < values.length; index += 1) {
          if (index === 3) rootDb.delete(flowRuns);
        }
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(1);
  });

  test.each([
    'values.push("same");',
    'values.unshift("same");',
    'values.splice(0, 0, "same");',
    "values.pop();",
    "values.shift();",
    'const alias = values; alias.push("same");',
  ])(
    "bounded counted-for refuses an extent invalidated by an in-place mutation: %s",
    (effect) => {
      expect(() =>
        analyze(
          `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const values = ["same"];
        ${effect}
        for (let index = 0; index < values.length; index += 1) {}
      };
    `,
          helper,
        ),
      ).toThrow(/finite array extent/iu);
    },
  );

  test.each([
    {
      label: "native schema output",
      source: "const values = v.parse(v.array(v.string()), input);",
    },
    {
      label: "native file listing",
      source: 'const values = readdirSync("directory");',
    },
    {
      label: "mutable Set spread",
      source:
        'const set = new Set(["same"]); set.add("same"); const values = [...set];',
    },
  ])(
    "bounded counted-for cannot invent a finite extent for $label",
    ({ source }) => {
      expect(() =>
        analyze(
          `${header}
      import * as v from "valibot";
      import {readdirSync} from "node:fs";
      export const run = (input) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${source}
        for (let index = 0; index < values.length; index += 1) {}
      };
    `,
          helper,
        ),
      ).toThrow(/finite array extent/iu);
    },
  );

  test.each([
    { value: "", length: 0 },
    { value: "ascii", length: 5 },
    { value: "💼", length: 2 },
    { value: "e\u0301", length: 2 },
  ])(
    "native literal string length counts UTF-16 code units: $value",
    ({ value, length }) => {
      const result = analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        if (${JSON.stringify(value)}.length !== ${length}) rootDb.delete(flowRuns);
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test.each([
    { value: "[]", length: 0 },
    { value: '["x"]', length: 1 },
    { value: '["x", "y"]', length: 2 },
    { value: "[,,]", length: 2 },
    { value: '[["x", "y"]]', length: 1 },
  ])(
    "native fixed array length retains its exact extent: $value",
    ({ value, length }) => {
      const result = analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        if ((${value}).length !== ${length}) rootDb.delete(flowRuns);
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test.each([
    { effect: 'values.push("x");', condition: "values.length !== 1" },
    { effect: "values.pop();", condition: "values.length === 0" },
    { effect: "values.shift();", condition: "values.length === 0" },
  ])(
    "mutable array length never becomes its retained value count: $effect",
    ({ effect, condition }) => {
      const result = analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const values = ["x"];
        ${effect}
        if (${condition}) rootDb.delete(flowRuns);
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
    },
  );

  test("native uncertain string length does not retain a string output proof", () => {
    const result = analyze(
      `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const length = readFileSync("description", "utf8").length;
        if (typeof length !== "string") rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test("native field metadata does not replace a custom object's length field", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const custom = {length: "authored"};
        if (custom.length !== "authored") rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("custom length getters still require an explicit accessor model", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const custom = {get length() {rootDb.delete(flowRuns); return 0;}};
        return custom.length;
      };
    `,
        helper,
      ),
    ).toThrow(/dynamic\/accessor object property/iu);
  });

  test("typeof results are strings without narrowing the operand", () => {
    const result = analyze(
      `${header}
      export const run = (input, flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const kind = flag ? typeof input : "";
        kind.trim();
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
    expect(() =>
      analyze(
        `${header}
      export const run = (input, flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const kind = flag ? typeof input : "";
        kind.trim();
        const unchanged = flag ? input : "";
        unchanged.trim();
      };
    `,
        helper,
      ),
    ).toThrow(/native string method requires a proven string receiver/iu);
  });

  test("an immediate typeof-string projection preserves the checked description", () => {
    const result = analyze(
      `${header}
      import {readFileSync} from "node:fs";
      const describe = (description) => description.trim().split(/(?<=[.!?])s+/u).at(0)?.trim();
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const entry = JSON.parse(readFileSync("registry", "utf8"));
        const description = entry["description"];
        const listings = [];
        listings.push({description: typeof description === "string" ? description : ""});
        for (const listing of listings) describe(listing.description);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("an immediate typeof-string projection retains an exact literal", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const description = "  Authored text  ";
        const projected = typeof description === "string" ? description : "";
        if (projected.trim() !== "Authored text") rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(0);
  });

  test.each(["rootDb", "flowRuns", "null", "123", "[]", "{}"])(
    "an immediate typeof-string test cannot select a known non-string: %s",
    (value) => {
      const result = analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const description = ${value};
        const projected = typeof description === "string" ? description : "fallback";
        if (projected.trim() !== "fallback") rootDb.delete(flowRuns);
      };
    `,
        helper,
      );
      expect(result.hits).toHaveLength(0);
    },
  );

  test.each([
    'typeof other === "string" ? value : ""',
    'typeof alias === "string" ? value : ""',
    'typeof value === "string" ? alias : ""',
    'typeof box.description === "string" ? box.description : ""',
    '(observe(), typeof value === "string") ? value : ""',
    'typeof value === "string" ? (observe(), value) : ""',
    'typeof value === "string" ? (box.description = other, value) : ""',
    'typeof value === "string" ? keep(value) : ""',
    'typeof value === "string" ? (() => value)() : ""',
    'typeof value == "string" ? value : ""',
    'typeof value !== "string" ? value : ""',
    'typeof value === "string" ? (value as string) : ""',
    'typeof value === "string" ? value : rootDb',
  ])(
    "typeof-string proof stays on the exact immediate identifier output: %s",
    (expression) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (input, otherInput) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const value = input;
        const other = otherInput;
        const alias = value;
        const box = {description: value};
        const observe = () => null;
        const keep = (data) => data;
        const projected = ${expression};
        projected.trim();
      };
    `,
          helper,
        ),
      ).toThrow(/native string method requires a proven string receiver/iu);
    },
  );

  test.each([
    'const unchanged = flag ? value : "";',
    'const captured = () => value; const unchanged = flag ? captured() : "";',
  ])(
    "a projected output does not narrow later reads or closures: %s",
    (read) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (input, flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const value = input;
        const projected = typeof value === "string" ? value : "";
        projected.trim();
        ${read}
        unchanged.trim();
      };
    `,
          helper,
        ),
      ).toThrow(/native string method requires a proven string receiver/iu);
    },
  );

  test.each([
    '(rootDb.delete(missingTable), typeof value === "string") ? value : ""',
    'typeof value === "string" ? (rootDb.delete(missingTable), value) : ""',
  ])(
    "typeof projection modeling still evaluates every guard and consequent effect: %s",
    (expression) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (input) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const value = input;
        const projected = ${expression};
        projected.trim();
      };
    `,
          helper,
        ),
      ).toThrow(/unresolved delete table/iu);
    },
  );

  test("typeof member checks do not admit getters as stable string reads", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const box = {get description() {rootDb.delete(flowRuns); return "text";}};
        const projected = typeof box.description === "string" ? box.description : "";
        projected.trim();
      };
    `,
        helper,
      ),
    ).toThrow(/dynamic\/accessor object property/iu);
  });

  test("an annotation conditional checks the immediate destructured parameter receiver", () => {
    const result = analyze(
      `${header}
      const discriminator = ({annotation}) => annotation ? annotation.discriminator?.prop : undefined;
      export const run = (name) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const annotations = {present: {discriminator: {prop: "action"}}, plain: {}};
        const annotation = annotations[name];
        const discriminatorProp = discriminator({annotation});
        const properties = {action: {enum: ["create"]}};
        if (discriminatorProp !== undefined) {
          const schema = properties[discriminatorProp];
        }
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test.each(["undefined", "null", "false", "0", '""'])(
    "an immediate truthy receiver excludes the falsey literal %s only on its selected read",
    (falsey) => {
      const result = analyze(
        `${header}
      const discriminator = (annotation) => annotation ? annotation.discriminator?.prop : undefined;
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const annotation = flag ? {discriminator: {prop: "action"}} : ${falsey};
        const discriminatorProp = discriminator(annotation);
        const properties = {action: {enum: ["create"]}};
        if (discriminatorProp !== undefined) properties[discriminatorProp];
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test.each(["true", "1", '"text"'])(
    "an immediate truthy receiver retains the truthy literal %s",
    (truthy) => {
      expect(() =>
        analyze(
          `${header}
      const discriminator = (annotation) => annotation ? annotation.discriminator?.prop : undefined;
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const annotation = flag ? {discriminator: {prop: "action"}} : ${truthy};
        const discriminatorProp = discriminator(annotation);
        const properties = {action: {enum: ["create"]}};
        if (discriminatorProp !== undefined) properties[discriminatorProp];
      };
    `,
          helper,
        ),
      ).toThrow(/operator coercion may invoke mutable tracked data/iu);
    },
  );

  test("an immediate truthy read retains the original transaction-bearing object", () => {
    const result = analyze(
      `${header}
      const select = ({value, fallback}) => value ? value.operation : fallback;
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const value = flag ? {operation: {type: "write", tx: rootDb, table: flowRuns}} : undefined;
        const operation = select({value, fallback: {type: "write", tx: rootDb, table: flowRuns}});
        write(operation);
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(1);
  });

  test.each([
    [
      "annotation ? other.discriminator?.prop : undefined",
      /operator coercion may invoke mutable tracked data/iu,
    ],
    [
      "annotation ? (observe(), annotation.discriminator?.prop) : undefined",
      /operator coercion may invoke mutable tracked data/iu,
    ],
    [
      "annotation ? (() => annotation.discriminator?.prop)() : undefined",
      /operator coercion may invoke mutable tracked data/iu,
    ],
    [
      "annotation ? later() : undefined",
      /operator coercion may invoke mutable tracked data/iu,
    ],
    [
      "annotation ? holder[(observe(), annotation.discriminator?.prop)] : undefined",
      /operator coercion may invoke mutable tracked data/iu,
    ],
    [
      "annotation ? holder[(annotation = undefined, annotation.discriminator?.prop)] : undefined",
      /mutable state requires an alias\/control-flow state model/iu,
    ],
  ])(
    "a truthy condition cannot lend its fact across another read or effect: %s",
    (expression, expected) => {
      expect(() =>
        analyze(
          `${header}
      const discriminator = (annotation, other) => {
        const observe = () => rootDb.delete(flowRuns);
        const later = () => annotation.discriminator?.prop;
        const holder = {action: "action"};
        return ${expression};
      };
      export const run = (name) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const annotations = {present: {discriminator: {prop: "action"}}};
        const annotation = annotations[name];
        const discriminatorProp = discriminator(annotation, annotation);
        const properties = {action: {enum: ["create"]}};
        if (discriminatorProp !== undefined) properties[discriminatorProp];
      };
    `,
          helper,
        ),
      ).toThrow(expected);
    },
  );

  test("a suspended truthy test cannot refine its later receiver read", () => {
    expect(() =>
      analyze(
        `${header}
      const discriminator = async (annotation) => (await annotation) ? annotation.discriminator?.prop : undefined;
      export const run = async (name) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const annotations = {present: {discriminator: {prop: "action"}}};
        const discriminatorProp = await discriminator(annotations[name]);
        const properties = {action: {enum: ["create"]}};
        if (discriminatorProp !== undefined) properties[discriminatorProp];
      };
    `,
        helper,
      ),
    ).toThrow(/awaited value requires an explicit owner model/iu);
  });

  test("an immediate truthy read does not change later reads of the binding", () => {
    expect(() =>
      analyze(
        `${header}
      const discriminator = (annotation) => {
        const checked = annotation ? annotation.discriminator?.prop : undefined;
        return annotation.discriminator?.prop;
      };
      export const run = (name) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const annotations = {present: {discriminator: {prop: "action"}}};
        const discriminatorProp = discriminator(annotations[name]);
        const properties = {action: {enum: ["create"]}};
        if (discriminatorProp !== undefined) properties[discriminatorProp];
      };
    `,
        helper,
      ),
    ).toThrow(/operator coercion may invoke mutable tracked data/iu);
  });

  test("an immediate truthy read never grants an input value string authority", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = (input) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const selected = input ? input : "";
        selected.trim();
      };
    `,
        helper,
      ),
    ).toThrow(/native string method requires a proven string receiver/iu);
  });

  test("a computed discriminator initializer retains its actual own value", () => {
    const result = analyze(
      `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const properties = JSON.parse(readFileSync("schema", "utf8"));
        const discriminatorProp = Object.keys(properties).find(() => true);
        if (discriminatorProp !== undefined) {
          const spec = {discriminatorInject: {[discriminatorProp]: "search"}};
          const copy = {...spec.discriminatorInject};
        }
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test.each([
    { key: '"authored"', name: "authored" },
    { key: "null", name: "null" },
    { key: "undefined", name: "undefined" },
    { key: "true", name: "true" },
    { key: "false", name: "false" },
    { key: "1", name: "1" },
    { key: "-0", name: "0" },
    { key: "1.5", name: "1.5" },
  ])(
    "computed literal keys use primitive ToPropertyKey spelling: $key",
    ({ key, name }) => {
      const result = analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const value = {[${key}]: "stored"};
        if (value[${JSON.stringify(name)}] !== "stored") rootDb.delete(flowRuns);
      };
    `,
        helper,
      );
      expect(result.hits).toHaveLength(0);
    },
  );

  test("computed initializer key evaluation precedes its stored value", () => {
    const result = analyze(
      `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {
        write({type: "write", tx, table: flowRuns});
        const handles = [tx];
        const value = {[(handles.push(rootDb), "selected")]: handles.at(-1)};
        value.selected.delete(flowRuns);
        return null;
      }});
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test("a computed initializer evaluates its key only once", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const keys = ["selected"];
        const value = {[keys.pop()]: "stored"};
        if (value.selected !== "stored") rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(0);
  });

  test("computed key coercion is checked before evaluating its initializer", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const key = {toString: () => {rootDb.delete(flowRuns); return "selected";}};
        const value = {[key]: new Unmodeled()};
      };
    `,
        helper,
      ),
    ).toThrow(/operator coercion may invoke mutable tracked data/iu);
  });

  test("computed own fields retain delegated row table and transaction identities", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        const key = "operation";
        const value = {[key]: {type: "write", tx: rootDb, table: flowRuns}};
        write(value.operation);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["update"]);
  });

  test("unknown computed string keys retain callable values", () => {
    const result = analyze(
      `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const key = readFileSync("key", "utf8");
        const value = {[key]: () => rootDb.delete(flowRuns)};
        for (const callback of Object.values(value)) callback();
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test("unknown computed string keys retain mutable aliases before opaque escape", () => {
    expect(() =>
      analyze(
        `${header}
      import {readFileSync} from "node:fs";
      import {opaqueMutate} from "opaque-provider";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const key = readFileSync("key", "utf8");
        const state = {kind: "skip"};
        const value = {[key]: state};
        for (const row of Object.values(value)) opaqueMutate(row);
        if (state.kind === "write") rootDb.delete(flowRuns);
      };
    `,
        helper,
      ),
    ).toThrow(/opaque delegate receives mutable tracked data/iu);
  });

  test("a finite computed key choice keeps possible own-key absence", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const key = flag ? "kind" : "other";
        const value = {[key]: "stored"};
        if (value.kind === undefined) rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test("an uncertain computed overwrite retains the previous callable", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const key = flag ? "callback" : "other";
        const value = {callback: () => rootDb.delete(flowRuns), [key]: () => null};
        value.callback();
      };
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test("a definite computed overwrite keeps ordinary last-property semantics", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const key = "callback";
        const value = {callback: () => rootDb.delete(flowRuns), [key]: () => null};
        value.callback();
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(0);
  });

  test("native fromEntries preserves raw operation and callback values", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const operation = {type: "write", tx: rootDb, table: flowRuns};
        const value = Object.fromEntries([
          ["operation", operation],
          ["invoke", () => rootDb.delete(flowRuns)],
        ]);
        write(value.operation);
        value.invoke();
      };
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation).toSorted()).toEqual([
      "delete",
      "update",
    ]);
  });

  test("native fromEntries uses the last fixed duplicate key without promoting scoped authority", () => {
    const result = analyze(
      `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
        write({type: "write", tx: scoped, table: flowRuns});
        const value = Object.fromEntries([["tx", rootDb], ["tx", scoped]]);
        write({type: "write", tx: value.tx, table: flowRuns});
        return null;
      }});
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("native fromEntries defines __proto__ as ordinary own data", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const value = Object.fromEntries([["__proto__", "owned"]]);
        const copy = {...value};
        if (!Object.hasOwn(value, "__proto__")) rootDb.delete(flowRuns);
        if (copy.__proto__ !== "owned") rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("native fromEntries retains raw values under a dynamic proven string key", () => {
    const result = analyze(
      `${header}
      export const run = (input) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const key = String(input);
        const value = Object.fromEntries([[key, {type: "write", tx: rootDb, table: flowRuns}]]);
        for (const operation of Object.values(value)) write(operation);
      };
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation)).toEqual(["update"]);
  });

  test("native fromEntries retains entry and outer iterable alternatives", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
        write({type: "write", tx: scoped, table: flowRuns});
        const pair = flag
          ? ["operation", {type: "write", tx: rootDb, table: flowRuns}]
          : ["operation", {type: "write", tx: scoped, table: flowRuns}];
        const entries = flag ? [pair] : new Set([pair]);
        const value = Object.fromEntries(entries);
        for (const operation of Object.values(value)) write(operation);
        return null;
      }});
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation)).toEqual(["update"]);
  });

  test("native fromEntries keeps value object aliases rather than cloning them", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const state = {active: false};
        const value = Object.fromEntries([["state", state]]);
        state.active = true;
        if (value.state.active) rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test("native fromEntries refuses a source function in place of its native iterable", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const entries = () => {rootDb.delete(flowRuns); return [];};
        Object.fromEntries(entries);
      };
    `,
        helper,
      ),
    ).toThrow(/Object.fromEntries requires a native array or Set iterable/iu);
  });

  test("a custom fromEntries iterable cannot hide a source iterator callback", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const entries = {[Symbol.iterator]: () => {rootDb.delete(flowRuns); return null;}};
        Object.fromEntries(entries);
      };
    `,
        helper,
      ),
    ).toThrow(/dynamic\/accessor object property/iu);
  });

  test("native fromEntries cannot erase custom key coercion callbacks", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const key = {toString: () => {rootDb.delete(flowRuns); return "key";}};
        Object.fromEntries([[key, "value"]]);
      };
    `,
        helper,
      ),
    ).toThrow(/operator coercion may invoke mutable tracked data/iu);
  });

  test("a computed __proto__ key is own data through fields, enumeration, spread and rest", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const key = "__proto__";
        const value = {[key]: "owned"};
        if (!Object.hasOwn(value, "__proto__")) rootDb.delete(flowRuns);
        if (value.__proto__ !== "owned") rootDb.delete(flowRuns);
        if (Object.keys(value).at(0) !== "__proto__") rootDb.delete(flowRuns);
        if (Object.values(value).at(0) !== "owned") rootDb.delete(flowRuns);
        const copy = {...value};
        const {missing, ...rest} = value;
        if (copy.__proto__ !== "owned") rootDb.delete(flowRuns);
        if (rest.__proto__ !== "owned") rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test.each([
    "const value = {__proto__: {inherited: true}};",
    'const value = {__proto__: {inherited: true}, ["__proto__"]: "owned"};',
    "const value = {}; Object.setPrototypeOf(value, {inherited: true});",
    "const value = {}; Reflect.setPrototypeOf(value, {inherited: true});",
    'const value = {}; Reflect.set(value, "__proto__", {inherited: true});',
    'const value = {}; Object.assign(value, {["__proto__"]: {inherited: true}});',
    "const value = {}; value.__proto__ = {inherited: true};",
  ])(
    "prototype effects cannot be upgraded by ordinary own-data copying: %s",
    (setup) => {
      expect(() =>
        analyze(
          `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${setup}
        const copy = {...value};
      };
    `,
          helper,
        ),
      ).toThrow(/object spread cannot preserve unknown delegated fields/iu);
    },
  );

  test.each([
    '{[{toString: () => rootDb.delete(flowRuns)}]: "stored"}',
    '{[rootDb]: "stored"}',
    '{[flowRuns]: "stored"}',
  ])(
    "computed keys reject known custom ToPropertyKey behavior: %s",
    (expression) => {
      expect(() =>
        analyze(
          `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const value = ${expression};
      };
    `,
          helper,
        ),
      ).toThrow(/operator coercion may invoke mutable tracked data/iu);
    },
  );

  test.each([
    '{[input]: "stored"}',
    '{[input as string]: "stored"}',
    '{get ["description"]() {rootDb.delete(flowRuns); return "stored";}}',
  ])(
    "computed properties require real string provenance and data initializers: %s",
    (expression) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (input) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const value = ${expression};
      };
    `,
          helper,
        ),
      ).toThrow(/dynamic\/accessor object property/iu);
    },
  );

  test("optional spread fields retain their missing-property result", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const data = {...(flag ? {value: "present"} : {})};
        if (data.value === undefined) rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test.each([
    "{...(flag ? {toString: () => undefined} : {})}",
    '{[flag ? "toString" : "other"]: () => undefined}',
    '{[readFileSync("key", "utf8")]: () => undefined}',
  ])(
    "possible own-key absence cannot erase an inherited method result: %s",
    (expression) => {
      const outcome = Result.try({
        try: () =>
          analyze(
            `${header}
        import {readFileSync} from "node:fs";
        export const run = (flag) => {
          withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
          const value = ${expression};
          const rendered = value.toString?.();
          if (rendered === "[object Object]") rootDb.delete(flowRuns);
        };
      `,
            helper,
          ),
        catch: (error) => error,
      });
      if (outcome.isErr()) {
        if (!Panic.is(outcome.error)) {
          panic("Inherited-field guard produced an unexpected error type");
        }
        expect(outcome.error.message).toMatch(
          /unresolved callable: unmodeled inherited object field toString/iu,
        );
        return;
      }
      expect(outcome.value.reachedRecoveryOwners).toEqual([owner]);
      expect(outcome.value.hits.map(({ operation }) => operation)).toContain(
        "delete",
      );
    },
  );

  test.each([
    "{toString: undefined}",
    "{...(flag ? {toString: () => undefined} : {}), toString: undefined}",
  ])(
    "an explicit own undefined field still masks an inherited method: %s",
    (expression) => {
      const result = analyze(
        `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const value = ${expression};
        const rendered = value.toString?.();
        if (rendered !== undefined) rootDb.delete(flowRuns);
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test.each([
    "const table of Object.values(value)",
    "const [,table] of Object.entries(value)",
  ])(
    "unknown own keys retain their complete tracked values: %s",
    (iterator) => {
      const result = analyze(
        `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const key = readFileSync("key", "utf8");
        const value = {[key]: flowRuns};
        for (${iterator}) rootDb.delete(table);
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
    },
  );

  test.each([
    "const projected = {...value};",
    "const {omitted, ...projected} = value;",
  ])(
    "spread and rest preserve complete own-value coverage: %s",
    (projection) => {
      const result = analyze(
        `${header}
      import {readFileSync} from "node:fs";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const key = readFileSync("key", "utf8");
        const value = {[key]: flowRuns};
        ${projection}
        for (const table of Object.values(projected)) rootDb.delete(table);
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
    },
  );

  test("heap merging closed and unknown-key objects retains complete own values", () => {
    const result = analyze(
      `${header}
      import {readFileSync} from "node:fs";
      const make = (holder) => ({[holder.key]: flowRuns});
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const holder = {key: "literal"};
        for (const key of ["literal", readFileSync("key", "utf8")]) {
          holder.key = key;
          const value = make(holder);
          for (const table of Object.values(value)) rootDb.delete(table);
        }
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test.each([
    '{...(flag ? {label: "stored"} : {})}',
    '{...(flag ? {toString: "stored"} : {})}',
    '{[flag ? "label" : "other"]: "stored"}',
    '{[flag ? "toString" : "other"]: "stored"}',
  ])(
    "own enumeration never emits optional absence or inherited values: %s",
    (expression) => {
      const result = analyze(
        `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const value = ${expression};
        for (const stored of Object.values(value)) stored.trim();
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test("an optional field assignment stores its value separately from absence", () => {
    const result = analyze(
      `${header}
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const value = {};
        if (flag) value.table = flowRuns;
        for (const table of Object.values(value)) rootDb.delete(table);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test("own enumeration retains explicit stored undefined values", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const value = {stored: undefined};
        const values = Object.values(value);
        if (values.length !== 1) rootDb.delete(flowRuns);
        if (values.at(0) !== undefined) rootDb.delete(flowRuns);
        const entries = Object.entries(value);
        if (entries.length !== 1) rootDb.delete(flowRuns);
        for (const [key, stored] of entries) {
          if (key !== "stored") rootDb.delete(flowRuns);
          if (stored !== undefined) rootDb.delete(flowRuns);
        }
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(0);
  });

  test("missing native validation metadata retains unmodeled own-value coverage", () => {
    const result = analyze(
      `${header}
      import * as v from "valibot";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const parsed = v.safeParse(v.string(), 123);
        if (Array.isArray(parsed.issues)) rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test.each([
    "const value = parsed;",
    'const value = {...parsed, [readFileSync("key", "utf8")]: "stored"};',
    "const {success, output, ...value} = parsed;",
  ])(
    "partial native metadata never gains a string value proof: %s",
    (projection) => {
      expect(() =>
        analyze(
          `${header}
      import * as v from "valibot";
      import {readFileSync} from "node:fs";
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const parsed = v.safeParse(v.string(), "valid");
        ${projection}
        for (const [key, stored] of Object.entries(value)) {
          if (key === "issues") stored.trim();
        }
      };
    `,
          helper,
        ),
      ).toThrow(/native string method requires a proven string receiver/iu);
    },
  );

  test("opaque native writes keep partial own-value coverage open", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const value = {known: "stored"};
        Object.defineProperty(value, "added", {value: "second", enumerable: true});
        for (const stored of Object.values(value)) stored.trim();
      };
    `,
        helper,
      ),
    ).toThrow(/native string method requires a proven string receiver/iu);
  });

  test("an own proto field cannot erase a scoped prototype reference", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {
        write({type: "write", tx, table: flowRuns});
        const key = "__proto__";
        return {__proto__: {held: tx}, [key]: "own-data"};
      }});
    `,
        helper,
      ),
    ).toThrow(
      /prototype initializer carries a transaction or callable|scoped callback result exports a transaction capability/iu,
    );
  });

  test("a genuine listing-name guard preserves its stored primitive string", () => {
    const result = analyze(
      `${header}
      import {readFileSync} from "node:fs";
      const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
      const kebabCase = (value) => value.replace(/_/gu, "-").toLowerCase();
      const parseListings = (raw) => {
        if (!Array.isArray(raw)) return [];
        const listings = [];
        for (const entry of raw) {
          if (!isRecord(entry)) continue;
          const name = entry["name"];
          const inputSchema = entry["inputSchema"];
          if (typeof name === "string" && isRecord(inputSchema)) listings.push({name});
        }
        return listings;
      };
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const listings = parseListings(JSON.parse(readFileSync("registry", "utf8")));
        for (const listing of listings) kebabCase(listing.name);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test.each([
    'typeof name === "string"',
    'typeof name === "string" && observe()',
    'observe() && typeof name === "string"',
    '!(typeof name !== "string")',
    '!(typeof name !== "string" || otherInput)',
  ])(
    "a const string read is proven only in its genuine If consequent: %s",
    (guard) => {
      const result = analyze(
        `${header}
      export const run = (input, otherInput) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const name = input;
        const observe = () => true;
        if (${guard}) name.replace(/_/gu, "-").toLowerCase();
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test.each([
    'typeof name === "string" && name.replace(/_/gu, "-");',
    'typeof name !== "string" || name.replace(/_/gu, "-");',
    'if (typeof name !== "string") return; (flag ? name : "").replace(/_/gu, "-");',
  ])(
    "continuing expressions carry their exact immutable typeof fact: %s",
    (expression) => {
      const result = analyze(
        `${header}
      export const run = (input, flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const name = input;
        ${expression}
      };
    `,
        helper,
      );
      expect(result.hits).toHaveLength(0);
    },
  );

  test("guarded string reads retain exact literal contents", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const name = "snake_Case";
        if (typeof name === "string") {
          if (name.replace(/_/gu, "-").toLowerCase() !== "snake-case") rootDb.delete(flowRuns);
        }
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(0);
  });

  test.each([
    '(flag ? name : "").replace(/_/gu, "-");',
    'if (typeof other === "string") (flag ? name : "").replace(/_/gu, "-");',
    'if (typeof alias === "string") (flag ? name : "").replace(/_/gu, "-");',
    'if (typeof name === "string") (flag ? alias : "").replace(/_/gu, "-");',
    'if (typeof name === "string" || otherInput) (flag ? name : "").replace(/_/gu, "-");',
    'if (!(typeof name === "string" && flag)) (flag ? name : "").replace(/_/gu, "-");',
    'if (typeof name === "string") {} (flag ? name : "").replace(/_/gu, "-");',
    'if (typeof name === "string") {} else (flag ? name : "").replace(/_/gu, "-");',
    'typeof name !== "string" && (flag ? name : "").replace(/_/gu, "-");',
    'typeof name === "string" || (flag ? name : "").replace(/_/gu, "-");',
    'if (typeof name == "string") (flag ? name : "").replace(/_/gu, "-");',
    'let mutable = input; if (typeof mutable === "string") (flag ? mutable : "").replace(/_/gu, "-");',
    'const box = {name: input}; if (typeof box.name === "string") (flag ? box.name : "").replace(/_/gu, "-");',
    'const annotated = input as string; if (flag) (flag ? annotated : "").replace(/_/gu, "-");',
    'const isString = () => true; if (isString(name)) (flag ? name : "").replace(/_/gu, "-");',
    'if (typeof name === "string") {const name = otherInput; (flag ? name : "").replace(/_/gu, "-");}',
  ])(
    "read-local string facts do not escape their binding or execution branch: %s",
    (statement) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (input, otherInput, flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const name = input;
        const other = otherInput;
        const alias = name;
        ${statement}
      };
    `,
          helper,
        ),
      ).toThrow(/native string method requires a proven string receiver/iu);
    },
  );

  test.each([
    'const consume = () => (flag ? name : "").replace(/_/gu, "-"); if (typeof name === "string") consume();',
    'if (typeof name === "string") {const consume = () => (flag ? name : "").replace(/_/gu, "-"); consume();}',
    'const callback = () => (flag ? name : "").replace(/_/gu, "-"); const invoke = (fn) => fn(); if (typeof name === "string") invoke(callback);',
  ])(
    "an enclosing string guard does not authorize a captured read across a function boundary: %s",
    (statement) => {
      expect(() =>
        analyze(
          `${header}
      export const run = (input, flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const name = input;
        ${statement}
      };
    `,
          helper,
        ),
      ).toThrow(/native string method requires a proven string receiver/iu);
    },
  );

  test("a checked value passed explicitly retains its string proof in the callee", () => {
    const result = analyze(
      `${header}
      const kebabCase = (value) => value.replace(/_/gu, "-").toLowerCase();
      export const run = (input) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const name = input;
        if (typeof name === "string") kebabCase(name);
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(0);
  });

  test("string facts never skip actual right-condition effects", () => {
    const result = analyze(
      `${header}
      export const run = (input) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const name = input;
        const observe = () => {rootDb.delete(flowRuns); return true;};
        if (typeof name === "string" && observe()) name.replace(/_/gu, "-");
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test.each([
    'if (typeof name === "string" && (rootDb.delete(missingTable), true)) name.replace(/_/gu, "-");',
    'typeof name === "string" && (rootDb.delete(missingTable), name.replace(/_/gu, "-"));',
  ])("read facts do not reorder or discard guard effects: %s", (statement) => {
    expect(() =>
      analyze(
        `${header}
      export const run = (input) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const name = input;
        ${statement}
      };
    `,
        helper,
      ),
    ).toThrow(/unresolved delete table/iu);
  });

  test("a right-condition native mutation still invalidates the native identity contract", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = (input) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const name = input;
        const corrupt = () => {String.prototype.replace = input; return true;};
        if (typeof name === "string" && corrupt()) name.replace(/_/gu, "-");
      };
    `,
        helper,
      ),
    ).toThrow(/native external mutation/iu);
  });

  test.each(["unboundValue", "opaqueRead()"])(
    "a typeof guard does not grant unresolved producer provenance: %s",
    (initializer) => {
      expect(() =>
        analyze(
          `${header}
      import {opaqueRead} from "opaque-provider";
      export const run = (flag) => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const name = ${initializer};
        if (typeof name === "string") (flag ? name : "").replace(/_/gu, "-");
      };
    `,
          helper,
        ),
      ).toThrow(/native string method requires a proven string receiver/iu);
    },
  );

  test.each([
    { left: "selected", values: "[rootDb]" },
    { left: "[selected]", values: "[[rootDb]]" },
    { left: "{tx: selected}", values: "[{tx: rootDb}]" },
  ])(
    "for-of assignment cannot hide a changed transaction receiver: $left",
    ({ left, values }) => {
      expect(() =>
        analyze(
          `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {
        write({type: "write", tx, table: flowRuns});
        let selected = tx;
        for (${left} of ${values}) {}
        selected.delete(flowRuns);
        return null;
      }});
    `,
          helper,
        ),
      ).toThrow(/for-of assignment requires an explicit mutation model/iu);
    },
  );

  test("array offsets cannot hide callable effects", () => {
    expect(() =>
      analyze(
        `${header}
      export const run = () => {
        const values = [];
        values.splice({valueOf: () => { write({tx: rootDb, table: flowRuns}); return 0; }}, 0);
        return write({tx: rootDb, table: flowRuns});
      };
    `,
        `export const write = (operation) => operation.tx.update(operation.table).set({status: "running"});`,
      ),
    ).toThrow(/array offset.*callable/iu);
  });

  test("regular expression methods preserve later write effects", () => {
    expect(
      analyze(
        `${header}
      export const run = (value) => {
        /fixture/u.test(value);
        return write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
    expect(
      analyze(
        `${header}
      const pattern = {test: (callback) => callback()};
      export const run = () => pattern.test(() => write({type: "write", tx: rootDb, table: flowRuns}));
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test.each(["text", "json", "file"])(
    "%s import attributes keep assets as data during root analysis",
    (importType) => {
      const result = analyze(
        `${header}
      import { readLogo } from "./artwork";
      export const run = () => {
        readLogo();
        return write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
        {
          "apps/api/src/lib/other/artwork.ts": `
        import logo from "./payload.asset" with {type: "${importType}"};
        export const readLogo = () => logo;
      `,
        },
      );
      expect(result.hits).toHaveLength(1);
    },
  );

  test("pure exports keep their consumers separate from root connection exports", () => {
    const mixed = "apps/api/src/lib/other/mixed.ts";
    const consumer = "apps/api/src/lib/other/data-consumer.ts";
    const result = analyze(
      `${header} export const run = () => write({type: "write", tx: rootDb, table: flowRuns});`,
      helper,
      {
        [mixed]: `
        import { rootDb } from "@/api/db/root";
        export const connection = () => rootDb;
        export const format = (value) => value;
      `,
        [consumer]: `import { format } from "./mixed"; export const run = () => format("value");`,
      },
    );
    expect(result.entries.some(({ file }) => file === consumer)).toBe(false);
    expect(result.hits).toHaveLength(1);
  });

  test("root-import exports cannot hide unsupported mutable state behind a pure consumer", () => {
    const mixed = "apps/api/src/lib/other/mixed.ts";
    expect(() =>
      analyze(
        `${header} export const run = () => write({type: "write", tx: rootDb, table: flowRuns});`,
        helper,
        {
          [mixed]: `
          import {rootDb} from "@/api/db/root";
          export const connection = () => rootDb;
          export const format = (value) => {let calls = 0; calls += 1; return value;};
        `,
          "apps/api/src/lib/other/data-consumer.ts":
            'import {format} from "./mixed"; export const run = () => format("value");',
        },
      ),
    ).toThrow(/mutable state requires an alias\/control-flow state model/iu);
  });

  test.each(["named", "namespace", "reexport"])(
    "%s connection factories retain their root provenance",
    (kind) => {
      const consumer = "apps/api/src/lib/other/factory-consumer.ts";
      let importing: string;
      if (kind === "namespace") {
        importing =
          'import * as factories from "./mixed"; const connection = factories.connection;';
      } else if (kind === "reexport") {
        importing = 'import { connection } from "./factory-relay";';
      } else {
        importing = 'import { connection } from "./mixed";';
      }
      const result = analyze(
        `${header} export const run = () => write({type: "write", tx: rootDb, table: flowRuns});`,
        helper,
        {
          "apps/api/src/lib/other/mixed.ts":
            'import { rootDb } from "@/api/db/root"; export const connection = () => rootDb;',
          "apps/api/src/lib/other/factory-relay.ts":
            'export { connection } from "./mixed";',
          [consumer]: `${importing}
        import { flowRuns } from "@/api/db/schema";
        export const run = () => connection().update(flowRuns).set({status: "running"});`,
        },
      );
      expect(result.entries.some(({ file }) => file === consumer)).toBe(true);
      expect(result.hits.some(({ file }) => file === consumer)).toBe(true);
    },
  );

  test("opaque data field updates cannot retain a database capability", () => {
    expect(
      analyze(
        `${header}
      export const run = (state) => {
        state.status = "running";
        return write({type: "write", tx: rootDb, table: flowRuns});
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
    expect(() =>
      analyze(
        `${header}
      export const run = (state) => { state.tx = rootDb; };
    `,
        helper,
      ),
    ).toThrow(/mutable.*capability/iu);
  });

  test("array predicates retain the concrete operation and respect lexical bindings", () => {
    expect(
      analyze(
        `${header}
      export const run = () => write({ type: "write", tx: rootDb, table: flowRuns });
    `,
        `
      export function write(operation) {
        const operations = Array.isArray(operation) ? operation : [operation];
        for (const item of operations) item.tx.update(item.table).set({status: "running"});
      }
    `,
      ).hits,
    ).toHaveLength(1);
    expect(
      analyze(
        `${header}
      const Array = { isArray: (callback) => callback() };
      export const run = () => Array.isArray(() => write({type: "write", tx: rootDb, table: flowRuns}));
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("type assertions observe values while executable delegates retain their effects", () => {
    expect(
      analyze(
        `${header}
      import { expectTypeOf as inspect } from "bun:test";
      export const run = () => {
        inspect(() => write({ type: "write", tx: rootDb, table: flowRuns })).toBeFunction();
        return write({ type: "write", tx: rootDb, table: flowRuns });
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
    expect(
      analyze(
        `${header}
      const inspect = (callback) => callback();
      export const run = () => inspect(() => write({ type: "write", tx: rootDb, table: flowRuns }));
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
    expect(() =>
      analyze(
        `${header}
      import { expectTypeOf as inspect } from "other-package";
      export const run = () => inspect(() => write({ type: "write", tx: rootDb, table: flowRuns }));
    `,
        helper,
      ),
    ).toThrow(/receives a transaction or callable/iu);
  });

  test("external instances preserve provenance without hiding constructor callbacks", () => {
    const source = `${header}
      import { AsyncLocalStorage } from "node:async_hooks";
      const store = new AsyncLocalStorage();
      export const run = () => {
        store.getStore();
        return write({ type: "write", tx: rootDb, table: flowRuns });
      };`;
    expect(analyze(source, helper).hits).toHaveLength(1);
    expect(() =>
      analyze(
        `${header}
      import { External } from "external-package";
      export const run = () => new External(() => write({ type: "write", tx: rootDb, table: flowRuns }));
    `,
        helper,
      ),
    ).toThrow(/constructor receives/iu);
  });

  test("a scoped invocation cannot excuse another raw invocation of the same function", () => {
    const result = analyze(
      `${header}
      export const run = () => withOrgScope({ tx: rootDb, scope, actor, fn: async (scopedTx) => {
        await write({ type: "write", tx: scopedTx, table: flowRuns });
        await write({ type: "write", tx: rootDb, table: flowRuns });
      }});`,
      helper,
    );
    expect(result.hits).toHaveLength(1);
    expect(result.hits.at(0)?.table).toBe("flowRuns");
  });

  test("ordinary transactions inherit raw provenance and scoped savepoints retain scope", () => {
    const result = analyze(
      `${header}
      export const run = async () => {
        await rootDb.transaction((tx) => write({ type: "write", tx, table: flowRuns }));
        await withOrgScope({ tx: rootDb, scope, actor, fn: (scopedTx) =>
          scopedTx.transaction((tx) => write({ type: "write", tx, table: flowRuns })) });
      };`,
      helper,
    );
    expect(result.hits).toHaveLength(1);
  });

  test("reexports, renamed imports, destructured positional args and callback closures resolve", () => {
    const result = analyze(
      `
      import { rootDb } from "@/api/db/root";
      import { flowRuns } from "@/api/db/schema";
      import { deferred as renamed } from "./relay";
      const through = ({ db, fn }) => fn(db);
      export const run = () => through({ db: rootDb, fn: (writer) =>
        renamed({ type: "write", tx: writer, table: flowRuns }) });`,
      helper,
      {
        "apps/api/src/lib/other/relay.ts":
          'export { write as deferred } from "@/api/lib/db/recovery-bookkeeping/claims";',
      },
    );
    expect(result.hits).toHaveLength(1);
  });

  test("nested lifecycle spec fields reach the terminal table", () => {
    const result = analyze(
      `${header}
      const spec = { table: flowRuns };
      export const run = () => write({ tx: rootDb, spec });`,
      `
      const transition = ({ tx, spec }) => tx.update(spec.table).set({ status: "running" });
      export const write = (operation) => transition(operation);
    `,
    );
    expect(result.hits.at(0)?.table).toBe("flowRuns");
    expect(result.hits).toHaveLength(1);
  });

  test.each([
    { expression: "2 + 3", expected: 5 },
    { expression: "5 - 2", expected: 3 },
    { expression: "2 * 3", expected: 6 },
    { expression: "6 / 2", expected: 3 },
    { expression: "7 % 3", expected: 1 },
    { expression: "2 ** 3", expected: 8 },
    { expression: "2 < 3", expected: true },
    { expression: "3 <= 3", expected: true },
    { expression: "4 > 3", expected: true },
    { expression: "3 >= 3", expected: true },
    { expression: "1 << 2", expected: 4 },
    { expression: "1 << 32", expected: 1 },
    { expression: "-8 >> 1", expected: -4 },
    { expression: "-1 >>> 0", expected: 4_294_967_295 },
    { expression: "5 & 3", expected: 1 },
    { expression: "5 | 2", expected: 7 },
    { expression: "5 ^ 3", expected: 6 },
    { expression: "~0", expected: -1 },
  ])(
    "literal numeric operators retain their exact completion value: $expression",
    ({ expression, expected }) => {
      const result = analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        if ((${expression}) !== ${JSON.stringify(expected)}) rootDb.delete(flowRuns);
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test.each([
    { expression: "-0 & -1", expected: 0 },
    { expression: "(0 / 0) & 7", expected: 0 },
    { expression: "(1 / 0) & -1", expected: 0 },
    { expression: "-3.75 & 7", expected: 5 },
    { expression: "3.75 & 7", expected: 3 },
    { expression: "4294967296 & -1", expected: 0 },
    { expression: "2147483648 & -1", expected: -2_147_483_648 },
    { expression: "-0 | -0", expected: 0 },
    { expression: "(0 / 0) | 5", expected: 5 },
    { expression: "(1 / 0) | -1", expected: -1 },
    { expression: "-3.75 | 2", expected: -1 },
    { expression: "3.75 | 4", expected: 7 },
    { expression: "4294967296 | 1", expected: 1 },
    { expression: "2147483648 | 1", expected: -2_147_483_647 },
    { expression: "-0 ^ -0", expected: 0 },
    { expression: "(0 / 0) ^ 7", expected: 7 },
    { expression: "(-1 / 0) ^ -1", expected: -1 },
    { expression: "-3.75 ^ 3", expected: -2 },
    { expression: "3.75 ^ 1", expected: 2 },
    { expression: "4294967296 ^ 1", expected: 1 },
    { expression: "2147483648 ^ -1", expected: 2_147_483_647 },
    { expression: "1 << -1", expected: -2_147_483_648 },
    { expression: "1 << 32", expected: 1 },
    { expression: "1 << 33", expected: 2 },
    { expression: "2147483648 << 1", expected: 0 },
    { expression: "-3.75 << 1", expected: -6 },
    { expression: "(0 / 0) << 1", expected: 0 },
    { expression: "1 << (1 / 0)", expected: 1 },
    { expression: "-1 >> 1", expected: -1 },
    { expression: "-2147483648 >> 31", expected: -1 },
    { expression: "-2147483648 >> 32", expected: -2_147_483_648 },
    { expression: "-2147483648 >> 33", expected: -1_073_741_824 },
    { expression: "2147483648 >> -1", expected: -1 },
    { expression: "-3.75 >> 1", expected: -2 },
    { expression: "3.75 >> 1", expected: 1 },
    { expression: "(-1 / 0) >> 1", expected: 0 },
    { expression: "-1 >>> 0", expected: 4_294_967_295 },
    { expression: "-1 >>> -1", expected: 1 },
    { expression: "-1 >>> 32", expected: 4_294_967_295 },
    { expression: "-1 >>> 33", expected: 2_147_483_647 },
    { expression: "2147483648 >>> 31", expected: 1 },
    { expression: "-3.75 >>> 1", expected: 2_147_483_646 },
    { expression: "3.75 >>> 1", expected: 1 },
    { expression: "4294967296 >>> 0", expected: 0 },
    { expression: "(1 / 0) >>> 0", expected: 0 },
    { expression: "-0 >>> 0", expected: 0 },
    { expression: "~(-0)", expected: -1 },
    { expression: "~(0 / 0)", expected: -1 },
    { expression: "~(1 / 0)", expected: -1 },
    { expression: "~(-1 / 0)", expected: -1 },
    { expression: "~(-3.75)", expected: 2 },
    { expression: "~3.75", expected: -4 },
    { expression: "~4294967296", expected: -1 },
    { expression: "~2147483648", expected: 2_147_483_647 },
    { expression: "~4294967295", expected: 0 },
  ])(
    "native bitwise integer conversion retains its exact literal result: $expression",
    ({ expression, expected }) => {
      const zeroSignCheck =
        expected === 0 ? "if (1 / value < 0) rootDb.delete(flowRuns);" : "";
      const result = analyze(
        `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const value = (${expression});
        if (value !== ${expected}) rootDb.delete(flowRuns);
        ${zeroSignCheck}
      };
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits).toHaveLength(0);
    },
  );

  test("numeric NaN completion remains unequal to itself", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        if (!((0 / 0) !== (0 / 0))) rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test("division preserves the negative sign of a literal zero divisor", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        if (!((1 / -0) < 0)) rootDb.delete(flowRuns);
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits).toHaveLength(0);
  });

  test.each([
    { receiver: "rootDb", operations: ["update"] },
    { receiver: "scoped", operations: [] },
  ])(
    "a depth-bounded recursive object copy retains terminal $receiver authority",
    ({ receiver, operations }) => {
      const result = analyze(
        `${header}
      const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
      const copy = ({value, depth, tx}) => {
        if (depth > 3) {
          write({type: "write", tx, table: flowRuns});
          return value;
        }
        if (!isRecord(value)) return value;
        const entries = [];
        for (const [key, child] of Object.entries(value)) {
          const expanded = copy({value: child, depth: depth + 1, tx});
          entries.push([key, expanded]);
        }
        return Object.fromEntries(entries);
      };
      export const run = (document) => withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
        write({type: "write", tx: scoped, table: flowRuns});
        copy({value: document, depth: 0, tx: ${receiver}});
        return null;
      }});
    `,
        helper,
      );
      expect(result.reachedRecoveryOwners).toEqual([owner]);
      expect(result.hits.map(({ operation }) => operation)).toEqual([
        ...operations,
      ]);
    },
  );

  test.each([
    "const value = {}; tick(); value.self = value; tick();",
    "const values = []; tick(); values.push(values); tick();",
    "const left = {}; const right = {left}; tick(); left.right = right; tick();",
  ])("a later data edge still refuses cyclic analysis: %s", (body) => {
    expect(() =>
      analyze(
        `${header}
      const tick = () => null;
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        ${body}
      };
    `,
        helper,
      ),
    ).toThrow(/cyclic abstract object/iu);
  });

  test("repeated call summaries observe mutation of their actual argument heap", () => {
    const result = analyze(
      `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
        write({type: "write", tx: scoped, table: flowRuns});
        const flags = {active: false};
        const choose = (state) => state.active ? rootDb : scoped;
        const steps = [0, 1];
        for (let index = 0; index < steps.length; index += 1) {
          const tx = choose(flags);
          write({type: "write", tx, table: flowRuns});
          flags.active = true;
        }
        return null;
      }});
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["update"]);
  });

  test("a returned object's mutation invalidates a repeated callee's heap observation", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const state = {active: false};
        const read = () => {
          if (state.active) rootDb.delete(flowRuns);
          return state;
        };
        const steps = [0, 1];
        for (let index = 0; index < steps.length; index += 1) {
          const returned = read();
          returned.active = true;
        }
      };
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test("a namespace import cannot hide changed module heap from a repeated callee", () => {
    const result = analyze(
      `${header}
      import * as flags from "./summary-flags";
      const enabled = () => flags.state.active;
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const steps = [0, 1];
        for (let index = 0; index < steps.length; index += 1) {
          if (enabled()) rootDb.delete(flowRuns);
          flags.state.active = true;
        }
      };
    `,
      helper,
      {
        "apps/api/src/lib/other/summary-flags.ts":
          "export const state = {active: false};",
      },
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test("a repeated factory selector observes captured flag heap without promoting scoped authority", () => {
    const result = analyze(
      `${header}
      export const run = () => withOrgScope({tx: rootDb, scope, actor, fn: (scoped) => {
        write({type: "write", tx: scoped, table: flowRuns});
        const flags = {active: false};
        const scopedFactory = () => scoped;
        const rootFactory = () => rootDb;
        const select = () => flags.active ? rootFactory : scopedFactory;
        const steps = [0, 1];
        for (let index = 0; index < steps.length; index += 1) {
          const factory = select();
          const tx = factory();
          write({type: "write", tx, table: flowRuns});
          flags.active = true;
        }
        return null;
      }});
    `,
      helper,
    );
    expect(result.reachedRecoveryOwners).toEqual([owner]);
    expect(result.hits.map(({ operation }) => operation)).toEqual(["update"]);
  });

  test("a reused closure context observes its changed primitive capture", () => {
    const result = analyze(
      `${header}
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        for (const active of [false, true]) {
          const read = () => {if (active) rootDb.delete(flowRuns);};
          read();
        }
      };
    `,
      helper,
    );
    expect(result.hits.map(({ operation }) => operation)).toEqual(["delete"]);
  });

  test("shared acyclic data edges remain valid after repeated calls", () => {
    const result = analyze(
      `${header}
      const tick = () => null;
      export const run = () => {
        withOrgScope({tx: rootDb, scope, actor, fn: (tx) => {write({type: "write", tx, table: flowRuns}); return null;}});
        const shared = {};
        const left = {shared};
        tick();
        const right = {shared};
        const both = {left, right};
        tick();
      };
    `,
      helper,
    );
    expect(result.hits).toHaveLength(0);
  });

  test("recursive contexts converge without merging later raw and scoped invocations", () => {
    const result = analyze(
      `${header}
      export const run = () => withOrgScope({ tx: rootDb, scope, actor, fn: async (scopedTx) => {
        await write({ stop: false, tx: scopedTx, table: flowRuns });
        await write({ stop: false, tx: rootDb, table: flowRuns });
      }});`,
      `
      export function write(operation) {
        if (operation.stop === true) return operation.tx.update(operation.table).set({ status: "running" });
        return write({ ...operation, stop: true });
      }
    `,
    );
    expect(result.hits).toHaveLength(1);
  });

  test("declared SQL targets classify as ORG or GLOBAL", () => {
    const result = analyze(
      `${header} export const run = () => write({ tx: rootDb });`,
      `
      import { sql } from "drizzle-orm";
      export const write = ({ tx }) => {
        tx.execute(sql\`UPDATE flow_runs SET status = 'running'\`);
        tx.execute(sql\`UPDATE scheduler_jobs SET enabled = false\`);
      };
    `,
    );
    expect(result.hits.map(({ table }) => table)).toEqual(["flowRuns"]);
  });

  test.each(["scopedTx", "rootDb"])(
    "closures retain a later lexical alias of %s",
    (receiver) => {
      const result = analyze(
        `${header}
      export const run = () => withOrgScope({ tx: rootDb, scope, actor, fn: (scopedTx) => {
        const callback = () => write({ type: "write", tx: alias, table: flowRuns });
        const alias = ${receiver};
        return callback();
      }});`,
        helper,
      );
      expect(result.hits).toHaveLength(receiver === "scopedTx" ? 0 : 1);
    },
  );

  test("a same-named inner callback parameter keeps its actual raw argument", () => {
    const result = analyze(
      `${header}
      export const run = () => withOrgScope({ tx: rootDb, scope, actor, fn: (scopedTx) => {
        const forward = (scopedTx) => write({ type: "write", tx: scopedTx, table: flowRuns });
        return forward(rootDb);
      }});`,
      helper,
    );
    expect(result.hits).toHaveLength(1);
  });

  test("lazy immutable delegates retain their declaration after conditional use", () => {
    expect(
      analyze(
        `${header}
      export const run = (flag) => write({ flag, tx: rootDb, table: flowRuns });
    `,
        `
      const delegate = (operation) => operation.tx.update(operation.table).set({status: "running"});
      export function write(operation) {
        if (operation.flag) delegate(operation);
        return delegate(operation);
      }
    `,
      ).hits,
    ).toHaveLength(2);
  });

  test("declared boundary values remain open and absent optional arguments use defaults", () => {
    expect(
      analyze(
        `${header}
      declare const request: { headers: { get(name: string): string } };
      const read = (options = { headers: request.headers }) => options.headers.get("x-fixture");
      read();
      export const run = () => write({ type: "write", tx: rootDb, table: flowRuns });
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
    expect(
      analyze(
        `${header}
      const absent = undefined;
      absent?.observe();
      export const run = () => write({ type: "write", tx: rootDb, table: flowRuns });
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("optional calls skip known null receivers without erasing later mutations", () => {
    expect(
      analyze(
        `${header}
      export const run = (request) => {
        const server = request ? request.server : null;
        server?.requestIP(request);
        const absent = null;
        absent?.requestIP(request);
        return write({ type: "write", tx: rootDb, table: flowRuns });
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
  });

  test("open request methods carry no scope proof and cannot receive write capabilities", () => {
    expect(
      analyze(
        `${header}
      export const run = (request) => {
        request.server.requestIP(request);
        return write({ type: "write", tx: rootDb, table: flowRuns });
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(1);
    expect(() =>
      analyze(
        `${header}
      export const run = (request) => request.delegate(() => write({ type: "write", tx: rootDb, table: flowRuns }));
    `,
        helper,
      ),
    ).toThrow(/receives a transaction or callable/iu);
    expect(
      analyze(
        `${header}
      export const run = (request) => {
        request.db.update(flowRuns).set({status: "running"});
        return write({ type: "write", tx: rootDb, table: flowRuns });
      };
    `,
        helper,
      ).hits,
    ).toHaveLength(2);
  });

  test("an unknown callback parameter is not its containing function declaration", () => {
    expect(() =>
      analyze(
        `${header}
      export function run(delegate) { return delegate({ tx: rootDb, table: flowRuns }); }
    `,
        helper,
      ),
    ).toThrow(/unresolved delegate input receives a transaction or callable/iu);
  });

  test("missing delegate modules reject the analysis", () => {
    expect(() =>
      analyze(
        `${header} export const run = () => write({ tx: rootDb, table: flowRuns });`,
        'export { mutate as write } from "./missing-delegate";',
      ),
    ).toThrow(/Unresolved organization write graph: missing source/iu);
  });

  test("unresolved callable and mutation targets reject instead of returning zero", () => {
    expect(() =>
      analyze(
        `${header} export const run = () => write({ tx: rootDb, table: flowRuns });`,
        "export const write = (operation) => unknownDelegate(operation);",
      ),
    ).toThrow(/Unresolved organization write graph:.*unresolved callable/iu);
    expect(() =>
      analyze(
        `${header} export const run = () => write({ tx: rootDb });`,
        'export const write = (operation) => operation.tx.update(operation.table).set({ status: "running" });',
      ),
    ).toThrow(
      /Unresolved organization write graph:.*unresolved update table/iu,
    );
  });
});

describe("production recovery receipt scope analysis", () => {
  const caller = "apps/api/src/lib/other/receipt-caller.ts";
  const owner = "apps/api/src/lib/db/recovery-bookkeeping/receipts.ts";
  const forwardingOwner =
    "apps/api/src/lib/db/recovery-bookkeeping/unscoped-fixture.ts";
  const production = readFileSync(path.join(REPO_ROOT, owner), "utf-8");
  const rootSource = readFileSync(
    path.join(REPO_ROOT, "apps/api/src/db/root.ts"),
    "utf-8",
  );
  test.each([
    "create-upload",
    "create-hearing",
    "create-review",
    "dequeue-scout",
    "settle-upload",
    "settle-scout",
  ])("%s retains its actual owner table and scope", (type) => {
    const scan = (content: string) =>
      scanOrgWriteGraph({
        sources: new Map([
          [
            caller,
            `import { rootDb } from "@/api/db/root";
          import { sql } from "drizzle-orm";
          import { mutateRecoveryReceipt } from "@/api/lib/db/recovery-bookkeeping/receipts";
          export const run = () => mutateRecoveryReceipt({type: "${type}", tx: rootDb, scope: {}, rows: [], where: sql\`TRUE\`});`,
          ],
          [owner, content],
          [
            forwardingOwner,
            "export const withOrgScope = (options) => options.fn(options.tx);",
          ],
          ["apps/api/src/db/root.ts", rootSource],
          [
            "apps/api/src/db/org-scope.ts",
            readFileSync(
              path.join(REPO_ROOT, "apps/api/src/db/org-scope.ts"),
              "utf-8",
            ),
          ],
          [
            "apps/api/src/lib/db/timestamp-cas.ts",
            readFileSync(
              path.join(REPO_ROOT, "apps/api/src/lib/db/timestamp-cas.ts"),
              "utf-8",
            ),
          ],
        ]),
        entryFiles: new Set([
          caller,
          owner,
          forwardingOwner,
          "apps/api/src/lib/db/timestamp-cas.ts",
        ]),
        rootDoorFiles: new Set(),
        policyEntryFiles: new Set(),
        recoveryOwnerFiles: new Set([owner]),
        orgTables: new Set([
          "flowUploadTriggerIntents",
          "pendingScoutEmissions",
        ]),
        globalTables: new Set(),
        sqlTables: new Map(),
      });
    const forwarding = production.replaceAll(
      '"@/api/db/org-scope"',
      '"./unscoped-fixture"',
    );
    expect(forwarding).not.toBe(production);
    expect(
      scan(forwarding).hits.map(({ table, operation }) => ({
        table,
        operation,
      })),
    ).toEqual([
      {
        table:
          type === "create-upload" || type === "settle-upload"
            ? "flowUploadTriggerIntents"
            : "pendingScoutEmissions",
        operation: type.startsWith("create-") ? "insert" : "delete",
      },
    ]);
    expect(scan(production).hits).toEqual([]);
  });
});

describe("tree-derived organization graph enrollment", () => {
  test("derives root doors from literal ownership rows and owner arrays", () => {
    expect(
      parseRootConnectionDoorFiles(
        new Map([
          [
            "scripts/ownership/root-door.ts",
            `export default { group: "root-connection", id: "root-door", owner: ["apps/api/src/lib/owner-a.ts", "apps/api/src/lib/owner-b.ts"] } as const;`,
          ],
          [
            "scripts/ownership/other.ts",
            `export default { group: "other", id: "other", owner: ["ignored.ts"] } as const;`,
          ],
        ]),
      ),
    ).toEqual(
      new Set(["apps/api/src/lib/owner-a.ts", "apps/api/src/lib/owner-b.ts"]),
    );
  });

  test.each([
    `export default { group: "root-connection", id: "door", owner: owners } as const;`,
    `export default { group: kind, id: "door", owner: ["apps/api/src/door.ts"] } as const;`,
    `export default { group: "root-connection", id: "door", owner: ["apps/api/src/door.ts"], owner: ["apps/api/src/other.ts"] } as const;`,
  ])(
    "rejects unsupported root ownership shapes instead of omitting doors",
    (content) => {
      expect(() =>
        parseRootConnectionDoorFiles(
          new Map([["scripts/ownership/unsupported.ts", content]]),
        ),
      ).toThrow(/ownership|root-connection/iu);
    },
  );

  test("maps recovery owners from the tree's exact top-level CLASSES binding", () => {
    const recoveryOwner = [
      'const CLASSES = ["claims", "receipts"] as const;',
      String.raw`export default { id: "recovery-bookkeeping", owner: CLASSES.map((kind) => ${"`"}apps/api/src/lib/db/recovery-bookkeeping/${"${"}kind}.ts${"`"}) } as const;`,
    ].join("\n");
    expect(parseRecoveryOwnerFiles(recoveryOwner)).toEqual(
      new Set([
        "apps/api/src/lib/db/recovery-bookkeeping/claims.ts",
        "apps/api/src/lib/db/recovery-bookkeeping/receipts.ts",
      ]),
    );
    expect(() =>
      parseRecoveryOwnerFiles(`
      const other = ["claims"] as const;
      export default { id: "recovery-bookkeeping", owner: other.map((kind) => "apps/api/src/lib/db/recovery-bookkeeping/" + kind + ".ts") } as const;
    `),
    ).toThrow(/literal recovery CLASSES array/iu);
  });

  test("requires ownership source rows instead of falling back to no doors", () => {
    expect(() => parseRootConnectionDoorFiles(new Map())).toThrow(
      /no ownership source modules/iu,
    );
  });

  test("reads relation names only from the literal generated map", () => {
    expect(
      parseTableRelations(
        'export const TABLE_RELATIONS = { flowRuns: "flow_runs", signals: "signals" } as const;',
      ),
    ).toEqual(
      new Map([
        ["flowRuns", "flow_runs"],
        ["signals", "signals"],
      ]),
    );
    for (const content of [
      "export const OTHER = {};",
      "export const TABLE_RELATIONS = relations;",
      "export const TABLE_RELATIONS = { flowRuns: relation };",
      'export const TABLE_RELATIONS = { [key]: "flow_runs" };',
      'export const TABLE_RELATIONS = { flowRuns: "flow_runs", flowRuns: "runs" };',
    ]) {
      expect(() => parseTableRelations(content)).toThrow(
        /TABLE_RELATIONS|repeats table/iu,
      );
    }
  });

  test("a classified table missing from the map is fatal, never counted as zero", () => {
    const relations = new Map([
      ["flowRuns", "flow_runs"],
      ["signals", "signals"],
    ]);
    expect(classifiedTableRelations(relations, new Set(["flowRuns"]))).toEqual(
      new Map([["flow_runs", "flowRuns"]]),
    );
    expect(() =>
      classifiedTableRelations(relations, new Set(["flowRuns", "newTable"])),
    ).toThrow(/Classified table newTable has no entry/iu);
    expect(() =>
      classifiedTableRelations(
        new Map([
          ["flowRuns", "flow_runs"],
          ["signals", "flow_runs"],
        ]),
        new Set(["flowRuns", "signals"]),
      ),
    ).toThrow("Duplicate SQL relation name");
  });
});
describe("historical organization graph metadata", () => {
  const headRegistry = `export const ORG_SCOPE_TABLES = { flowRuns: flowRunScope, newTable: newTableScope } as const;
    export const GLOBAL_SCOPE_TABLES = {} as const;`;
  const headRelations =
    'export const TABLE_RELATIONS = { flowRuns: "flow_runs", newTable: "new_table" } as const;';
  const head = { registry: headRegistry, tableRelations: headRelations };
  const rootOwnership = new Map([
    [
      "scripts/ownership/root-door.ts",
      `export default { group: "root-connection", id: "root-door", owner: ["apps/api/src/lib/owner.ts"] } as const;`,
    ],
  ]);
  const historicalSources = new Map([
    [
      "apps/api/src/db/schema/flows.ts",
      `import * as p from "drizzle-orm/pg-core"; export const flowRuns = p.pgTable("flow_runs", {});`,
    ],
  ]);
  const recoveryOwner = [
    'const CLASSES = ["claims"] as const;',
    String.raw`export default { id: "recovery-bookkeeping", owner: CLASSES.map((kind) => ${"`"}apps/api/src/lib/db/recovery-bookkeeping/${"${"}kind}.ts${"`"}) } as const;`,
  ].join("\n");
  const headOwnership = new Map([
    ...rootOwnership,
    ["scripts/ownership/recovery-bookkeeping.ts", recoveryOwner],
  ]);

  test("base uses HEAD classifications and relation names without base copies", () => {
    const result = deriveOrgWriteGraphInputs(historicalSources, rootOwnership, {
      role: "base",
      head,
    });
    expect(result.orgTables).toEqual(new Set(["flowRuns", "newTable"]));
    expect(result.sqlTables).toEqual(
      new Map([
        ["flow_runs", "flowRuns"],
        ["new_table", "newTable"],
      ]),
    );
    expect(result.recoveryOwnerFiles).toEqual(new Set());
  });

  test("base requires the measured HEAD metadata", () => {
    expect(() =>
      deriveOrgWriteGraphInputs(historicalSources, rootOwnership, {
        role: "base",
      }),
    ).toThrow(
      /requires the measured HEAD scope registry and table relations/iu,
    );
  });

  test("base recovery metadata may be absent only when canonical modules are absent", () => {
    expect(() =>
      deriveOrgWriteGraphInputs(
        new Map([
          ...historicalSources,
          [
            "apps/api/src/lib/db/recovery-bookkeeping/claims.ts",
            "export const write = () => {}; ",
          ],
        ]),
        rootOwnership,
        { role: "base", head },
      ),
    ).toThrow(/recovery-bookkeeping.ts while recovery modules exist/iu);
  });

  test("present malformed recovery ownership metadata remains fatal", () => {
    const ownership = new Map([
      ...rootOwnership,
      [
        "scripts/ownership/recovery-bookkeeping.ts",
        `export default { id: "recovery-bookkeeping", owner: [] } as const;`,
      ],
    ]);
    expect(() =>
      deriveOrgWriteGraphInputs(historicalSources, ownership, {
        role: "base",
        head,
      }),
    ).toThrow(/literal recovery CLASSES array/iu);
  });

  test("HEAD derives strict metadata from its complete tree", () => {
    const completeSources = new Map([
      ...historicalSources,
      ["apps/api/src/lib/db/table-relations.gen.ts", headRelations],
      ["apps/api/src/db/org-scope-registry.ts", headRegistry],
    ]);
    const result = deriveOrgWriteGraphInputs(completeSources, headOwnership, {
      role: "head",
    });
    expect(result.orgTables).toEqual(new Set(["flowRuns", "newTable"]));
    expect(result.sqlTables).toEqual(
      new Map([
        ["flow_runs", "flowRuns"],
        ["new_table", "newTable"],
      ]),
    );
    expect(result.recoveryOwnerFiles).toEqual(
      new Set(["apps/api/src/lib/db/recovery-bookkeeping/claims.ts"]),
    );
  });

  test("HEAD requires its registry, its relation map and every classified table in it", () => {
    expect(() =>
      deriveOrgWriteGraphInputs(historicalSources, headOwnership, {
        role: "head",
      }),
    ).toThrow(
      /Missing tree source apps\/api\/src\/db\/org-scope-registry.ts/iu,
    );
    const withRegistry = new Map([
      ...historicalSources,
      ["apps/api/src/db/org-scope-registry.ts", headRegistry],
    ]);
    expect(() =>
      deriveOrgWriteGraphInputs(withRegistry, headOwnership, { role: "head" }),
    ).toThrow(
      /Missing tree source apps\/api\/src\/lib\/db\/table-relations.gen.ts/iu,
    );
    withRegistry.set(
      "apps/api/src/lib/db/table-relations.gen.ts",
      'export const TABLE_RELATIONS = { flowRuns: "flow_runs" } as const;',
    );
    expect(() =>
      deriveOrgWriteGraphInputs(withRegistry, headOwnership, { role: "head" }),
    ).toThrow(/Classified table newTable has no entry/iu);
  });
});
