import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import {
  beginRequestQueryCounter,
  currentQueryCount,
  DB_QUERY_COUNT_HEADER,
  queryCountLogger,
  runWithQueryCounter,
} from "@/api/lib/db-query-counter";

// Yield to the microtask queue so two counter contexts interleave their
// increments; this is what would break a shared (non-ALS) counter.
const logQueriesInterleaved = async (queries: number): Promise<void> => {
  for (let index = 0; index < queries; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential yields are the point: each hop of the microtask queue lets the other context increment in between, which is exactly what a shared (non-ALS) counter would get wrong
    await Promise.resolve();
    queryCountLogger.logQuery("SELECT 1", []);
  }
};

describe("db query counter logger", () => {
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

// Integration: replicate the exact Elysia wiring from src/index.ts
// (enterWith in onRequest, header in onAfterHandle) using the real exported
// helpers, driven through `app.handle`. Importing the full `api` is avoided
// because its module evaluation mounts better-auth (which needs DB/env);
// exercising the helpers here proves the mechanism inside Elysia's lifecycle,
// including that concurrent requests do not leak counts across each other.
const buildCountingApp = () =>
  new Elysia()
    .onRequest(() => {
      beginRequestQueryCounter();
    })
    .onAfterHandle(({ set }) => {
      const queryCount = currentQueryCount();
      if (queryCount !== undefined) {
        set.headers[DB_QUERY_COUNT_HEADER] = String(queryCount);
      }
    })
    .get("/queries/:count", async ({ params }) => {
      await logQueriesInterleaved(Number(params.count));
      return "ok";
    });

describe("db query counter HTTP header", () => {
  test("header equals the number of queries the handler ran", async () => {
    const app = buildCountingApp();

    const response = await app.handle(
      new Request("http://localhost/queries/4"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get(DB_QUERY_COUNT_HEADER)).toBe("4");
  });

  test("concurrent requests get independent counts (no store leak)", async () => {
    const app = buildCountingApp();

    const [three, seven] = await Promise.all([
      app.handle(new Request("http://localhost/queries/3")),
      app.handle(new Request("http://localhost/queries/7")),
    ]);

    expect(three.headers.get(DB_QUERY_COUNT_HEADER)).toBe("3");
    expect(seven.headers.get(DB_QUERY_COUNT_HEADER)).toBe("7");
  });
});
