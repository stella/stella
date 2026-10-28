import { expect, test } from "bun:test";
import { QueryPromise } from "drizzle-orm/query-promise";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  currentQueryCounter,
  instrumentDedicatedSqlCounts,
  RepeatedQueryFingerprintError,
  runWithMeasuredQueryCounter,
  runWithQueryCounter,
} from "@/api/lib/db-query-counter";
import { createStatementCeilingMonitor } from "@/api/lib/db/statement-ceiling";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

import { createDedicatedConnectionOwner } from "./dedicated-connection-slots";
import {
  withDedicatedReservedSession,
  withLongRunningConnection,
} from "./long-running-connection";

test("dedicated connection rejects invalid budgets before opening", async () => {
  const signal = new AbortController().signal;
  for (const invalid of [0, -1, Number.NaN, Infinity, 1.5]) {
    expect(
      await withLongRunningConnection(
        { lockTimeout: 1, statementTimeout: invalid, signal },
        async () => "opened",
      ).then(
        () => "accepted",
        () => "rejected",
      ),
    ).toBe("rejected");
  }
});

test("abort waits for backend cancellation before closing the session", async () => {
  const events: string[] = [];
  const controller = new AbortController();
  const query = Promise.withResolvers<unknown>();
  const cancellation = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  const workSettled = Promise.withResolvers<undefined>();
  const run = withDedicatedReservedSession({
    reserve: async () => ({
      unsafe: async (statement: string) => {
        if (statement.includes("pg_backend_pid")) {
          return [{ pid: 42 }];
        }
        events.push("query started");
        started.resolve(undefined);
        return await query.promise;
      },
      release: async () => {
        events.push("release");
      },
      close: async () => {
        events.push("close");
      },
    }),
    cancelBackend: async (pid) => {
      events.push(`cancel ${pid}`);
      await cancellation.promise;
      events.push("cancel settled");
    },
    signal: controller.signal,
    work: async (connection) => {
      await connection.unsafe("SELECT pg_sleep(60)");
      workSettled.resolve(undefined);
      return "done";
    },
  });
  await started.promise;
  controller.abort();
  query.resolve([]);
  await workSettled.promise;
  expect(events).not.toContain("close");
  cancellation.resolve(undefined);
  expect(await run).toBe("done");
  expect(events).toEqual([
    "query started",
    "cancel 42",
    "cancel settled",
    "close",
  ]);
});

test("abort between statements refuses the next statement", async () => {
  const controller = new AbortController();
  const statements: string[] = [];
  const run = withDedicatedReservedSession({
    reserve: async () => ({
      unsafe: async (statement: string) => {
        statements.push(statement);
        return statement.includes("pg_backend_pid") ? [{ pid: 42 }] : [];
      },
      release: async () => {},
      close: async () => {},
    }),
    cancelBackend: async () => {},
    signal: controller.signal,
    work: async (session) => {
      await session.unsafe("SELECT 1");
      controller.abort(new Error("session aborted between statements"));
      await session.unsafe("SELECT pg_sleep(60)");
    },
  });

  const rejection: unknown = await run.then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection instanceof Error ? rejection.message : rejection).toBe(
    "session aborted between statements",
  );
  expect(statements).toEqual(["SELECT pg_backend_pid() AS pid", "SELECT 1"]);
});

test("failed backend cancellation is reported before the session closes", async () => {
  const controller = new AbortController();
  const logs = installRecordingLogger();
  const events: string[] = [];
  const failure = new TypeError("cancellation connection failed");
  try {
    const run = withDedicatedReservedSession({
      reserve: async () => ({
        unsafe: async () => [{ pid: 42 }],
        release: async () => {
          events.push("release");
        },
        close: async () => {
          expect(
            logs.records.some(
              (record) => record.message === "db.long_running.cancel_failed",
            ),
          ).toBe(true);
          events.push("close");
        },
      }),
      cancelBackend: async () => {
        events.push("cancel");
        throw failure;
      },
      signal: controller.signal,
      work: async () => {
        controller.abort();
      },
    });

    await run;
    expect(events).toEqual(["cancel", "close"]);
    expect(logs.at("ERROR")).toContainEqual(
      expect.objectContaining({
        message: "db.long_running.cancel_failed",
        attributes: expect.objectContaining({ "error.type": "TypeError" }),
      }),
    );
  } finally {
    logs.restore();
  }
});

type RecordedRows = readonly Record<string, unknown>[];

/** A lazy transport query: constructing or modifying it performs no work. */
class RecordingSqlQuery extends QueryPromise<RecordedRows> {
  private state:
    | { type: "pending" }
    | { type: "cancelled" }
    | { type: "started"; result: Promise<RecordedRows> } = { type: "pending" };
  private readonly executeRows: () => Promise<RecordedRows>;
  constructor(executeRows: () => Promise<RecordedRows>) {
    super();
    this.executeRows = executeRows;
  }
  get cancelled() {
    return this.state.type === "cancelled";
  }
  private async start(): Promise<RecordedRows> {
    if (this.state.type === "cancelled") {
      throw new TypeError("query cancelled before dispatch");
    }
    if (this.state.type === "pending") {
      this.state = { type: "started", result: this.executeRows() };
    }
    return this.state.result;
  }
  async execute() {
    return this.start();
  }
  values() {
    return this;
  }
  raw() {
    return this;
  }
  simple() {
    return this;
  }
  cancel() {
    this.state = { type: "cancelled" };
    return this;
  }
  readable() {
    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        await this.start();
        controller.close();
      },
    });
  }
  writable() {
    return new WritableStream<Uint8Array>({
      close: async () => {
        await this.start();
      },
    });
  }
}

type RecordingSqlSession = {
  (parts: TemplateStringsArray, ...params: unknown[]): RecordingSqlQuery;
  unsafe: (statement: string, params?: unknown[]) => RecordingSqlQuery;
  end: () => Promise<void>;
  release: () => Promise<void>;
  close: () => Promise<void>;
  reserve: () => Promise<RecordingSqlSession>;
  begin: <T>(run: (session: RecordingSqlSession) => Promise<T>) => Promise<T>;
  savepoint: <T>(
    run: (session: RecordingSqlSession) => Promise<T>,
  ) => Promise<T>;
};

const recordingSqlClient = (
  statements: string[],
  queries: RecordingSqlQuery[] = [],
) => {
  const rows = [{ pid: 42, value: "kept" }];
  const query = (statement: string) => {
    const result = new RecordingSqlQuery(async () => {
      statements.push(statement);
      return rows;
    });
    queries.push(result);
    return result;
  };
  const client: RecordingSqlSession = Object.assign(
    (parts: TemplateStringsArray, ..._params: unknown[]) =>
      query(parts.join(" ? ")),
    {
      unsafe: (statement: string, _params?: unknown[]) => query(statement),
      end: async () => {},
      release: async () => {},
      close: async () => {},
      reserve: async () => client,
      begin: async <T>(
        run: (session: RecordingSqlSession) => Promise<T>,
      ): Promise<T> => await run(client),
      savepoint: async <T>(
        run: (session: RecordingSqlSession) => Promise<T>,
      ): Promise<T> => await run(client),
    },
  );
  return client;
};

test("dedicated lazy execution preserves modifiers, results, rejection and one count per query", async () => {
  const statements: string[] = [];
  const queries: RecordingSqlQuery[] = [];
  const client = instrumentDedicatedSqlCounts(
    recordingSqlClient(statements, queries),
  );
  expect(instrumentDedicatedSqlCounts(client)).toBe(client);
  await runWithQueryCounter(async (counter) => {
    const unused = client.unsafe("SELECT unused");
    const query = client.unsafe("SELECT kept").values().raw().simple();
    expect(queries.at(0)).toBe(unused);
    expect(queries.at(1)).toBe(query);
    expect(Object.keys(query)).not.toContain("then");
    expect(counter.count).toBe(0);
    expect(statements).toEqual([]);
    const execution = query.execute();
    const rows = await query;
    expect(await execution).toBe(rows);
    expect(await query.then((value) => value)).toBe(rows);
    expect(
      await query.catch((error: unknown) => {
        throw error;
      }),
    ).toBe(rows);
    expect(await query.finally(() => {})).toBe(rows);
    expect(counter.count).toBe(1);
    expect(statements).toEqual(["SELECT kept"]);
    unused.cancel();
    expect(await rejectionOf(unused)).toMatchObject({
      message: "query cancelled before dispatch",
    });
    expect(counter.count).toBe(1);
    const read = client.unsafe("COPY readable").readable();
    await read.getReader().read();
    await client.unsafe("COPY writable").writable().getWriter().close();
    expect(counter.count).toBe(3);
    expect(statements).toEqual([
      "SELECT kept",
      "COPY readable",
      "COPY writable",
    ]);
    const captureTemplate = (strings: TemplateStringsArray) => strings;
    const literals = captureTemplate`SELECT bound`;
    const bound = client.bind(undefined);
    const foreignReceiver = { connection: "foreign" };
    expect(await bound(literals)).toEqual([{ pid: 42, value: "kept" }]);
    expect(await client.call(foreignReceiver, literals)).toEqual([
      { pid: 42, value: "kept" },
    ]);
    expect(await client.apply(foreignReceiver, [literals])).toEqual([
      { pid: 42, value: "kept" },
    ]);
    expect(counter.count).toBe(6);
    expect(statements.slice(-3)).toEqual([
      "SELECT bound",
      "SELECT bound",
      "SELECT bound",
    ]);
  });
});

test("the dedicated owner counts reserved setup, raw work, nested transactions and cancellation once", async () => {
  const statements: string[] = [];
  const owner = createDedicatedConnectionOwner({
    capacity: 3,
    openClient: () =>
      instrumentDedicatedSqlCounts(recordingSqlClient(statements)),
  });
  const controller = new AbortController();
  await runWithQueryCounter(async (counter) => {
    const dedicated = await owner.openLongRunningSql({
      url: "postgres://fixture.invalid/database",
      connectionTimeout: 1,
      statementTimeout: 1000,
      lockTimeout: 100,
      cancellationStatementTimeout: 100,
      signal: controller.signal,
    });
    try {
      await withDedicatedReservedSession({
        reserve: async () => await dedicated.client.reserve(),
        cancelBackend: dedicated.cancelBackend,
        signal: controller.signal,
        work: async (session, setBudget) => {
          await setBudget({ lockTimeout: 10, statementTimeout: 20 });
          await session`SELECT tagged`;
          await session.unsafe("SELECT raw");
          await session.begin(async (transaction) => {
            await transaction.unsafe("SELECT transaction");
            await transaction.savepoint(async (nested) => {
              await nested.unsafe("SELECT nested");
            });
          });
          await dedicated.cancelBackend(42);
        },
      });
    } finally {
      await dedicated.end();
    }
    expect(counter.count).toBe(8);
    expect(counter.transactions).toBe(2);
    expect(statements).toEqual([
      "SELECT pg_backend_pid() AS pid",
      "SET LOCAL lock_timeout = '10ms'",
      "SET LOCAL statement_timeout = '20ms'",
      "SELECT tagged",
      "SELECT raw",
      "SELECT transaction",
      "SELECT nested",
      "SELECT pg_cancel_backend($1)",
    ]);
  });
});

test("lazy queries keep distinct construction origins when started through the same executor", async () => {
  const statements: string[] = [];
  const client = instrumentDedicatedSqlCounts(recordingSqlClient(statements));
  const first = client.unsafe("SELECT 1");
  const second = client.unsafe("SELECT 1");
  await runWithMeasuredQueryCounter(async (counter) => {
    await first;
    await second;
    await first;
    expect(counter.count).toBe(2);
    expect(counter.fingerprints.size).toBe(2);
  });
});

test("lazy queries from one construction callsite still expose repeated work", async () => {
  const client = instrumentDedicatedSqlCounts(recordingSqlClient([]));
  expect(
    await rejectionOf(
      runWithMeasuredQueryCounter(async () => {
        for (const item of [1, 2]) {
          await client.unsafe(`SELECT ${String(item)}`);
        }
      }),
    ),
  ).toMatchObject({ cause: expect.any(RepeatedQueryFingerprintError) });
});

test("dedicated savepoint controls do not add statements or transaction round trips", async () => {
  const statements: string[] = [];
  const client = instrumentDedicatedSqlCounts(recordingSqlClient(statements));
  await runWithQueryCounter(async (counter) => {
    for (const statement of [
      "BEGIN",
      'SAVEPOINT "nested"',
      'ROLLBACK TO SAVEPOINT "nested"',
      'ROLLBACK TRANSACTION TO "nested"',
      'RELEASE SAVEPOINT "nested"',
      'RELEASE "nested"',
      "SELECT 1",
      "COMMIT",
    ]) {
      await client.unsafe(statement);
    }
    expect(counter.count).toBe(1);
    expect(counter.transactions).toBe(2);
  });
});

test("dedicated work reaches the unchanged ceiling and keeps its violation after refusal", async () => {
  const statements: string[] = [];
  const session = instrumentDedicatedSqlCounts(recordingSqlClient(statements));
  const monitor = createStatementCeilingMonitor({
    request: {},
    mcp: {},
    worker: {},
    scheduler: {},
  });
  const failure = await rejectionOf(
    runWithQueryCounter(async (counter) => {
      const active = currentQueryCounter();
      if (active === undefined) {
        throw new TypeError("Expected active query counter");
      }
      active.onQuery = (phase) =>
        monitor.record({
          phase,
          kind: "scheduler",
          key: "<dedicated-fixture>",
          counter,
        });
      await withDedicatedReservedSession({
        reserve: async () => session,
        cancelBackend: async () => {},
        signal: new AbortController().signal,
        work: async (reserved) => {
          for (let index = 0; index < 100; index++) {
            await reserved.unsafe("SELECT bounded", [index]);
          }
        },
      });
    }),
  );
  expect(String(failure)).toContain("101 statements");
  expect(statements).toHaveLength(100);
  expect(() => monitor.assertSatisfied()).toThrow("101 statements");
});

test("an exceeded ceiling retains cancellation and rollback counts without blocking cleanup", async () => {
  const statements: string[] = [];
  const closed: string[] = [];
  const owner = createDedicatedConnectionOwner({
    capacity: 3,
    openClient: (_options, purpose) =>
      instrumentDedicatedSqlCounts(
        Object.assign(recordingSqlClient(statements), {
          end: async () => {
            closed.push(purpose);
          },
        }),
        purpose === "cancellation" ? "cleanup" : "work",
      ),
  });
  const monitor = createStatementCeilingMonitor({
    request: {},
    mcp: {},
    worker: {},
    scheduler: {},
  });
  const controller = new AbortController();
  const failure = await rejectionOf(
    runWithQueryCounter(async (counter) => {
      const active = currentQueryCounter();
      if (active === undefined) {
        throw new TypeError("Expected active query counter");
      }
      active.onQuery = (phase) =>
        monitor.record({
          phase,
          kind: "scheduler",
          key: "<dedicated-cleanup-fixture>",
          counter,
        });
      const dedicated = await owner.openLongRunningSql({
        url: "postgres://fixture.invalid/database",
        connectionTimeout: 1,
        statementTimeout: 1000,
        lockTimeout: 100,
        cancellationStatementTimeout: 100,
        signal: controller.signal,
      });
      try {
        await withDedicatedReservedSession({
          reserve: async () => await dedicated.client.reserve(),
          cancelBackend: dedicated.cancelBackend,
          signal: controller.signal,
          work: async (session) => {
            try {
              for (let index = 0; index < 100; index++) {
                await session.unsafe("SELECT bounded", [index]);
              }
            } finally {
              await session.unsafe("ROLLBACK");
              controller.abort();
            }
          },
        });
      } finally {
        await dedicated.end();
        expect(counter.count).toBe(102);
        expect(counter.transactions).toBe(1);
      }
    }),
  );
  expect(String(failure)).toContain("101 statements");
  expect(statements).toHaveLength(102);
  expect(statements.slice(-2)).toEqual([
    "ROLLBACK",
    "SELECT pg_cancel_backend($1)",
  ]);
  expect(closed).toEqual(["cancellation", "work"]);
  expect(() => monitor.assertSatisfied()).toThrow("103 statements");
});

test("a cancellation dispatched outside its task still belongs to the reserved task counter", async () => {
  const statements: string[] = [];
  const session = instrumentDedicatedSqlCounts(recordingSqlClient(statements));
  const controller = new AbortController();
  const started = Promise.withResolvers<undefined>();
  const finish = Promise.withResolvers<undefined>();
  const measured = runWithQueryCounter(async (counter) => {
    await withDedicatedReservedSession({
      reserve: async () => session,
      cancelBackend: async (pid) => {
        await session.unsafe("SELECT pg_cancel_backend($1)", [pid]);
      },
      signal: controller.signal,
      work: async () => {
        started.resolve(undefined);
        await finish.promise;
      },
    });
    return counter;
  });
  await started.promise;
  controller.abort();
  finish.resolve(undefined);
  const counter = await measured;
  expect(counter.count).toBe(2);
  expect(statements).toEqual([
    "SELECT pg_backend_pid() AS pid",
    "SELECT pg_cancel_backend($1)",
  ]);
});
