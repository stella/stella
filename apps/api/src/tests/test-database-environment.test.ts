import { describe, expect, test } from "bun:test";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

import {
  configureTestDatabaseEnvironment,
  POSTGRES_TEST_MARKER,
  ROOT_POOL_SENTINEL_MESSAGE,
  rootPoolConnectionCount,
  rootPoolSentinelUrl,
} from "./test-database-environment";

describe("test database environment", () => {
  test("points hermetic tests at the root pool sentinel", () => {
    const environment = {
      DATABASE_URL: "postgres://stella:password@localhost:5432/stella",
    };

    configureTestDatabaseEnvironment(
      environment,
      () => "postgres://postgres:postgres@127.0.0.1:1/stella",
    );

    expect(environment.DATABASE_URL).toBe(
      "postgres://postgres:postgres@127.0.0.1:1/stella",
    );
  });

  test("preserves the explicit Postgres test database", () => {
    const environment = {
      DATABASE_URL: "postgres://integration:password@db.example/stella",
      [POSTGRES_TEST_MARKER]: "true",
    };

    configureTestDatabaseEnvironment(environment);

    expect(environment.DATABASE_URL).toBe(
      "postgres://integration:password@db.example/stella",
    );
  });

  test("preserves the explicit query performance database", () => {
    const environment = {
      DATABASE_URL: "postgres://integration:password@db.example/stella",
      STELLA_RUN_QUERY_PERF_TESTS: "true",
    };
    configureTestDatabaseEnvironment(environment);
    expect(environment.DATABASE_URL).toBe(
      "postgres://integration:password@db.example/stella",
    );
  });

  test("fails a query that reaches the sentinel at once, and counts it", async () => {
    const before = rootPoolConnectionCount() ?? 0;
    const failure = await withGatedTestClients(
      rootPoolSentinelUrl(),
      async ({ openClient }) => {
        const { sql } = openClient();
        // Awaited directly: `expect(query).rejects` never settles on a Bun
        // SQL query, which is a lazy thenable.
        return await sql`select 1`.then(
          () => null,
          (error: unknown) => error,
        );
      },
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain(ROOT_POOL_SENTINEL_MESSAGE);
    expect(rootPoolConnectionCount()).toBe(before + 1);
  });

  test("keeps counting after a garbage collection", async () => {
    const url = rootPoolSentinelUrl();
    Bun.gc(true);
    const before = rootPoolConnectionCount() ?? 0;
    const failure = await withGatedTestClients(url, async ({ openClient }) => {
      const { sql } = openClient();
      return await sql`select 1`.then(
        () => null,
        (error: unknown) => error,
      );
    });
    expect(String(failure)).toContain(ROOT_POOL_SENTINEL_MESSAGE);
    expect(rootPoolConnectionCount()).toBe(before + 1);
  });
});
