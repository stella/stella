import { panic } from "better-result";
import type { BunRequest } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { QueryPromise } from "drizzle-orm/query-promise";
import { Script } from "node:vm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createHttpApp } from "@/api/http/app";
import { setResponseHeaders } from "@/api/http/headers";
import { routes } from "@/api/http/route";
import type { Middleware } from "@/api/http/route";
import {
  currentQueryCount,
  currentRepeatedQueryFingerprints,
  currentTransactionCount,
  DB_QUERY_COUNT_HEADER,
  DB_TRANSACTION_COUNT_HEADER,
  instrumentQueryOrigins,
  queryCountLogger,
  RepeatedQueryFingerprintError,
  runCountedTransaction,
  runWithMeasuredQueryCounter,
  runWithQueryCounter,
} from "@/api/lib/db-query-counter";
import {
  runWithHttpRequestScope,
  runWithRequestScope,
} from "@/api/lib/observability/request-scope";
import { serveForTest } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// Yield to the microtask queue so two counter contexts interleave their
// increments; this is what would break a shared (non-ALS) counter.
const logQueriesInterleaved = async (queries: number): Promise<void> => {
  for (let index = 0; index < queries; index += 1) {
    await Promise.resolve();
    queryCountLogger.logQuery("SELECT 1", []);
  }
};

const dependencyQueries = async (body: string) => {
  const invoke: unknown = new Script(
    `(record) => new Promise((resolve) => queueMicrotask(() => {
      const deep = (remaining) => remaining === 0
        ? record("SELECT id FROM session WHERE token = $1", [])
        : deep(remaining - 1);
      ${body}
      resolve();
    }))`,
    {
      filename: `${process.cwd()}/node_modules/query-counter-driver/adapter.js`,
    },
  ).runInThisContext();
  if (typeof invoke !== "function") {
    panic("SQL dependency fixture must be callable");
  }
  await Reflect.apply(invoke, undefined, [queryCountLogger.logQuery]);
};

class LoggedQuery extends QueryPromise<void> {
  execute = async (): Promise<void> => {
    queryCountLogger.logQuery("SELECT id FROM session WHERE token = $1", []);
  };
}

describe("db query counter logger", () => {
  test("distinct callsites may issue the same SQL without a repeated fingerprint", async () => {
    await runWithMeasuredQueryCounter(async () => {
      queryCountLogger.logQuery("SELECT id FROM matters WHERE id = $1", []);
      queryCountLogger.logQuery("SELECT id FROM matters WHERE id = $2", []);
    });
  });

  test("fails after the measured request settles when one callsite repeats normalized SQL", async () => {
    const runSameCallsite = () => {
      for (const query of [
        "select * from matters where id = $1",
        " SELECT * FROM matters WHERE id = $2",
      ]) {
        queryCountLogger.logQuery(query, []);
      }
    };

    expect(
      await rejectionOf(
        runWithMeasuredQueryCounter(async () => {
          runSameCallsite();
        }),
      ),
    ).toMatchObject({ cause: expect.any(RepeatedQueryFingerprintError) });
  });

  test("does nothing and reports no count without an active store", () => {
    expect(currentQueryCount()).toBeUndefined();
    // Must not throw when no request/task store is active (background jobs).
    queryCountLogger.logQuery("SELECT 1", []);
    expect(currentQueryCount()).toBeUndefined();
  });

  test("increments only inside an active store", () => {
    const count = runWithQueryCounter((counter) => {
      queryCountLogger.logQuery("SELECT 1", []);
      queryCountLogger.logQuery("SELECT 2", []);
      return counter.count;
    });

    expect(count).toBe(2);
    // Store is torn down once the callback returns.
    expect(currentQueryCount()).toBeUndefined();
  });

  test("counts transaction round trips separately and fingerprints repeated normalized SQL", async () => {
    const result = await runWithQueryCounter(
      async (counter) => {
        queryCountLogger.logQuery("BEGIN", []);
        await runCountedTransaction(async () => undefined);
        for (const query of [
          "select * from matters where id = $1",
          " SELECT  *  FROM matters WHERE id = $2 ",
        ]) {
          queryCountLogger.logQuery(query, []);
        }
        queryCountLogger.logQuery("COMMIT", []);
        return {
          count: counter.count,
          transactions: currentTransactionCount(),
          repeats: currentRepeatedQueryFingerprints(),
        };
      },
      { detectRepeatedQueries: true, countTransactions: true },
    );

    expect(result.count).toBe(2);
    expect(result.transactions).toBe(2);
    expect(result.repeats).toHaveLength(1);
    expect(result.repeats[0]).toContain("select * from matters where id = ?");
  });

  test("pooled savepoint controls contribute neither statements nor transaction round trips", async () => {
    await runWithQueryCounter(async (counter) => {
      await runCountedTransaction(async () => {
        for (const statement of [
          'SAVEPOINT "nested"',
          'ROLLBACK TO SAVEPOINT "nested"',
          'ROLLBACK WORK TO "nested"',
          'RELEASE SAVEPOINT "nested"',
          'RELEASE "nested"',
        ]) {
          queryCountLogger.logQuery(statement, []);
        }
        queryCountLogger.logQuery("SELECT 1", []);
      });
      expect(counter.count).toBe(1);
      expect(counter.transactions).toBe(2);
    });
  });

  test("pooled lazy queries retain their constructors across sequential awaits", async () => {
    const database = instrumentQueryOrigins({
      select: () => new LoggedQuery(),
    });
    await runWithMeasuredQueryCounter(async (counter) => {
      await database.select();
      await database.select();
      expect(counter.count).toBe(2);
      expect(counter.fingerprints.size).toBe(2);
    });
    expect(
      await rejectionOf(
        runWithMeasuredQueryCounter(async () => {
          for (let index = 0; index < 2; index += 1) {
            await database.select();
          }
        }),
      ),
    ).toMatchObject({ cause: expect.any(RepeatedQueryFingerprintError) });
  });

  test("dependency-only stacks keep distinct deep call chains separate", async () => {
    await runWithMeasuredQueryCounter(async (counter) => {
      await dependencyQueries("deep(20);\n deep(20);");
      expect(counter.count).toBe(2);
      expect(counter.fingerprints.size).toBe(2);
      expect(
        [...counter.fingerprints.keys()].some((key) => key.includes("unknown")),
      ).toBe(false);
    });
  });

  test("a repeated dependency-only call chain still fails its SQL budget", async () => {
    expect(
      await rejectionOf(
        runWithMeasuredQueryCounter(async () => {
          await dependencyQueries("for (const item of [1, 2]) { deep(20); }");
        }),
      ),
    ).toMatchObject({ cause: expect.any(RepeatedQueryFingerprintError) });
  });

  test("unmeasured counters retain no diagnostic fingerprints", () => {
    runWithQueryCounter((counter) => {
      for (const id of [1, 2]) {
        queryCountLogger.logQuery("SELECT id FROM matters WHERE id = $1", [id]);
      }
      expect(counter.count).toBe(2);
      expect(counter.fingerprints.size).toBe(0);
      expect(counter.diagnostics).toBe(false);
      expect(currentRepeatedQueryFingerprints()).toEqual([]);
    });
  });

  test("transaction-disabled children still count each round trip for their parent", async () => {
    await runWithQueryCounter(async (parent) => {
      await runWithQueryCounter(
        async (child) => {
          await runCountedTransaction(async () => {
            queryCountLogger.logQuery("SELECT 1", []);
          });
          expect(child.count).toBe(1);
          expect(child.transactions).toBe(0);
        },
        { countTransactions: false },
      );
      expect(parent.count).toBe(1);
      expect(parent.transactions).toBe(2);
    });
  });

  test("interleaved async contexts count independently", async () => {
    const countContext = async (queries: number): Promise<number> => {
      const count = await runWithQueryCounter(async (counter) => {
        await logQueriesInterleaved(queries);
        return counter.count;
      });
      return count;
    };

    const [first, second] = await Promise.all([
      countContext(3),
      countContext(5),
    ]);

    expect(first).toBe(3);
    expect(second).toBe(5);
  });
});

const QUERY_WAIT_MS = 3;
const BACKGROUND_QUERY_WAIT_MS = 2;
const REQUEST_ROUNDS = 12;

// Integration: the request scope the pipeline opens around every request, and
// a stage that stamps the count on the final answer as the completion stage
// does in local development, served by a real `Bun.serve`.
//
// A real listener matters because the failure this pins only exists on a real
// event loop. The counter used to be opened with `AsyncLocalStorage.enterWith`
// from a request hook, which leaves the store on the ambient async context
// frame: a background loop (a BullMQ worker, a reconciler tick, the SSE
// keep-alive — the API process runs all three) that resumed while a request's
// frame was current adopted that request's counter and billed its own queries
// to it, inflating one endpoint's `x-db-queries` by however many queries it
// happened to issue. The route-smoke network baseline caught it as a
// per-endpoint budget failure that passed on re-run.
const requestScope: Middleware = async (_ctx, inner) =>
  await runWithRequestScope(async () => await inner());

const stampQueryCount: Middleware = async (_ctx, inner) => {
  const response = await inner();
  const queryCount = currentQueryCount();
  const transactionCount = currentTransactionCount();
  return queryCount === undefined && transactionCount === undefined
    ? response
    : setResponseHeaders(
        response,
        {
          ...(queryCount === undefined
            ? {}
            : { [DB_QUERY_COUNT_HEADER]: String(queryCount) }),
          ...(transactionCount === undefined
            ? {}
            : { [DB_TRANSACTION_COUNT_HEADER]: String(transactionCount) }),
        },
        { overwrite: true },
      );
};

const server = serveForTest(
  createHttpApp({
    middleware: [requestScope, stampQueryCount],
    routes: routes({
      "/queries/:count": {
        GET: {
          access: "public",
          config: {},
          run: async ({ ctx }) => {
            // Waits on a timer rather than the microtask queue: a query is
            // real I/O, and only an I/O wait leaves the gap in which the
            // background loop below used to resume inside this request's
            // async context frame.
            for (
              let index = 0;
              index < Number(ctx.params["count"]);
              index += 1
            ) {
              // real-time: only a real I/O wait opens that gap.
              await Bun.sleep(QUERY_WAIT_MS);
              queryCountLogger.logQuery("SELECT request", []);
            }
            await runCountedTransaction(async () => undefined);
            return "ok";
          },
        },
      },
    }),
  }),
);

afterAll(async () => {
  await server.stop();
});

// Queries from work that belongs to no request: started before any request
// exists and never awaited by one.
const runBackgroundQueries = async (signal: {
  done: boolean;
}): Promise<void> => {
  const loop = async () => {
    while (!signal.done) {
      await Bun.sleep(BACKGROUND_QUERY_WAIT_MS);
      queryCountLogger.logQuery("SELECT background", []);
    }
  };
  return loop();
};

describe("db query counter HTTP header", () => {
  test("integration HTTP requests reject per-row SQL through the server request scope", async () => {
    const httpScope: Middleware = async (_ctx, inner) =>
      await runWithHttpRequestScope(async () => await inner());
    const app = createHttpApp({
      middleware: [httpScope],
      routes: routes({
        "/queries/:count": {
          GET: {
            access: "public",
            config: {},
            run: async ({ ctx }) => {
              for (
                let index = 0;
                index < Number(ctx.params["count"]);
                index += 1
              ) {
                queryCountLogger.logQuery(
                  "SELECT id FROM matters WHERE id = $1",
                  [index],
                );
              }
              return "ok";
            },
          },
        },
      }),
    });
    // The mounted route, called in process: the measured scope fails the
    // request after it settles, and that rejection is what is asserted.
    const route = app.serveOptions.routes["/queries/:count"];
    if (route === undefined) {
      throw new TypeError("The probe route is not mounted");
    }
    const host = Bun.serve({ port: 0, fetch: () => new Response(null) });
    const request = (count: string) =>
      asTestRaw<BunRequest>(
        Object.assign(new Request(`http://localhost/queries/${count}`), {
          params: { count },
        }),
      );
    try {
      const single = await route(request("1"), host);
      expect(single.status).toBe(200);
      expect(await single.text()).toBe("ok");
      expect(await rejectionOf(route(request("2"), host))).toMatchObject({
        cause: expect.any(RepeatedQueryFingerprintError),
      });
    } finally {
      await host.stop(true);
    }
  });

  test("a request counts its own queries and no others", async () => {
    const signal = { done: false };
    const background = runBackgroundQueries(signal);

    const counts: (string | null)[] = [];
    for (let round = 0; round < REQUEST_ROUNDS; round += 1) {
      const response = await fetch(new URL("/queries/4", server.url));
      counts.push(response.headers.get(DB_QUERY_COUNT_HEADER));
    }

    signal.done = true;
    await background;

    expect(counts).toEqual(Array.from({ length: REQUEST_ROUNDS }, () => "4"));
  });

  test("concurrent requests get independent counts", async () => {
    const [three, seven] = await Promise.all([
      server.fetch("http://localhost/queries/3"),
      server.fetch("http://localhost/queries/7"),
    ]);

    expect(three.headers.get(DB_QUERY_COUNT_HEADER)).toBe("3");
    expect(seven.headers.get(DB_QUERY_COUNT_HEADER)).toBe("7");
    expect(three.headers.get(DB_TRANSACTION_COUNT_HEADER)).toBe("2");
    expect(seven.headers.get(DB_TRANSACTION_COUNT_HEADER)).toBe("2");
  });
});
