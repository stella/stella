import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import {
  type DbAwaitInLoopReport,
  isApiSourceInScope,
  countDbAwaitInLoopDirectives,
  scanDbAwaitInLoop,
} from "./db-await-in-loop";

// The fixtures are small programs over the Drizzle and BullMQ types the API
// actually installs, so they live under apps/api (its node_modules resolve
// them) in the ignored `.cache` directory.
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const FIXTURE_PARENT = path.join(REPO_ROOT, "apps/api/.cache");

const HANDLE_MODULES = ["db/root.ts", "db/scoped.ts"] as const;

const FIXTURE_FILES: Record<string, string> = {
  "db/root.ts": `
import { defineRelations } from "drizzle-orm";
import type { PgAsyncDatabase, PgAsyncTransaction, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { integer, pgTable, text } from "drizzle-orm/pg-core";

export const items = pgTable("items", { id: integer().primaryKey(), name: text().notNull() });
export const relations = defineRelations({ items });
type Relations = typeof relations;
export declare const rootDb: PgAsyncDatabase<PgQueryResultHKT, Relations>;
export type Transaction = PgAsyncTransaction<PgQueryResultHKT, Relations>;
`,
  "db/scoped.ts": `
import type { Transaction } from "./root";

export type TransactionBase = { execute: (query: string) => PromiseLike<unknown> };
export type ScopedDb = <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
export declare const scopedDb: ScopedDb;
`,
  "result.ts": `
export const Result = {
  await: function* <T>(value: Promise<T>): Generator<Promise<T>, T, T> {
    return yield value;
  },
  tryPromise: async <T>(fn: () => Promise<T>): Promise<T> => await fn(),
};
`,
  "helpers.ts": `
import { inArray } from "drizzle-orm";
import { items, rootDb, type Transaction } from "./db/root";

export const writeOne = async (tx: Transaction | typeof rootDb, id: number) => {
  await tx.insert(items).values({ id, name: "row" });
};
export const readOne = async (reader: Pick<typeof rootDb, "select">, id: number) =>
  await reader.select().from(items).where(inArray(items.id, [id]));
export const countWith = async (builder: typeof rootDb.query.items) => (await builder.findMany()).length;
export const writeWith = async (options: object) => options;
export const saveOne = async (id: number) => {
  await rootDb.insert(items).values({ id, name: "saved" });
};
export const saveVia = async (id: number) => {
  await saveOne(id);
};
export const saveFar = async (id: number) => {
  await saveVia(id);
};
export const pure = async (id: number) => id * 2;
export const readReturned = async (id: number) => {
  const query = rootDb.select().from(items).where(inArray(items.id, [id]));
  return query;
};
export const describeQuery = async (id: number) => {
  const query = rootDb.select().from(items).where(inArray(items.id, [id]));
  return query.toSQL();
};
export class Store {
  async save(id: number) {
    await rootDb.update(items).set({ name: "store" }).where(inArray(items.id, [id]));
  }
}
`,
  "cases.ts": `
import { Queue } from "bullmq";
import { inArray, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { items, rootDb, rootDb as primary, type Transaction } from "./db/root";
import { scopedDb, type ScopedDb, type TransactionBase } from "./db/scoped";
import { countWith, describeQuery, pure, readOne, readReturned, saveFar, saveOne, saveVia, Store, writeOne, writeWith } from "./helpers";
import { Result } from "./result";

declare const ids: number[];

export const renamed = async (connection: Transaction, whatever: ScopedDb) => {
  const database = rootDb;
  const { run } = { run: scopedDb };
  for (const id of ids) {
    await database.select().from(items).where(inArray(items.id, [id])); // expect: query
    await connection.execute(sql\`select \${id}\`); // expect: query
    await primary.select().from(items); // expect: query
    await run(async (t) => t.select().from(items)); // expect: query
    await whatever(async (t) => t.select().from(items)); // expect: query
  }
};

export const shadowed = async () => {
  const db = new Map<number, Promise<number>>();
  const tx = { select: async () => 1 };
  for (const id of ids) {
    await db.get(id);
    await tx.select();
  }
};

export const redisNamedDb = async (db: Queue) => {
  for (const id of ids) {
    await db.add(String(id), {});
    await pure(id);
  }
};

export const partial = async (reader: Pick<typeof rootDb, "select">) => {
  for (const id of ids) {
    await reader.select().from(items); // expect: query
    await readOne(reader, id); // expect: handle
  }
};

export const fluent = async () => {
  const query = rootDb.select().from(items);
  const prepared = rootDb.select().from(items).prepare("page");
  const pending = [];
  for (const id of ids) {
    await query; // expect: query
    await prepared.execute(); // expect: query
    await rootDb.query.items.findMany(); // expect: query
    await countWith(rootDb.query.items); // expect: handle
    pending.push(rootDb.select().from(items).where(inArray(items.id, [id])));
  }
  return pending;
};

export const captured = async (store: Store) => {
  for (const id of ids) {
    await saveOne(id); // expect: helper
    await saveVia(id); // expect: helper
    await saveFar(id);
    await store.save(id); // expect: helper
    await readReturned(id); // expect: helper
    await describeQuery(id);
  }
};

export const exits = async () => {
  for (const id of ids) {
    if (id < 0) {
      await saveOne(id);
      return;
    }
    if (id > 5) {
      return await saveOne(id);
    }
    switch (id) {
      case 1:
        await saveOne(id); // expect: helper
        break;
      default:
        break;
    }
    await Result.tryPromise(async () => {
      await saveOne(id); // expect: helper
      return id;
    });
  }
  for (const id of ids) {
    await saveOne(id);
    break;
  }
  for (const id of ids) {
    await saveOne(id);
    throw new Error(String(id));
  }
};

export const bypassedExits = async (skip: (id: number) => boolean) => {
  for (const id of ids) {
    try {
      await saveOne(id); // expect: helper
      return;
    } catch {
      continue;
    }
  }
  for (const id of ids) {
    await saveOne(id); // expect: helper
    if (skip(id)) continue;
    return;
  }
  outer: for (const id of ids) {
    await saveOne(id); // expect: helper
    for (const other of ids) {
      if (other === id) continue outer;
    }
    return;
  }
  for (const id of ids) {
    try {
      return await saveOne(id); // expect: helper
    } finally {
      continue;
    }
  }
  for (const id of ids) {
    try {
      await saveOne(id); // expect: helper
      break;
    } finally {
      await pure(id);
    }
  }
};

export const objectHandles = async (tx: Transaction) => {
  for (const id of ids) {
    await writeWith({ database: rootDb, id }); // expect: handle
    await writeWith({ tx, id }); // expect: handle
    await writeWith({ options: { db: rootDb } }); // expect: handle
    await writeWith({ id });
  }
};

export const fanOut = async (tx: Transaction) => {
  const indexRow = async (id: number) => {
    await rootDb.insert(items).values({ id, name: "indexed" });
  };
  await Promise.all(ids.map((id) => rootDb.select().from(items).where(inArray(items.id, [id])))); // expect: query
  await Promise.all(
    ids.map(async (id) => {
      await rootDb.delete(items).where(inArray(items.id, [id])); // expect: query
    }),
  );
  await Promise.allSettled(ids.map((id) => writeOne(tx, id))); // expect: handle
  await Promise.all(ids.map(async (id) => { await writeOne(tx, id); })); // expect: helper
  await Promise.all(ids.map(indexRow)); // expect: query
  const context = { label: "rows" };
  await Promise.all( // expect: query
    ids.map(function (this: typeof context, id) {
      return rootDb.select().from(items).where(inArray(items.id, [id]));
    }, context),
  );
  await Promise.all( // expect: helper
    ids.map(async (id) => {
      await rootDb.select().from(items).where(inArray(items.id, [id]));
      await saveOne(id);
    }),
  );
  await Promise.all([writeOne(tx, 1), writeOne(tx, 2)]);
  await Promise.all(ids.map(async (id) => id * 2));
  ids.forEach(async (id) => {
    await rootDb.delete(items).where(inArray(items.id, [id]));
  });
};

export const batched = async () => {
  await rootDb.select().from(items).where(inArray(items.id, ids));
  let total = 0;
  for (const row of await rootDb.select().from(items)) {
    total += row.id;
  }
  for (const id of ids) {
    total += id;
  }
  return total;
};

export const loopPositions = async () => {
  while ((await rootDb.$count(items)) > 0) { // expect: query
    break;
  }
  for (let cursor = 0; cursor < 3; cursor = await advance(rootDb, cursor)) { // expect: handle
    continue;
  }
};
const advance = async (_db: typeof rootDb, cursor: number) => cursor + 1;

export function* generatorCase(safe: ScopedDb) {
  for (const id of ids) {
    yield* Result.await(safe(async (t) => t.select().from(items).where(inArray(items.id, [id])))); // expect: query
  }
}

export const tryPromiseCase = async () => {
  for (const id of ids) {
    await Result.tryPromise(async () => {
      await rootDb.select().from(items).where(inArray(items.id, [id])); // expect: query
    });
  }
};

declare const ingest: <T>(fn: (tx: TransactionBase) => Promise<T>) => Promise<T>;
type PublicReadTransaction = Pick<Transaction, "execute" | "select">;
declare const publicReadDb: <T>(fn: (tx: PublicReadTransaction) => Promise<T>) => Promise<T>;

export const runners = async <TTx extends TransactionBase>(
  runner: <T>(fn: (tx: TTx) => Promise<T>) => Promise<T>,
) => {
  for (const id of ids) {
    await ingest(async (t) => t.execute(String(id))); // expect: query
    await runner(async () => id); // expect: query
    await publicReadDb(async (t) => t.select().from(items)); // expect: query
  }
};

type MaintenanceDb = {
  transaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
  execute: (query: string) => Promise<unknown[]>;
};
export const wrapped = async (maintenance: MaintenanceDb) => {
  for (const id of ids) {
    await maintenance.execute(String(id)); // expect: query
    await writeWith({ maintenance }); // expect: handle
  }
};

type RevocationWriter = {
  delete: (table: PgTable) => {
    where: (condition: SQL | undefined) => PromiseLike<unknown>;
  };
};
type StatementRunner = { execute: (query: SQL) => Promise<unknown> };
type KeyValueCache = {
  delete: (key: string) => Promise<boolean>;
  execute: (command: string, ...args: string[]) => Promise<unknown>;
};
export const structural = async (
  rows: (typeof items.$inferInsert)[],
  writer: RevocationWriter,
  runner: StatementRunner,
  cache: KeyValueCache,
  revoke: (target: RevocationWriter, id: number) => Promise<void>,
) => {
  for (const id of ids) {
    await writer.delete(items).where(undefined); // expect: query
    await runner.execute(sql\`select \${id}\`); // expect: query
    await revoke(writer, id); // expect: handle
    await cache.delete(String(id));
    await cache.execute("GET", String(id));
    await writeWith({ cache });
    await writeWith(rows);
  }
};

declare const loose: any;
declare const opaque: unknown;
export const unresolved = async () => {
  for (const id of ids) {
    await loose.query(id); // expect: unclassified
    await opaque; // expect: unclassified
  }
};
`,
  "suppressed.ts": `
import { sql } from "drizzle-orm";
import { items, rootDb } from "./db/root";
import { writeOne } from "./helpers";

declare const ids: number[];

export const suppressed = async () => {
  for (const id of ids) {
    // db-await-in-loop: keyset page per iteration; the page is the batch
    await rootDb.select().from(items);
    // db-await-in-loop: ordered lock acquisition
    // an unrelated comment line may sit in between
    await rootDb.execute(sql\`select \${id}\`);
    await rootDb.select().from(items); // db-await-in-loop: trailing form covers its own line
  }
  // db-await-in-loop-disable: a block covers every site inside it
  for (const id of ids) {
    await rootDb.select().from(items);
    await writeOne(rootDb, id);
  }
  // db-await-in-loop-enable
  const texts: string[] = [];
  for (const id of ids) {
    const text = \`\${
      // db-await-in-loop: a directive inside an interpolation is a real comment
      await rootDb.$count(items)
    } \${id}\`;
    /*
    // db-await-in-loop: text inside a block comment is not a directive
    */
    await writeOne(rootDb, id); // expect: handle
    texts.push(text);
  }
  return texts;
};
`,
  "directives.ts": `
import { items, rootDb } from "./db/root";

declare const ids: number[];

// db-await-in-loop: nothing below awaits the database in a loop
export const idle = 1;
export const documented = "// db-await-in-loop: a directive quoted in a string is not a directive";

export const missingReason = async () => {
  for (const _id of ids) {
    // db-await-in-loop
    await rootDb.select().from(items); // expect: query
  }
};

// db-await-in-loop-enable
// db-await-in-loop-disable: never closed
// Prose quoting \`// db-await-in-loop: <reason>\` is not a directive.
`,
};

const expectedFromMarkers = (source: string): string[] =>
  source
    .split("\n")
    .flatMap((line, index) => {
      const marker = /\/\/ expect: (?<kind>\w+)/u.exec(line)?.groups?.["kind"];
      return marker === undefined ? [] : [`${index + 1}:${marker}`];
    })
    .toSorted();

let fixtureRoot = "";
let report: DbAwaitInLoopReport = {
  hits: [],
  suppressedHits: 0,
  directiveCounts: {},
  directiveProblems: [],
  unclassified: [],
  filesScanned: 0,
};

beforeAll(() => {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  fixtureRoot = mkdtempSync(path.join(FIXTURE_PARENT, "db-await-in-loop-"));
  const rootNames = Object.entries(FIXTURE_FILES).map(([relative, source]) => {
    const file = path.join(fixtureRoot, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source.trimStart());
    return file;
  });
  const program = ts.createProgram({
    rootNames,
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ESNext,
      lib: ["lib.esnext.d.ts"],
      types: [],
    },
  });
  report = scanDbAwaitInLoop({
    program,
    repositoryRoot: fixtureRoot,
    isInScope: (relative) => !relative.startsWith("db/"),
    handleDeclarationFiles: HANDLE_MODULES,
  });
});

afterAll(() => {
  if (fixtureRoot !== "") {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

const sourceOf = (file: string): string =>
  (FIXTURE_FILES[file] ?? "").trimStart();

const observed = (file: string): string[] =>
  [
    ...report.hits
      .filter((hit) => hit.file === file)
      .map((hit) => `${hit.line}:${hit.kind}`),
    ...report.unclassified
      .filter((site) => site.file === file)
      .map((site) => `${site.line}:unclassified`),
  ].toSorted();

describe("db-await-in-loop", () => {
  test("recognizes handles by type, not by name", () => {
    expect(observed("cases.ts")).toEqual(
      expectedFromMarkers(sourceOf("cases.ts")),
    );
  });

  test("helpers reached from a flagged site are not reported on their own", () => {
    expect(observed("helpers.ts")).toEqual([]);
  });

  test("the ratchet's count agrees with the directives the check applied", () => {
    for (const [file, source] of Object.entries(FIXTURE_FILES)) {
      expect({
        file,
        count: countDbAwaitInLoopDirectives(source.trimStart(), file),
      }).toEqual({ file, count: report.directiveCounts[file] ?? 0 });
    }
    expect(report.directiveCounts["suppressed.ts"]).toBe(5);
  });

  test("next-line, trailing, and block directives suppress their sites", () => {
    expect(observed("suppressed.ts")).toEqual(
      expectedFromMarkers(sourceOf("suppressed.ts")),
    );
    expect(
      report.directiveProblems.filter(
        (problem) => problem.file === "suppressed.ts",
      ),
    ).toEqual([]);
    expect(report.suppressedHits).toBe(6);
  });

  test("unused, reasonless, and unbalanced directives are errors", () => {
    expect(observed("directives.ts")).toEqual(
      expectedFromMarkers(sourceOf("directives.ts")),
    );
    const problems = report.directiveProblems
      .filter((problem) => problem.file === "directives.ts")
      .map(
        (problem) =>
          `${problem.line}:${problem.message.startsWith("unused") ? "unused" : "malformed"}`,
      );
    expect(problems).toEqual([
      "5:unused",
      "11:malformed",
      "16:malformed",
      "17:malformed",
    ]);
  });

  test("handle modules themselves are outside the fixture scope", () => {
    expect(report.filesScanned).toBe(Object.keys(FIXTURE_FILES).length - 2);
  });
});

describe("API scope", () => {
  test("covers source and scripts, not tests or development seeds", () => {
    expect(isApiSourceInScope("apps/api/src/lib/workflow-queue.ts")).toBe(true);
    expect(isApiSourceInScope("apps/api/scripts/classify-citations.ts")).toBe(
      true,
    );
    expect(isApiSourceInScope("apps/api/src/lib/workflow-queue.test.ts")).toBe(
      false,
    );
    expect(isApiSourceInScope("apps/api/src/tests/security/role.ts")).toBe(
      false,
    );
    expect(isApiSourceInScope("apps/api/scripts/seed-dev.ts")).toBe(false);
    expect(isApiSourceInScope("apps/web/src/routes/index.ts")).toBe(false);
  });
});
