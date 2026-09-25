import { describe, expect, test } from "bun:test";

import {
  findRootConnectionShapes,
  ROOT_CONNECTION_SHAPE,
} from "./root-connection-shapes";
import type { RootConnectionShape } from "./root-connection-shapes";

const ROOT_IMPORT = 'import { rootDb } from "@/api/db/root";';

const shapesOf = (...lines: readonly string[]): RootConnectionShape[] =>
  findRootConnectionShapes(`${lines.join("\n")}\n`).map(({ shape }) => shape);

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

describe("explicit uses are not shapes", () => {
  test("a direct query, an explicit argument, and a door's operation", () => {
    expect(
      shapesOf(
        ROOT_IMPORT,
        "export const read = async (id: string) =>",
        "  await rootDb.select().from(table).where(eq(table.id, id));",
        "export const notifyActor = async (notice: Notice) => {",
        "  await fileNotice(notice, rootDb);",
        "};",
        "export const repairs = () => createRepairDeps(rootDb);",
        "const handles = async () => {",
        '  const { rootDb: owner } = await import("@/api/db/root");',
        "  return { owner: laneHandle(owner) };",
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
