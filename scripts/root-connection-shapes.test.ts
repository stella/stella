import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  findExemptRootOperations,
  findRootConnectionShapes,
  ROOT_CONNECTION_SHAPE,
  ROOT_OPERATION_RESULTS,
} from "./root-connection-shapes";
import type { RootConnectionShape } from "./root-connection-shapes";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const ROOT_IMPORT = 'import { rootDb } from "@/api/db/root";';
const FIXTURE_FILE = "apps/api/src/lib/fixture.ts";
const AUTH_FILE = ROOT_OPERATION_RESULTS.resolveMemberAuthorization.file;

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
      ),
    ).toEqual([
      ROOT_CONNECTION_SHAPE.fallbackOperand,
      ROOT_CONNECTION_SHAPE.fallbackOperand,
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

describe("the listed owner operations", () => {
  // The list may only shrink: an entry whose site was removed or rewritten
  // must go, or it would exempt the next call that takes its name.
  test.each(Object.entries(ROOT_OPERATION_RESULTS))(
    "%s still names an awaited site in its file",
    (operation, { file }) => {
      const content = readFileSync(path.join(REPO_ROOT, file), "utf-8");
      expect(findExemptRootOperations(content, file)).toContain(operation);
    },
  );
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
