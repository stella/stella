import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { blockStatementsOf } from "@/api/tests/helpers/lock-taking-sql";

import {
  alterPolicy,
  analyzeTable,
  callDeclaredFunction,
  createIndexConcurrently,
  createPolicy,
  createUngatedTableGateForTests,
  dropIndexConcurrently,
  dropPolicy,
  reindexIndexConcurrently,
  renameIndex,
  replacePolicy,
  setRowLevelSecurity,
  validateConstraint,
  validateOnlineConstraints,
} from "./online-ddl";
import type {
  LockTakingStatement,
  OnlineTableGate,
  PolicyDefinition,
} from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";

const INDEX = {
  name: "probe_idx",
  tableName: "probe",
  definitionBody: "ON public.probe USING btree (id)",
  isUnique: false,
};

/** Records each statement; the catalog reports `validated` constraints. */
const recordingConnection = (validated: ReadonlySet<string> = new Set()) => {
  const statements: string[] = [];
  const connection: OnlineMigrationConnection = {
    execute: async (query) => {
      statements.push(query);
    },
    query: async (query, params = []) => {
      statements.push(query);
      const constraintName = params.at(2);
      return query.includes("pg_constraint") &&
        typeof constraintName === "string"
        ? [{ isValidated: validated.has(constraintName) }]
        : [];
    },
    release: () => undefined,
  };
  return { connection, statements };
};

/** What each statement executes, read the only way a caller can: by running it. */
const sqlOf = async (statement: LockTakingStatement): Promise<string> => {
  const { connection, statements } = recordingConnection();
  await createUngatedTableGateForTests(connection).run({
    target: { tableName: statement.tableName, name: "probe" },
    kind: "index_repair",
    work: async (session) => {
      await session.run(statement);
    },
  });
  return statements.at(0) ?? "";
};

describe("online lock-taking statements", () => {
  test("a raw execute rejects a lock-taking statement at compile time", async () => {
    const { connection, statements } = recordingConnection();
    const statement = dropIndexConcurrently(INDEX, { ifExists: true });
    // The statement is not a string, so the phase's short-budget session has
    // no way to run it outside the gate.
    // @ts-expect-error A LockTakingStatement is not SQL text for a raw session.
    await connection.execute(statement);
    // At run time the object reaches the driver as no SQL text at all.
    expect(statements).toEqual([statement]);
  });

  test("each builder names its table and renders one statement", async () => {
    const cases: [LockTakingStatement, string][] = [
      [
        createIndexConcurrently(INDEX),
        'CREATE INDEX CONCURRENTLY "probe_idx" ON public.probe USING btree (id)',
      ],
      [
        createIndexConcurrently({ ...INDEX, isUnique: true }),
        'CREATE UNIQUE INDEX CONCURRENTLY "probe_idx" ON public.probe USING btree (id)',
      ],
      [
        dropIndexConcurrently(INDEX, { ifExists: true }),
        'DROP INDEX CONCURRENTLY IF EXISTS public."probe_idx"',
      ],
      [
        dropIndexConcurrently(INDEX, { ifExists: false }),
        'DROP INDEX CONCURRENTLY public."probe_idx"',
      ],
      [
        reindexIndexConcurrently(INDEX),
        'REINDEX INDEX CONCURRENTLY public."probe_idx"',
      ],
      [
        renameIndex({
          from: { name: "probe_idx_next", tableName: "probe" },
          to: INDEX,
        }),
        'ALTER INDEX public."probe_idx_next" RENAME TO "probe_idx"',
      ],
      [
        validateConstraint({
          tableName: "probe",
          constraintName: "probe_check",
        }),
        'ALTER TABLE public."probe" VALIDATE CONSTRAINT "probe_check"',
      ],
      [analyzeTable("probe"), 'ANALYZE public."probe"'],
    ];
    for (const [statement, sql] of cases) {
      expect(statement.tableName).toBe("probe");
      expect(await sqlOf(statement)).toBe(sql);
    }
  });

  test("a declared build must build the declared index on the declared table", () => {
    const createSql =
      'CREATE INDEX CONCURRENTLY "probe_idx" ON public."probe" USING btree (id)';
    expect(() =>
      createIndexConcurrently({ ...INDEX, createSql }),
    ).not.toThrow();
    for (const mismatched of [
      createSql.replace('"probe_idx"', '"other_idx"'),
      createSql.replace('public."probe"', 'public."other"'),
      createSql.replace(" CONCURRENTLY", ""),
    ]) {
      expect(() =>
        createIndexConcurrently({ ...INDEX, createSql: mismatched }),
      ).toThrow("must build it concurrently on public.probe");
    }
  });

  test("gated work locks only the table its gate watched", async () => {
    const { connection, statements } = recordingConnection();
    const rejection = await rejectionOf(
      createUngatedTableGateForTests(connection).run({
        target: { tableName: "probe", name: "probe_idx" },
        kind: "index_repair",
        work: async (session) => {
          await session.run(analyzeTable("other"));
        },
      }),
    );
    expect(String(rejection)).toContain(
      "Gated work on probe cannot lock other",
    );
    expect(statements).toEqual([]);
  });

  test("identifiers outside the internal shape never reach SQL", () => {
    expect(() => analyzeTable('probe"; DROP TABLE x; --')).toThrow(
      "Invalid internal PostgreSQL identifier",
    );
    expect(() =>
      renameIndex({
        from: { name: "probe_idx", tableName: "probe" },
        to: { name: "probe_idx", tableName: "other" },
      }),
    ).toThrow("cannot be renamed onto another table");
  });
});

describe("validateOnlineConstraints", () => {
  const constraints = ["first_check", "second_check", "third_check"].map(
    (constraintName) => ({ tableName: "probe", constraintName }),
  );

  test("validates only the constraints the catalog reports NOT VALID, in order", async () => {
    const { connection, statements } = recordingConnection(
      new Set(["second_check"]),
    );
    expect(
      await validateOnlineConstraints({
        connection,
        tables: createUngatedTableGateForTests(connection),
        constraints,
      }),
    ).toEqual({ type: "complete" });
    expect(
      statements.filter((statement) => statement.startsWith("ALTER TABLE")),
    ).toEqual([
      'ALTER TABLE public."probe" VALIDATE CONSTRAINT "first_check"',
      'ALTER TABLE public."probe" VALIDATE CONSTRAINT "third_check"',
    ]);
  });

  test("stops at the first deferral and leaves later constraints for the next run", async () => {
    const { connection } = recordingConnection();
    const requested: string[] = [];
    const held: OnlineTableGate = {
      run: async ({ target }) => {
        requested.push(target.name);
        return { type: "deferred", step: target.name, retryAfterMs: 5 };
      },
    };
    expect(
      await validateOnlineConstraints({
        connection,
        tables: held,
        constraints,
      }),
    ).toEqual({ type: "deferred", step: "first_check", retryAfterMs: 5 });
    expect(requested).toEqual(["first_check"]);
  });

  test("a constraint the schema migration never added is a broken deploy", async () => {
    const connection: OnlineMigrationConnection = {
      ...recordingConnection().connection,
      query: async () => [],
    };
    expect(
      String(
        await rejectionOf(
          validateOnlineConstraints({
            connection,
            tables: createUngatedTableGateForTests(connection),
            constraints,
          }),
        ),
      ),
    ).toContain("constraint first_check is missing");
  });
});

const POLICY: PolicyDefinition = {
  tableName: "probe",
  name: "probe_policy",
  as: "restrictive",
  for: "all",
  role: "stella",
  using: "probe.gate = 'open'",
  withCheck: "probe.gate = 'open'",
};

describe("online ACCESS EXCLUSIVE statements", () => {
  test("each runs as one block under its own short lock budget", async () => {
    const created =
      'CREATE POLICY "probe_policy" ON "public"."probe" AS RESTRICTIVE FOR ALL TO "stella" USING (probe.gate = \'open\') WITH CHECK (probe.gate = \'open\')';
    const cases: [LockTakingStatement, string[]][] = [
      [createPolicy(POLICY), [created]],
      [
        createPolicy({
          ...POLICY,
          as: "permissive",
          for: "select",
          withCheck: undefined,
        }),
        [
          'CREATE POLICY "probe_policy" ON "public"."probe" AS PERMISSIVE FOR SELECT TO "stella" USING (probe.gate = \'open\')',
        ],
      ],
      [
        alterPolicy({ ...POLICY, withCheck: undefined }),
        [
          'ALTER POLICY "probe_policy" ON "public"."probe" USING (probe.gate = \'open\')',
        ],
      ],
      [
        dropPolicy(POLICY, { ifExists: false }),
        ['DROP POLICY "probe_policy" ON "public"."probe"'],
      ],
      [
        replacePolicy(POLICY),
        ['DROP POLICY IF EXISTS "probe_policy" ON "public"."probe"', created],
      ],
      [
        setRowLevelSecurity("probe", "enable"),
        ['ALTER TABLE "public"."probe" ENABLE ROW LEVEL SECURITY'],
      ],
      [
        setRowLevelSecurity("probe", "force"),
        ['ALTER TABLE "public"."probe" FORCE ROW LEVEL SECURITY'],
      ],
    ];
    for (const [statement, statements] of cases) {
      expect(statement.tableName).toBe("probe");
      expect(await blockStatementsOf(statement)).toEqual(statements);
    }
  });

  test("spliced text is one expression: a second statement never reaches SQL", () => {
    expect(() =>
      createPolicy({ ...POLICY, using: "true); DROP TABLE x; --" }),
    ).toThrow("must be a single statement or expression");
    expect(() =>
      replacePolicy({ ...POLICY, withCheck: "$online_ddl$ x" }),
    ).toThrow("must be a single statement or expression");
    expect(() =>
      alterPolicy({ ...POLICY, using: undefined, withCheck: undefined }),
    ).toThrow("changes no expression");
  });

  test("only a function declared online is callable, on the table it locks", () => {
    expect(() =>
      callDeclaredFunction({
        // @ts-expect-error The registry declares this function offline.
        name: "entity_feature_gate_finish",
        tableName: "entities",
      }),
    ).toThrow("is not callable from the online phase");
  });
});
