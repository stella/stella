import { describe, expect, expectTypeOf, test } from "bun:test";

import {
  AUTOVACUUM_SQL,
  LONG_TRANSACTION_SQL,
} from "@stll/db-load-gate/indicators";
import { rejectionOf } from "@stll/property-testing/rejection";

import { blockStatementsOf } from "@/api/tests/helpers/lock-taking-sql";

import { readOnlineIndexConfig } from "../env-online-index";
import { createMigrationLockTelemetry } from "./migration-lock-observation";
import type { MigrationLockEvent } from "./migration-lock-observation";
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
  runGatedTableWork,
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
  createSql:
    'CREATE INDEX CONCURRENTLY "probe_idx" ON public."probe" USING btree (id)',
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
  return statements.find((text) => !text.startsWith("SET lock_timeout")) ?? "";
};

describe("online lock-taking statements", () => {
  test("a raw execute rejects a lock-taking statement at compile time", () => {
    const { connection } = recordingConnection();
    const statement = dropIndexConcurrently(INDEX, { ifExists: true });
    expectTypeOf(statement).not.toExtend<
      Parameters<typeof connection.execute>[0]
    >();
  });

  test("each builder names its table and renders one statement", async () => {
    const cases: [LockTakingStatement, string][] = [
      [
        createIndexConcurrently(INDEX),
        'CREATE INDEX CONCURRENTLY "probe_idx" ON public."probe" USING btree (id)',
      ],
      [
        createIndexConcurrently({
          ...INDEX,
          createSql:
            'CREATE UNIQUE INDEX CONCURRENTLY "probe_idx" ON public."probe" USING btree (id)',
          isUnique: true,
        }),
        'CREATE UNIQUE INDEX CONCURRENTLY "probe_idx" ON public."probe" USING btree (id)',
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
      expect(statement.lockQueue).toBe("beside_writers");
      expect(await sqlOf(statement)).toBe(sql);
    }
  });

  test("a declared build must build the declared index on the declared table", () => {
    const { createSql } = INDEX;
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

  test("a declared concurrent build cannot append another statement", () => {
    expect(() =>
      createIndexConcurrently({
        ...INDEX,
        createSql: `${INDEX.createSql}; DROP TABLE public.probe`,
      }),
    ).toThrow("single statement or expression");
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

test("a held table gate emits one deferred attempt without starting work", async () => {
  const records: MigrationLockEvent[] = [];
  const lockTelemetry = createMigrationLockTelemetry();
  lockTelemetry.emit = (record) => {
    records.push(record);
  };
  const connection: OnlineMigrationConnection = {
    execute: async () => undefined,
    query: async () => [{ pid: 11 }],
    release: () => undefined,
  };
  const observer: OnlineMigrationConnection = {
    execute: async () => undefined,
    query: async () => [],
    release: () => undefined,
  };
  let workCount = 0;
  const result = await runGatedTableWork({
    connection,
    reserveObserver: async () => observer,
    target: INDEX,
    kind: "index_build",
    gate: {
      lockTelemetry,
      log: () => undefined,
      ebs: {
        type: "reader",
        read: async () => ({
          indicator: "ebs_balance",
          kind: "unknown",
          value: null,
          threshold: 70,
          observedAt: null,
          reason: "Metric unavailable",
        }),
      },
    },
    work: async () => {
      workCount += 1;
    },
  });
  expect(result.type).toBe("deferred");
  expect(workCount).toBe(0);
  expect(records).toHaveLength(1);
  expect(records.at(0)).toMatchObject({
    phase: "online",
    outcome: "deferred",
    step: INDEX.name,
    table: INDEX.tableName,
    attempt: 1,
    retriesSpent: 0,
    waitMs: 0,
    blockers: [],
  });
});

const POLICY = {
  tableName: "probe",
  name: "probe_policy",
  as: "restrictive",
  for: "all",
  role: "stella",
  using: "probe.gate = 'open'",
  withCheck: "probe.gate = 'open'",
} as const satisfies PolicyDefinition;

test("exhausted statement retries report the same deferred outcome as the gate", async () => {
  const records: MigrationLockEvent[] = [];
  const lockTelemetry = createMigrationLockTelemetry();
  lockTelemetry.emit = (record) => {
    records.push(record);
  };
  const observedAt = "2026-10-02T12:00:00.000Z";
  let attempts = 0;
  const connection: OnlineMigrationConnection = {
    execute: async (text) => {
      if (text.startsWith("DO ")) {
        attempts += 1;
        throw Object.assign(new Error("lock unavailable"), { code: "55P03" });
      }
    },
    query: async (text) => {
      if (text.includes("advisory")) {
        return [{ acquired: true }];
      }
      if (text.includes("pg_backend_pid")) {
        return [{ pid: 11, database: "test" }];
      }
      return [];
    },
    terminate: async () => undefined,
    release: () => undefined,
  };
  const observer: OnlineMigrationConnection = {
    execute: async () => undefined,
    query: async (text) => {
      if (text === LONG_TRANSACTION_SQL) {
        return [{ ageMs: 0, observedAt }];
      }
      if (text === AUTOVACUUM_SQL) {
        return [{ active: false, observedAt }];
      }
      if (text.includes('"stateAgeMs"')) {
        return [];
      }
      if (text.includes("pg_backend_pid")) {
        return [{ pid: 12, database: "test" }];
      }
      return [];
    },
    release: () => undefined,
  };
  const result = await runGatedTableWork({
    connection,
    reserveObserver: async () => observer,
    target: { tableName: POLICY.tableName, name: POLICY.name },
    kind: "index_repair",
    lockRetry: {
      config: {
        lockTimeoutsMs: [100, 250],
        pauseBaseMs: 10,
        pauseCapMs: 20,
        budgetMs: 2000,
      },
      runtime: { now: () => 0, sleep: async () => undefined, random: () => 0 },
    },
    gate: {
      config: readOnlineIndexConfig({ DB_LOAD_GATE_BUSY_WINDOWS: "[]" }),
      clock: () => Date.parse(observedAt),
      lockTelemetry,
      log: () => undefined,
      ebs: {
        type: "reader",
        read: async () => ({
          indicator: "ebs_balance",
          kind: "normal",
          value: 100,
          threshold: 70,
          observedAt,
          reason: "Injected reading",
        }),
      },
      wait: async (_milliseconds, signal) =>
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
          } else {
            signal.addEventListener("abort", () => resolve(), { once: true });
          }
        }),
    },
    work: async (session) => await session.run(createPolicy(POLICY)),
  });
  expect(result.type).toBe("deferred");
  expect(attempts).toBe(2);
  expect(records).toHaveLength(1);
  expect(records.at(0)).toMatchObject({
    outcome: "deferred",
    attempt: 2,
    retriesSpent: 1,
    step: POLICY.name,
  });
});

describe("online ACCESS EXCLUSIVE statements", () => {
  test("each runs atomically and declares its writer-blocking lock class", async () => {
    const created =
      'CREATE POLICY "probe_policy" ON "public"."probe" AS RESTRICTIVE FOR ALL TO "stella" USING (probe.gate = \'open\') WITH CHECK (probe.gate = \'open\')';
    const { withCheck: _withCheck, ...usingPolicy } = POLICY;
    const cases: [LockTakingStatement, string[]][] = [
      [createPolicy(POLICY), [created]],
      [
        createPolicy({
          ...usingPolicy,
          as: "permissive",
          for: "select",
        }),
        [
          'CREATE POLICY "probe_policy" ON "public"."probe" AS PERMISSIVE FOR SELECT TO "stella" USING (probe.gate = \'open\')',
        ],
      ],
      [
        alterPolicy(usingPolicy),
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
      expect(statement.lockQueue).toBe("blocks_writers");
      expect(await blockStatementsOf(statement)).toEqual(statements);
    }
  });

  test("writer-blocking work retries bounded requests and restores the watched timeout", async () => {
    const statements: string[] = [];
    let failures = 2;
    let now = 0;
    const lockFailure = Object.assign(new Error("lock unavailable"), {
      code: "55P03",
    });
    const connection = {
      execute: async (text: string) => {
        statements.push(text);
        if (text.startsWith("DO ") && failures-- > 0) {
          throw lockFailure;
        }
      },
      query: async () => [],
    };
    const gate = createUngatedTableGateForTests(connection, {
      config: {
        lockTimeoutsMs: [100, 250, 500],
        pauseBaseMs: 10,
        pauseCapMs: 20,
        budgetMs: 2000,
      },
      runtime: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        random: () => 0.5,
      },
    });
    expect(
      await gate.run({
        target: { tableName: "probe", name: "policy" },
        kind: "index_repair",
        work: async (session) => {
          await session.run(createPolicy(POLICY));
          await session.run(analyzeTable("probe"));
        },
      }),
    ).toEqual({ type: "complete" });
    expect(
      statements.filter((text) => text.startsWith("SET lock_timeout")),
    ).toEqual([
      "SET lock_timeout = '100ms'",
      "SET lock_timeout = '0'",
      "SET lock_timeout = '250ms'",
      "SET lock_timeout = '0'",
      "SET lock_timeout = '500ms'",
      "SET lock_timeout = '0'",
    ]);
    expect(statements.filter((text) => text.startsWith("DO "))).toHaveLength(3);
    expect(statements.at(-1)).toBe('ANALYZE public."probe"');
  });

  test("writer-blocking retry clears its request before the retry pause", async () => {
    const events: string[] = [];
    let attempts = 0;
    const lockFailure = Object.assign(new Error("lock unavailable"), {
      code: "55P03",
    });
    const gate = createUngatedTableGateForTests(
      {
        execute: async (text) => {
          events.push(text);
          if (text.startsWith("DO ") && attempts++ === 0) {
            throw lockFailure;
          }
        },
        query: async () => [],
      },
      {
        config: {
          lockTimeoutsMs: [100, 250],
          pauseBaseMs: 10,
          pauseCapMs: 10,
          budgetMs: 2000,
        },
        runtime: {
          now: () => 0,
          sleep: async () => {
            events.push("pause");
          },
          random: () => 1,
        },
      },
    );

    await gate.run({
      target: { tableName: "probe", name: "policy" },
      kind: "index_repair",
      work: async (session) => {
        await session.run(createPolicy(POLICY));
      },
    });

    expect(events.at(1)?.startsWith("DO ")).toBe(true);
    expect([events.at(0), events.at(2), events.at(3)]).toEqual([
      "SET lock_timeout = '100ms'",
      "SET lock_timeout = '0'",
      "pause",
    ]);
  });

  test("exhausted writer-blocking work leaves subsequent statements for a later run", async () => {
    const lockFailure = Object.assign(new Error("lock unavailable"), {
      code: "55P03",
    });
    const statements: string[] = [];
    const gate = createUngatedTableGateForTests(
      {
        execute: async (text) => {
          statements.push(text);
          if (text.startsWith("DO ")) {
            throw lockFailure;
          }
        },
        query: async () => [],
      },
      {
        config: {
          lockTimeoutsMs: [100, 250],
          pauseBaseMs: 10,
          pauseCapMs: 20,
          budgetMs: 2000,
        },
        runtime: {
          now: () => 0,
          sleep: async () => undefined,
          random: () => 0,
        },
      },
    );
    const rejection = await rejectionOf(
      gate.run({
        target: { tableName: "probe", name: "policy" },
        kind: "index_repair",
        work: async (session) => {
          await session.run(createPolicy(POLICY));
          await session.run(analyzeTable("probe"));
        },
      }),
    );
    expect(rejection).toMatchObject({
      reason: "exhausted",
      attempts: 2,
      lockTimeoutMs: 250,
      cause: lockFailure,
    });
    expect(statements.filter((text) => text.startsWith("DO "))).toHaveLength(2);
    expect(statements.at(-1)).toBe("SET lock_timeout = '0'");
    expect(statements.some((text) => text.startsWith("ANALYZE"))).toBe(false);
  });

  test("spliced text is one expression: a second statement never reaches SQL", () => {
    const {
      using: _using,
      withCheck: _withCheck,
      ...withoutExpressions
    } = POLICY;
    expect(() =>
      createPolicy({ ...POLICY, using: "true); DROP TABLE x; --" }),
    ).toThrow("must be a single statement or expression");
    expect(() =>
      replacePolicy({ ...POLICY, withCheck: "$online_ddl$ x" }),
    ).toThrow("must be a single statement or expression");
    expect(() => alterPolicy(withoutExpressions)).toThrow(
      "changes no expression",
    );
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
