import { expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  runCitationGraphTransaction,
  tryCitationGraphTransaction,
} from "./citation-graph-transaction";

const harness = ({
  locked = true,
  failure,
}: { locked?: boolean; failure?: Error } = {}) => {
  const statements: string[] = [];
  let committed = false;
  let rolledBack = false;
  const dialect = new PgDialect();
  const tx = {
    execute: async (query: SQL) => {
      statements.push(dialect.sqlToQuery(query).sql);
      if (failure) {
        throw failure;
      }
      return [{ locked }];
    },
    domainWrite: async () => {
      statements.push("domain-write");
    },
  };
  const transact = async <T>(run: (transaction: typeof tx) => Promise<T>) => {
    try {
      const result = await run(tx);
      committed = true;
      return result;
    } catch (error) {
      rolledBack = true;
      throw error;
    }
  };
  return {
    tx,
    transact,
    statements,
    outcome: () => ({ committed, rolledBack }),
  };
};

test("graph admission precedes domain writes and retains transaction operations", async () => {
  const db = harness();
  const value = await runCitationGraphTransaction(db.transact, async (tx) => {
    await tx.domainWrite();
    return "written";
  });
  expect(value).toBe("written");
  expect(db.statements).toEqual([
    "SELECT pg_advisory_xact_lock(hashtext('case_law'), hashtext('citation_resolution_walk'))",
    "domain-write",
  ]);
  expect(db.outcome()).toEqual({ committed: true, rolledBack: false });
});

test.each([true, false])(
  "conditional graph admission runs writes only when acquired: %s",
  async (locked) => {
    const db = harness({ locked });
    const value = await tryCitationGraphTransaction(db.transact, async (tx) => {
      await tx.domainWrite();
      return "written";
    });
    expect(value).toBe(locked ? "written" : null);
    expect(db.statements).toEqual([
      "SELECT pg_try_advisory_xact_lock(hashtext('case_law'), hashtext('citation_resolution_walk')) AS locked",
      ...(locked ? ["domain-write"] : []),
    ]);
  },
);

test("a failed graph acquisition never admits domain writes", async () => {
  const failure = new Error("graph acquisition failed");
  for (const admit of [
    runCitationGraphTransaction,
    tryCitationGraphTransaction,
  ]) {
    const db = harness({ failure });
    expect(
      await rejectionOf(
        admit(db.transact, async (tx) => {
          await tx.domainWrite();
        }),
      ),
    ).toBe(failure);
    expect(db.statements).toHaveLength(1);
    expect(db.outcome()).toEqual({ committed: false, rolledBack: true });
  }
});

test("a callback failure rolls its admitted transaction back", async () => {
  const db = harness();
  expect(
    await rejectionOf(
      runCitationGraphTransaction(db.transact, async (tx) => {
        await tx.domainWrite();
        throw new Error("domain write failed");
      }),
    ),
  ).toMatchObject({ message: "domain write failed" });
  expect(db.outcome()).toEqual({ committed: false, rolledBack: true });
});
