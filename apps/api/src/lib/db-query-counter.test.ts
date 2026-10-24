import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  currentQueryCount,
  currentRepeatedQueryFingerprints,
  currentTransactionCount,
  DB_QUERY_COUNT_HEADER,
  DB_TRANSACTION_COUNT_HEADER,
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

// Yield to the microtask queue so two counter contexts interleave their
// increments; this is what would break a shared (non-ALS) counter.
const logQueriesInterleaved = async (queries: number): Promise<void> => {
  for (let index = 0; index < queries; index += 1) {
    await Promise.resolve();
    queryCountLogger.logQuery("SELECT 1", []);
  }
};

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

// Integration: replicate the HTTP wiring from server.ts (`wrap` opens the
// scope around the composed handler, `onAfterHandle` stamps the count) using
// the real exported helpers. Importing the full `api` is avoided because its
// module evaluation mounts better-auth (which needs DB/env).
//
// This runs against a real listener, not `app.handle`, because the failure it
// pins only exists on a real event loop. The counter used to be opened with
// `AsyncLocalStorage.enterWith` from `onRequest`, which leaves the store on the
// ambient async context frame: a background loop (a BullMQ worker, a reconciler
// tick, the SSE keep-alive — the API process runs all three) that resumed while
// a request's frame was current adopted that request's counter and billed its
// own queries to it, inflating one endpoint's `x-db-queries` by however many
// queries it happened to issue. The route-smoke network baseline caught it as a
// per-endpoint budget failure that passed on re-run.
const buildCountingApp = () =>
  new Elysia()
    .wrap(
      (handleRequest) => (request: Request) =>
        runWithRequestScope(() => handleRequest(request)),
    )
    .onAfterHandle(({ set }) => {
      const queryCount = currentQueryCount();
      const transactionCount = currentTransactionCount();
      if (queryCount !== undefined) {
        set.headers[DB_QUERY_COUNT_HEADER] = String(queryCount);
      }
      if (transactionCount !== undefined) {
        set.headers[DB_TRANSACTION_COUNT_HEADER] = String(transactionCount);
      }
    })
    .get("/queries/:count", async ({ params }) => {
      // Waits on a timer rather than the microtask queue: a query is real I/O,
      // and only an I/O wait leaves the gap in which the background loop below
      // used to resume inside this request's async context frame.
      for (let index = 0; index < Number(params.count); index += 1) {
        await Bun.sleep(QUERY_WAIT_MS);
        queryCountLogger.logQuery("SELECT request", []);
      }
      await runCountedTransaction(async () => undefined);
      return "ok";
    });

// Queries from work that belongs to no request: started before any request
// exists and never awaited by one.
const runBackgroundQueries = (signal: { done: boolean }) => {
  const loop = async () => {
    while (!signal.done) {
      await Bun.sleep(BACKGROUND_QUERY_WAIT_MS);
      queryCountLogger.logQuery("SELECT background", []);
    }
  };
  void loop();
};

describe("db query counter HTTP header", () => {
  test("integration HTTP requests reject per-row SQL through the server request scope", async () => {
    const app = new Elysia()
      .wrap(
        (handleRequest) => async (request: Request) =>
          await runWithHttpRequestScope(async () => {
            const response: unknown = await Promise.resolve(
              handleRequest(request),
            );
            return response instanceof Response
              ? response
              : panic("The HTTP framework returned an invalid response");
          }),
      )
      .get("/queries/:count", ({ params }) => {
        for (let index = 0; index < Number(params.count); index += 1) {
          queryCountLogger.logQuery("SELECT id FROM matters WHERE id = $1", [
            index,
          ]);
        }
        return "ok";
      });

    const single = await app.handle(new Request("http://localhost/queries/1"));
    expect(single.status).toBe(200);
    expect(await single.text()).toBe("ok");
    expect(
      await rejectionOf(app.handle(new Request("http://localhost/queries/2"))),
    ).toMatchObject({ cause: expect.any(RepeatedQueryFingerprintError) });
  });

  test("a request counts its own queries and no others", async () => {
    const signal = { done: false };
    runBackgroundQueries(signal);
    const app = buildCountingApp().listen({ port: 0 });
    const origin = `http://localhost:${app.server?.port ?? panic("test server bound no port")}`;

    const counts: (string | null)[] = [];
    for (let round = 0; round < REQUEST_ROUNDS; round += 1) {
      const response = await fetch(`${origin}/queries/4`);
      counts.push(response.headers.get(DB_QUERY_COUNT_HEADER));
    }

    signal.done = true;
    await app.stop();

    expect(counts).toEqual(Array.from({ length: REQUEST_ROUNDS }, () => "4"));
  });

  test("concurrent requests get independent counts", async () => {
    const app = buildCountingApp();

    const [three, seven] = await Promise.all([
      app.handle(new Request("http://localhost/queries/3")),
      app.handle(new Request("http://localhost/queries/7")),
    ]);

    expect(three.headers.get(DB_QUERY_COUNT_HEADER)).toBe("3");
    expect(seven.headers.get(DB_QUERY_COUNT_HEADER)).toBe("7");
    expect(three.headers.get(DB_TRANSACTION_COUNT_HEADER)).toBe("2");
    expect(seven.headers.get(DB_TRANSACTION_COUNT_HEADER)).toBe("2");
  });
});
