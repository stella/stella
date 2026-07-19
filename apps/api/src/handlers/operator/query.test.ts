import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TransactionRollbackError } from "drizzle-orm";

import { user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

import {
  authorizeOperatorAccess,
  OPERATOR_REGISTRATIONS_MAX_LOOKBACK_DAYS,
  queryRegistrationsPage,
  validateRegistrationsFilter,
} from "./query";

const TOKEN = "operator-test-token-0123456789abcdef";

describe("authorizeOperatorAccess", () => {
  test("disabled when no token is configured, regardless of header", () => {
    expect(
      authorizeOperatorAccess({
        configuredToken: undefined,
        authorizationHeader: `Bearer ${TOKEN}`,
      }),
    ).toEqual({ status: "disabled" });
  });

  test("unauthorized on missing header, non-bearer scheme, or mismatch", () => {
    const cases = [
      null,
      TOKEN,
      `Basic ${TOKEN}`,
      `Bearer ${TOKEN}x`,
      "Bearer ",
    ];
    for (const authorizationHeader of cases) {
      expect(
        authorizeOperatorAccess({
          configuredToken: TOKEN,
          authorizationHeader,
        }),
      ).toEqual({ status: "unauthorized" });
    }
  });

  test("authorized on exact bearer match", () => {
    expect(
      authorizeOperatorAccess({
        configuredToken: TOKEN,
        authorizationHeader: `Bearer ${TOKEN}`,
      }),
    ).toEqual({ status: "authorized" });
  });
});

const daysAgo = (days: number): Date =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000);

describe("validateRegistrationsFilter", () => {
  test("rejects a since older than the lookback window", () => {
    const reason = validateRegistrationsFilter(
      {
        since: daysAgo(
          OPERATOR_REGISTRATIONS_MAX_LOOKBACK_DAYS + 1,
        ).toISOString(),
      },
      new Date(),
    );
    expect(reason).toEqual({
      ok: false,
      message: `since must be within the last ${OPERATOR_REGISTRATIONS_MAX_LOOKBACK_DAYS} days`,
    });
  });

  test("accepts a since inside the lookback window", () => {
    expect(
      validateRegistrationsFilter(
        {
          since: daysAgo(
            OPERATOR_REGISTRATIONS_MAX_LOOKBACK_DAYS - 1,
          ).toISOString(),
        },
        new Date(),
      ).ok,
    ).toBe(true);
  });

  test("rejects a missing since", () => {
    expect(validateRegistrationsFilter({}, new Date())).toEqual({
      ok: false,
      message: "since is required",
    });
  });

  test("rejects a malformed since instead of bypassing the lookback check", () => {
    expect(
      validateRegistrationsFilter({ since: "not-a-date" }, new Date()),
    ).toEqual({ ok: false, message: "since must be an ISO date-time" });
  });

  test("rejects a non-integer limit", () => {
    expect(
      validateRegistrationsFilter(
        { since: daysAgo(1).toISOString(), limit: "many" },
        new Date(),
      ).ok,
    ).toBe(false);
  });

  test("rejects a malformed cursor", () => {
    expect(
      validateRegistrationsFilter(
        { since: daysAgo(1).toISOString(), cursor: "not-a-cursor" },
        new Date(),
      ),
    ).toEqual({ ok: false, message: "Invalid cursor" });
  });
});

describe("queryRegistrationsPage", () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await getTestDb();
  });

  afterAll(async () => {
    await releaseTestDb();
  });

  /** Seed + query inside one rolled-back transaction so the shared test
   *  database keeps no rows from this suite. */
  const withSeededRegistrations = async (
    run: (safeDb: SafeDb) => Promise<void>,
  ): Promise<void> => {
    try {
      await testDb.transaction(async (tx) => {
        await tx.insert(user).values([
          {
            id: "op-reg-outside",
            name: "Outside Window",
            email: "op-reg-outside@example.test",
            createdAt: daysAgo(30),
          },
          {
            id: "op-reg-a",
            name: "Registration A",
            email: "op-reg-a@example.test",
            createdAt: daysAgo(9),
          },
          {
            id: "op-reg-b",
            name: "Registration B",
            email: "op-reg-b@example.test",
            createdAt: daysAgo(8),
          },
          {
            id: "op-reg-c",
            name: "Registration C",
            email: "op-reg-c@example.test",
            createdAt: daysAgo(7),
          },
        ]);

        const safeDb: SafeDb = async (fn) =>
          await Result.tryPromise(
            async () => await fn(asTestRaw<Transaction>(tx)),
          );
        await run(safeDb);
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) {
        throw error;
      }
    }
  };

  const runPage = async (
    safeDb: SafeDb,
    query: { since: string; limit?: string; cursor?: string },
  ) => {
    const validated = validateRegistrationsFilter(query, new Date());
    if (!validated.ok) {
      throw new Error(validated.message);
    }
    const result = await Result.gen(() =>
      queryRegistrationsPage({ safeDb, filter: validated.filter }),
    );
    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    return result.value;
  };

  test("returns only accounts after since, oldest first, exactly four fields, and pages by cursor", async () => {
    await withSeededRegistrations(async (safeDb) => {
      const since = daysAgo(10).toISOString();

      const firstPage = await runPage(safeDb, { since, limit: "2" });
      expect(firstPage.limit).toBe(2);
      expect(firstPage.items.map((item) => item.id)).toEqual([
        "op-reg-a",
        "op-reg-b",
      ]);
      expect(firstPage.nextCursor).not.toBeNull();
      for (const item of firstPage.items) {
        expect(Object.keys(item).sort()).toEqual([
          "createdAt",
          "email",
          "id",
          "name",
        ]);
      }
      expect(firstPage.items.at(0)).toEqual({
        id: "op-reg-a",
        name: "Registration A",
        email: "op-reg-a@example.test",
        createdAt: expect.any(Date),
      });

      // The issued cursor passes the same validation callers run up front.
      const cursor = firstPage.nextCursor;
      if (cursor === null) {
        throw new Error("expected a next cursor");
      }
      expect(
        validateRegistrationsFilter({ since, cursor }, new Date()).ok,
      ).toBe(true);

      const secondPage = await runPage(safeDb, { since, limit: "2", cursor });
      expect(secondPage.items.at(0)?.id).toBe("op-reg-c");
    });
  });

  test("returns no cursor when the window fits one page and excludes pre-since accounts", async () => {
    await withSeededRegistrations(async (safeDb) => {
      // A wide limit that still cannot reach op-reg-outside (before since).
      const page = await runPage(safeDb, {
        since: daysAgo(10).toISOString(),
        limit: "50",
      });
      const ids = page.items.map((item) => item.id);
      expect(ids).not.toContain("op-reg-outside");
      expect(ids.slice(0, 3)).toEqual(["op-reg-a", "op-reg-b", "op-reg-c"]);
      expect(page.nextCursor).toBeNull();
    });
  });
});
