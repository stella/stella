import { describe, expect, spyOn, test } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import { createSafeId } from "@/api/lib/branded-types";

import { runDecisionWriteExtension } from "./decision-write-extension";
import type { DecisionWriteExtension } from "./decision-write-extension";

const dialect = new PgDialect();
const decisionId = createSafeId<"caseLawDecision">();

const transaction = (statementMs = 0, lockMs = 0) => {
  const statements: { sql: string; params: unknown[] }[] = [];
  const stored = ["canonical"];
  let checkpoint = stored.length;
  return {
    statements,
    stored,
    execute: async (query: SQL): Promise<unknown> => {
      const statement = dialect.sqlToQuery(query);
      statements.push(statement);
      if (statement.sql.includes("current_setting")) {
        return [
          {
            statement_timeout: `${statementMs}ms`,
            lock_timeout: `${lockMs}ms`,
          },
        ];
      }
      if (statement.sql.startsWith("SAVEPOINT")) {
        checkpoint = stored.length;
      }
      if (statement.sql.startsWith("ROLLBACK TO")) {
        stored.splice(checkpoint);
      }
      if (statement.sql === "write extension") {
        stored.push("extension");
      }
      if (statement.sql === "fail extension") {
        throw new Error("statement failed");
      }
      return [];
    },
  };
};

describe("decision write extension", () => {
  test("default leaves the transaction alone and reports deferred", async () => {
    const tx = transaction();
    expect(await runDecisionWriteExtension(tx, decisionId)).toEqual({
      type: "deferred",
      reason: "unavailable",
    });
    expect(tx.statements).toEqual([]);
    expect(tx.stored).toEqual(["canonical"]);
  });

  test("applied writes remain in the caller's transaction and original deadlines are restored", async () => {
    const tx = transaction(20, 10);
    expect(
      await runDecisionWriteExtension(tx, decisionId, {
        payload: { contentHash: "a", text: "text", sections: null, ast: null },
        extension: async (context) => {
          expect(context.payload).toEqual({
            contentHash: "a",
            text: "text",
            sections: null,
            ast: null,
          });
          await context.tx.execute(sql.raw("write extension"));
          return { type: "applied" };
        },
      }),
    ).toEqual({ type: "applied" });
    expect(tx.stored).toEqual(["canonical", "extension"]);
    const bound = tx.statements.find((statement) =>
      statement.sql.includes("set_config"),
    );
    expect(bound?.params).toEqual(["20ms", "10ms"]);
    expect(tx.statements.at(-1)?.params).toEqual(["20ms", "10ms"]);
    expect(
      tx.statements.some((statement) => statement.sql.startsWith("ROLLBACK")),
    ).toBe(false);
  });

  test("any deferred or thrown result rolls back only extension output", async () => {
    await assertProperty(
      "any deferred or thrown result rolls back only extension output",
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        async (failStatement, defer, statementMs, lockMs) => {
          const tx = transaction(statementMs, lockMs);
          const outcome = await runDecisionWriteExtension(tx, decisionId, {
            extension: async ({ tx: executor }) => {
              await executor.execute(sql.raw("write extension"));
              if (failStatement) {
                await executor.execute(sql.raw("fail extension"));
              }
              if (defer) {
                return { type: "deferred", reason: "unavailable" };
              }
              return { type: "applied" };
            },
          });
          expect(tx.stored).toEqual(
            failStatement || defer ? ["canonical"] : ["canonical", "extension"],
          );
          expect(outcome.type).toBe(
            failStatement || defer ? "deferred" : "applied",
          );
          expect(
            tx.statements.some((statement) =>
              statement.sql.startsWith("ROLLBACK"),
            ),
          ).toBe(failStatement || defer);
          expect(tx.statements.at(-1)?.params).toEqual([
            `${statementMs}ms`,
            `${lockMs}ms`,
          ]);
        },
      ),
      { numRuns: 20 },
    );
  });

  test("deadline revokes a callback that wakes after the savepoint closes", async () => {
    const clock = spyOn(performance, "now").mockReturnValue(0);
    const tx = transaction();
    let resume: (() => void) | undefined;
    const suspended = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let finished: Promise<void> | undefined;
    const extension: DecisionWriteExtension = async ({ tx: executor }) => {
      await executor.execute(sql.raw("write extension"));
      finished = suspended.then(async () => {
        expect(
          await rejectionOf(executor.execute(sql.raw("late write"))),
        ).toMatchObject({ message: "Decision write executor is closed" });
        return undefined;
      });
      await suspended;
      return { type: "applied" };
    };
    try {
      expect(
        await runDecisionWriteExtension(tx, decisionId, {
          extension,
          deadlineMs: 10,
        }),
      ).toEqual({ type: "deferred", reason: "deadline" });
      expect(finished).toBeDefined();
      expect(tx.stored).toEqual(["canonical"]);
      expect(tx.statements.at(-1)?.params).toEqual(["0ms", "0ms"]);
      resume?.();
      await finished;
      expect(
        tx.statements.some((statement) => statement.sql === "late write"),
      ).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  test.each([0, 9, 10, 11, 100])(
    "executor elapsed time %d is classified before the deadline timer fires",
    async (elapsedMs) => {
      let now = 0;
      const clock = spyOn(performance, "now").mockImplementation(() => now);
      const tx = transaction();
      try {
        const outcome = await runDecisionWriteExtension(tx, decisionId, {
          deadlineMs: 10,
          extension: async ({ tx: executor, signal }) => {
            now = elapsedMs;
            expect(signal.aborted).toBe(false);
            await executor.execute(sql.raw("write extension"));
            return { type: "applied" };
          },
        });
        expect(outcome).toEqual(
          elapsedMs < 10
            ? { type: "applied" }
            : { type: "deferred", reason: "deadline" },
        );
        expect(tx.stored).toEqual(
          elapsedMs < 10 ? ["canonical", "extension"] : ["canonical"],
        );
        expect(
          tx.statements.some(
            (statement) => statement.sql === "write extension",
          ),
        ).toBe(elapsedMs < 10);
        expect(tx.statements.at(-1)?.params).toEqual(["0ms", "0ms"]);
      } finally {
        clock.mockRestore();
      }
    },
  );

  test("parent cancellation rolls back the extension and propagates to its caller", async () => {
    const tx = transaction();
    const controller = new AbortController();
    expect(
      await rejectionOf(
        runDecisionWriteExtension(tx, decisionId, {
          signal: controller.signal,
          extension: async ({ tx: executor }) => {
            await executor.execute(sql.raw("write extension"));
            controller.abort(new Error("caller cancelled"));
            return { type: "deferred", reason: "failed" };
          },
        }),
      ),
    ).toMatchObject({ message: "caller cancelled" });
    expect(tx.stored).toEqual(["canonical"]);
  });

  test("invalid deadline and transaction cleanup failures cannot become success", async () => {
    const tx = transaction();
    expect(
      await rejectionOf(
        runDecisionWriteExtension(tx, decisionId, { deadlineMs: 0 }),
      ),
    ).toMatchObject({ message: "Invalid decision write deadline" });
    expect(
      await rejectionOf(
        runDecisionWriteExtension(
          {
            execute: async (query) => {
              if (dialect.sqlToQuery(query).sql.startsWith("ROLLBACK")) {
                throw new Error("connection lost");
              }
              return await tx.execute(query);
            },
          },
          decisionId,
          { extension: async () => ({ type: "deferred", reason: "failed" }) },
        ),
      ),
    ).toMatchObject({ message: "connection lost" });
  });

  test("restoration failures propagate and never replace an earlier cleanup failure", async () => {
    for (const cleanup of ["success", "failed"] as const) {
      const tx = transaction();
      let restoration = false;
      expect(
        await rejectionOf(
          runDecisionWriteExtension(
            {
              execute: async (query) => {
                const statement = dialect.sqlToQuery(query);
                if (statement.sql.startsWith("ROLLBACK")) {
                  restoration = true;
                  if (cleanup === "failed") {
                    throw new Error("cleanup failed");
                  }
                }
                if (restoration && statement.sql.includes("set_config")) {
                  throw new Error("restoration failed");
                }
                return await tx.execute(query);
              },
            },
            decisionId,
            { extension: async () => ({ type: "deferred", reason: "failed" }) },
          ),
        ),
      ).toMatchObject({
        message: cleanup === "failed" ? "cleanup failed" : "restoration failed",
      });
    }
  });
});
