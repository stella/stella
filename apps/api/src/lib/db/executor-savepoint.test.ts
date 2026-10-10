import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { rejectionOf } from "@stll/property-testing/rejection";

import { withExecutorSavepoint } from "@/api/lib/db/aggregate-lock";

const journal = () => {
  const events: string[] = [];
  const dialect = new PgDialect();
  const tx = {
    execute: async (statement: SQL) => {
      events.push(dialect.sqlToQuery(statement).sql);
      return [];
    },
  };
  return { tx, events };
};

const namesOf = (events: readonly string[]) =>
  events.map((statement) =>
    /"(stella_scope_[a-f\d]+)"$/u.exec(statement)?.at(1),
  );

describe("execute-only savepoints", () => {
  test("commit releases one unique scope after the callback", async () => {
    const { tx, events } = journal();
    const result = await withExecutorSavepoint(tx, async () => {
      events.push("callback");
      return { type: "commit", value: "written" };
    });
    expect(result.unwrap()).toBe("written");
    expect(events.at(0)).toStartWith("SAVEPOINT ");
    expect(events.at(1)).toBe("callback");
    expect(events.at(2)).toStartWith("RELEASE SAVEPOINT ");
    expect(namesOf(events).at(0)).toBe(namesOf(events).at(2));
  });

  test("typed rollback rolls back before releasing and preserves the result", async () => {
    const { tx, events } = journal();
    expect(
      await withExecutorSavepoint(tx, async () => ({
        type: "rollback",
        value: "pending",
      })),
    ).toMatchObject({ value: "pending" });
    expect(events.map((event) => event.split(' "').at(0))).toEqual([
      "SAVEPOINT",
      "ROLLBACK TO SAVEPOINT",
      "RELEASE SAVEPOINT",
    ]);
    expect(new Set(namesOf(events)).size).toBe(1);
  });

  test("callback failure cleans up and allows a later unique scope", async () => {
    const { tx, events } = journal();
    const failure = new Error("callback failed");
    expect(
      await withExecutorSavepoint(tx, async () => {
        throw failure;
      }),
    ).toMatchObject({ error: { cause: failure, phase: "callback" } });
    expect(events.map((event) => event.split(' "').at(0))).toEqual([
      "SAVEPOINT",
      "ROLLBACK TO SAVEPOINT",
      "RELEASE SAVEPOINT",
    ]);
    const first = namesOf(events).at(0);
    await withExecutorSavepoint(tx, async () => ({
      type: "commit",
      value: undefined,
    }));
    expect(namesOf(events).at(3)).not.toBe(first);
  });

  test("nested scopes on one executor are refused before issuing SQL", async () => {
    const { tx, events } = journal();
    await withExecutorSavepoint(tx, async () => {
      expect(
        await rejectionOf(
          withExecutorSavepoint(tx, async () => ({
            type: "commit",
            value: undefined,
          })),
        ),
      ).toMatchObject({
        message: "Await the executor savepoint before reusing its transaction",
      });
      expect(events).toHaveLength(1);
      return { type: "commit", value: undefined };
    });
    expect(events).toHaveLength(2);
  });

  test("setup failure does not retain the executor admission", async () => {
    const { tx: next, events } = journal();
    let failing = true;
    const failure = new Error("savepoint failed");
    const tx = {
      execute: async (statement: SQL) => {
        if (failing) {
          failing = false;
          throw failure;
        }
        return await next.execute(statement);
      },
    };
    expect(
      await withExecutorSavepoint(tx, async () => ({
        type: "commit",
        value: undefined,
      })),
    ).toMatchObject({ error: { cause: failure, phase: "setup" } });
    await withExecutorSavepoint(tx, async () => ({
      type: "commit",
      value: "retry",
    }));
    expect(events).toHaveLength(2);
  });
  for (const command of ["ROLLBACK TO SAVEPOINT", "RELEASE SAVEPOINT"]) {
    test(`${command} failure reports fatal cleanup and releases admission`, async () => {
      const { tx: next, events } = journal();
      const failure = new Error("cleanup failed");
      let failing = true;
      const tx = {
        execute: async (statement: SQL) => {
          const query = new PgDialect().sqlToQuery(statement).sql;
          if (failing && query.startsWith(command)) {
            failing = false;
            throw failure;
          }
          return await next.execute(statement);
        },
      };
      const result = await withExecutorSavepoint(tx, async () => ({
        type: "rollback",
        value: "pending",
      }));
      expect(result).toMatchObject({
        error: { cause: failure, phase: "cleanup" },
      });
      const retry = await withExecutorSavepoint(tx, async () => ({
        type: "commit",
        value: "retry",
      }));
      expect(retry.unwrap()).toBe("retry");
      expect(events.at(-1)).toStartWith("RELEASE SAVEPOINT ");
    });
  }
});
