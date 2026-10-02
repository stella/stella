import { expect, test } from "bun:test";

import {
  checkTimeEntryPolicyLocks,
  findTimeEntryPolicyLocks,
  isTimeEntryPolicySource,
} from "./check-time-entry-policy-locks.ts";

const FILE = "apps/api/src/handlers/time-entries/example.ts";
const IMPORTS = `
import { timeEntries } from "@/api/db/schema";
import { lockTimePolicy, type LockedTimePolicy } from "@/api/lib/billing-time";
`;
const operations = (source: string) =>
  findTimeEntryPolicyLocks(FILE, IMPORTS + source).map(
    ({ operation }) => operation,
  );

test.each(["insert", "update", "delete"])(
  "requires policy evidence for every time entry %s",
  (operation) => {
    expect(
      operations(
        `await safeDb(async (tx) => { await tx.${operation}(timeEntries); });`,
      ),
    ).toEqual([operation]);
    expect(
      operations(`await safeDb(async (tx) => {
      const policy = await lockTimePolicy(tx, organizationId);
      await tx.${operation}(timeEntries);
    });`),
    ).toEqual([]);
  },
);

test.each([
  [
    "preflight",
    `const policy = await lockTimePolicy(db, organizationId);
    await safeDb(async (tx) => { await tx.update(timeEntries); });`,
  ],
  [
    "different transaction",
    `await safeDb(async (tx) => {
    const policy = await lockTimePolicy(otherTx, organizationId);
    await tx.update(timeEntries);
  });`,
  ],
  [
    "later lock",
    `await safeDb(async (tx) => {
    await tx.update(timeEntries);
    const policy = await lockTimePolicy(tx, organizationId);
  });`,
  ],
  [
    "unawaited lock",
    `await safeDb(async (tx) => {
    const policy = lockTimePolicy(tx, organizationId);
    await tx.update(timeEntries);
  });`,
  ],
  [
    "unexecuted sibling callback",
    `await safeDb(async (tx) => {
    const unused = async () => { const policy = await lockTimePolicy(tx, organizationId); };
    await tx.update(timeEntries);
  });`,
  ],
  [
    "conditional lock",
    `await safeDb(async (tx) => {
    if (condition) { const policy = await lockTimePolicy(tx, organizationId); }
    await tx.update(timeEntries);
  });`,
  ],
  [
    "text",
    `await safeDb(async (tx) => {
    // const policy = await lockTimePolicy(tx, organizationId);
    const description = "lockTimePolicy(tx, organizationId)";
    await tx.update(timeEntries);
  });`,
  ],
])("rejects %s as transaction policy evidence", (_description, source) => {
  expect(operations(source)).toEqual(["update"]);
});

test("allows locks from enclosing blocks within the same function", () => {
  expect(
    operations(`await safeDb(async (tx) => {
    const policy = await lockTimePolicy(tx, organizationId);
    for (const row of rows) { await tx.delete(timeEntries); }
  });`),
  ).toEqual([]);
});

test("checks each transaction independently", () => {
  expect(
    operations(`await safeDb(async (tx) => {
    const policy = await lockTimePolicy(tx, organizationId);
    await tx.insert(timeEntries);
  });
  await safeDb(async (tx) => { await tx.delete(timeEntries); });`),
  ).toEqual(["delete"]);
});

test("recognizes aliases imported from the policy owner and schema", () => {
  expect(
    findTimeEntryPolicyLocks(
      FILE,
      `
    import { timeEntries as entries } from "@/api/db/schema";
    import { lockTimePolicy as acquire } from "@/api/lib/billing-time";
    await safeDb(async (transaction) => {
      const policy = await acquire(transaction, organizationId);
      await transaction.update(entries);
    });
    await safeDb(async (transaction) => { await transaction.delete(entries); });
  `,
    ).map(({ operation }) => operation),
  ).toEqual(["delete"]);
});

test("follows table aliases within their lexical scope", () => {
  expect(
    operations(`const entries = timeEntries;
    const same = entries;
    await safeDb(async (tx) => { await tx.update(same); });
    await safeDb(async (tx) => {
      const entries = timeTimers;
      await tx.update(entries);
    });
    await safeDb(async (tx) => {
      const policy = await lockTimePolicy(tx, organizationId);
      await tx.delete(same);
    });`),
  ).toEqual(["update"]);
});

test("requires the lock implementation from the policy owner", () => {
  expect(
    findTimeEntryPolicyLocks(
      FILE,
      `
    import { lockTimePolicy } from "./unrelated";
    await safeDb(async (tx) => {
      const policy = await lockTimePolicy(tx, organizationId);
      await tx.update(timeEntries);
    });
  `,
    ).map(({ operation }) => operation),
  ).toEqual(["update"]);
});

test("accepts required helper proof through local aliases and intersections", () => {
  expect(
    operations(`type Owner = { tx: Transaction };
    type Options = Owner & { policy: LockedTimePolicy };
    const insert = async ({ tx, policy }: Options) => { await tx.insert(timeEntries); };`),
  ).toEqual([]);
});

test.each([
  "{ tx: Transaction; policy?: LockedTimePolicy }",
  "{ tx: Transaction; policy: LockedTimePolicy | undefined }",
  "{ tx: Transaction; policy: LockedTimePolicy } | { tx: Transaction }",
])("rejects optional helper evidence in %s", (options) => {
  expect(
    operations(`type Options = ${options};
    const update = async ({ tx }: Options) => { await tx.update(timeEntries); };`),
  ).toEqual(["update"]);
});

test("does not accept a locally defined proof type", () => {
  expect(
    findTimeEntryPolicyLocks(
      FILE,
      `type LockedTimePolicy = {};
    const update = async (tx: Transaction, policy: LockedTimePolicy) => {
      await tx.update(timeEntries);
    };`,
    ).map(({ operation }) => operation),
  ).toEqual(["update"]);
});

test("detects SQL time entry mutations", () => {
  const interpolation = ["$", "{timeEntries}"].join("");
  expect(
    operations(`await safeDb(async (tx) => {
    await tx.execute(sql\`UPDATE ${interpolation} SET status = 'draft'\`);
    await tx.execute(sql\`DELETE FROM time_entries WHERE id = 'id'\`);
  });`),
  ).toEqual(["update", "delete"]);
});

test("detects raw SQL and mutations within common table expressions", () => {
  const interpolation = ["$", "{entries}"].join("");
  expect(
    operations(`const entries = timeEntries;
    await safeDb(async (tx) => {
      const query = sql.raw("UPDATE time_entries SET status = 'draft'");
      await tx.execute(query);
      await tx.execute(sql.raw('DELETE FROM "time_entries" WHERE id = 1'));
      await tx.execute(sql\`WITH changed AS (INSERT INTO ${interpolation} (id) VALUES ('id') RETURNING *) SELECT * FROM changed\`);
    });`),
  ).toEqual(["update", "delete", "insert"]);
});

test("accepts SQL writes protected by the transaction policy lock", () => {
  expect(
    operations(`await safeDb(async (tx) => {
    const policy = await lockTimePolicy(tx, organizationId);
    await tx.execute(sql.raw("UPDATE time_entries SET status = 'draft'"));
  });`),
  ).toEqual([]);
});

test("ignores SQL reads, quoted text, comments, and different table names", () => {
  const interpolation = ["$", "{timeEntries}"].join("");
  expect(
    operations(`await safeDb(async (tx) => {
    await tx.execute(sql\`SELECT * FROM ${interpolation} FOR UPDATE\`);
    await tx.execute(sql.raw("SELECT 'UPDATE time_entries SET status = 1'"));
    await tx.execute(sql.raw("SELECT 'escaped''DELETE FROM time_entries'"));
    await tx.execute(sql.raw("SELECT * FROM time_entries -- UPDATE time_entries SET status = 1"));
    await tx.execute(sql.raw("SELECT * FROM time_entries /* DELETE FROM time_entries */"));
    await tx.execute(sql.raw("UPDATE time_entries_archive SET status = 1"));
    await tx.execute(sql.raw("DELETE FROM time_timers WHERE id = 1"));
  });`),
  ).toEqual([]);
});

test("leaves reads and other table writes outside the policy guard", () => {
  expect(
    operations(`await safeDb(async (tx) => {
    await tx.select().from(timeEntries);
    await tx.update(timeTimers);
  });`),
  ).toEqual([]);
});

test("scans every production source root without production exemptions", () => {
  const files = [
    "apps/api/src/handlers/time-entries/update.ts",
    "apps/api/src/handlers/time-entries/batch/delete.ts",
    "apps/api/src/handlers/time-timers/finalize.ts",
    "apps/api/src/lib/billing/time-entry-insert.ts",
    "apps/api/src/lib/billing/time-timers.ts",
    "apps/api/src/lib/time-entry-offboarding.ts",
  ];
  expect(files.every(isTimeEntryPolicySource)).toBe(true);
  const excluded = [
    "apps/api/src/handlers/time-entries/update.postgres.test.ts",
    "apps/api/src/lib/billing/example.d.ts",
    "apps/api/src/handlers/matters/update.ts",
  ];
  expect(excluded.some(isTimeEntryPolicySource)).toBe(false);
  expect(
    checkTimeEntryPolicyLocks({
      files: [...files, ...excluded],
      read: () =>
        `${
          IMPORTS
        }const mutate = async (tx) => { await tx.update(timeEntries); };`,
    }).map(({ file }) => file),
  ).toEqual(files.toSorted());
});
