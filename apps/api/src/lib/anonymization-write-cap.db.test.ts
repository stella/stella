import { Panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql, TransactionRollbackError } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  anonymizationAllowlistEntries,
  anonymizationBlacklistEntries,
  workspaces,
} from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import {
  countWorkspaceAnonymizationAllowlistForWrite,
  loadOrganizationAnonymizationTermsForWrite,
  loadWorkspaceAnonymizationTermsForWrite,
} from "./anonymization-write-cap";

/**
 * The cap these helpers protect is what the complete anonymization
 * reads rest on, so the tests assert the two properties that make it
 * hold: the set is read whole (never a prefix that would under-count),
 * and the transaction is holding the scope's advisory lock by the time
 * the caller decides whether another row fits.
 *
 * Blocking itself is not observable here: the shared PGlite instance is
 * a single-threaded WASM backend, so a second transaction cannot run
 * concurrently to be blocked (see `src/tests/security/test-utils.ts`).
 * What is observable, and is what a blocked writer would contend for,
 * is the lock the backend actually holds: `pg_locks` shows it, one
 * entry per scope, shared by every writer of that scope's set.
 */

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

const runRolledBack = async <T>(
  callback: (tx: Transaction) => Promise<T>,
): Promise<T> => {
  let value: T | undefined;
  try {
    await testDb.transaction(async (tx) => {
      // eslint-disable-next-line node/callback-return -- must call tx.rollback() after capturing the value
      value = await callback(asTestRaw<Transaction>(tx));
      tx.rollback();
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError && value !== undefined) {
      return value;
    }
    throw error;
  }

  if (value === undefined) {
    throw new Error("Rolled-back test transaction did not return a value");
  }
  return value;
};

type Scope = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

const seedScope = async (tx: Transaction): Promise<Scope> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const workspaceId = toSafeId<"workspace">(Bun.randomUUIDv7());

  await tx.insert(organization).values({
    id: organizationId,
    name: "Anonymization cap test firm",
    slug: `anonymization-cap-${Bun.randomUUIDv7()}`,
    createdAt: new Date(),
  });
  await tx.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Anonymization cap matter",
    reference: Bun.randomUUIDv7().slice(0, 8),
  });

  return { organizationId, workspaceId };
};

const insertTerms = async (
  tx: Transaction,
  {
    organizationId,
    workspaceId,
    count,
    prefix,
  }: {
    organizationId: SafeId<"organization">;
    workspaceId: SafeId<"workspace"> | null;
    count: number;
    prefix: string;
  },
): Promise<void> => {
  await tx.insert(anonymizationBlacklistEntries).values(
    Array.from({ length: count }, (_unused, index) => ({
      id: createSafeId<"anonymizationBlacklistEntry">(),
      organizationId,
      workspaceId,
      label: "person",
      canonical: `${prefix} ${String(index).padStart(4, "0")}`,
    })),
  );
};

/**
 * `pg_locks` as the catalogue view it is, so the lock assertions can be
 * ordinary typed reads. Advisory keys arrive as a pair of `oid` columns
 * and are only ever read through the rendered `key` expression below.
 */
const pgLocks = pgTable("pg_locks", {
  locktype: text("locktype"),
  classid: integer("classid"),
  objid: integer("objid"),
  pid: integer("pid"),
});

/**
 * Advisory locks this backend holds right now, one entry per distinct
 * key. A concurrent writer computing the same key is exactly what these
 * entries would make wait.
 */
const heldAdvisoryLockKeys = async (tx: Transaction): Promise<string[]> => {
  const rows = await tx
    .select({
      key: sql<string>`${pgLocks.classid}::text || ':' || ${pgLocks.objid}::text`,
    })
    .from(pgLocks)
    .where(
      and(
        eq(pgLocks.locktype, "advisory"),
        sql`${pgLocks.pid} = pg_backend_pid()`,
      ),
    );

  return [...new Set(rows.map((row) => row.key))].sort();
};

describe("anonymization write-cap helpers", () => {
  test("workspace term load returns the workspace's whole set, org-wide terms excluded", async () => {
    const canonicals = await runRolledBack(async (tx) => {
      const { organizationId, workspaceId } = await seedScope(tx);
      await insertTerms(tx, {
        organizationId,
        workspaceId,
        count: 3,
        prefix: "Workspace Term",
      });
      await insertTerms(tx, {
        organizationId,
        workspaceId: null,
        count: 2,
        prefix: "Firm Term",
      });

      const rows = await loadWorkspaceAnonymizationTermsForWrite(
        tx,
        workspaceId,
      );
      return rows.map((row) => row.canonical).sort();
    });

    expect(canonicals).toEqual([
      "Workspace Term 0000",
      "Workspace Term 0001",
      "Workspace Term 0002",
    ]);
  });

  test("org-wide term load returns the firm catalog, workspace terms excluded", async () => {
    const canonicals = await runRolledBack(async (tx) => {
      const { organizationId, workspaceId } = await seedScope(tx);
      await insertTerms(tx, {
        organizationId,
        workspaceId,
        count: 2,
        prefix: "Workspace Term",
      });
      await insertTerms(tx, {
        organizationId,
        workspaceId: null,
        count: 2,
        prefix: "Firm Term",
      });

      const rows = await loadOrganizationAnonymizationTermsForWrite(
        tx,
        organizationId,
      );
      return rows.map((row) => row.canonical).sort();
    });

    expect(canonicals).toEqual(["Firm Term 0000", "Firm Term 0001"]);
  });

  test("a set left over its cap is still readable, so the replace can converge it", async () => {
    // The replacement handler is the only API path that deletes these rows,
    // and it has to see a row to delete it. Panicking at the cap would make
    // the one set that needs repairing the one set nobody can repair.
    const rows = await runRolledBack(async (tx) => {
      const { organizationId, workspaceId } = await seedScope(tx);
      await insertTerms(tx, {
        organizationId,
        workspaceId,
        count: LIMITS.anonymizationBlacklistEntriesPerWorkspace + 1,
        prefix: "Workspace Term",
      });

      return await loadWorkspaceAnonymizationTermsForWrite(tx, workspaceId);
    });

    expect(rows).toHaveLength(
      LIMITS.anonymizationBlacklistEntriesPerWorkspace + 1,
    );
  });

  test("workspace term load fails closed past the recovery headroom", async () => {
    const thrown = await runRolledBack(async (tx) => {
      const { organizationId, workspaceId } = await seedScope(tx);
      await insertTerms(tx, {
        organizationId,
        workspaceId,
        count: LIMITS.anonymizationBlacklistEntriesPerWorkspace * 2 + 1,
        prefix: "Workspace Term",
      });

      try {
        await loadWorkspaceAnonymizationTermsForWrite(tx, workspaceId);
      } catch (error) {
        return error;
      }
      return null;
    });

    // Twice the cap is the union of two capped sets, the worst the pre-lock
    // race could commit. Past that no sequence of serialized replacements
    // explains the set, so a truncated read would be the greater danger: it
    // would let the next create see room that is not there.
    expect(Panic.is(thrown)).toBe(true);
    if (!Panic.is(thrown)) {
      return;
    }
    expect(thrown.cause).toEqual({
      invariant:
        "LIMITS.anonymizationBlacklistEntriesPerWorkspace, enforced by this read's callers, doubled so a set left over the cap by the pre-lock replacement race stays repairable",
      table: "anonymization_blacklist_entries",
      max: LIMITS.anonymizationBlacklistEntriesPerWorkspace * 2,
      observed: LIMITS.anonymizationBlacklistEntriesPerWorkspace * 2 + 1,
    });
  });

  test("allowlist count covers every row carrying the workspace id, org-wide rows excluded", async () => {
    const counted = await runRolledBack(async (tx) => {
      const { organizationId, workspaceId } = await seedScope(tx);
      await tx.insert(anonymizationAllowlistEntries).values([
        {
          id: createSafeId<"anonymizationAllowlistEntry">(),
          organizationId,
          workspaceId,
          label: "person",
          canonical: "Kept One",
        },
        {
          id: createSafeId<"anonymizationAllowlistEntry">(),
          organizationId,
          workspaceId,
          label: "person",
          canonical: "Kept Two",
        },
        {
          id: createSafeId<"anonymizationAllowlistEntry">(),
          organizationId,
          workspaceId: null,
          label: "person",
          canonical: "Firm Wide",
        },
      ]);

      return await countWorkspaceAnonymizationAllowlistForWrite(
        tx,
        workspaceId,
      );
    });

    expect(counted).toBe(2);
  });

  test("the cap decision is made while holding the scope's advisory lock", async () => {
    const { beforeRead, afterRead } = await runRolledBack(async (tx) => {
      const { workspaceId } = await seedScope(tx);

      const held = await heldAdvisoryLockKeys(tx);
      await loadWorkspaceAnonymizationTermsForWrite(tx, workspaceId);
      const heldAfter = await heldAdvisoryLockKeys(tx);

      return { beforeRead: held, afterRead: heldAfter };
    });

    expect(beforeRead).toEqual([]);
    expect(afterRead).toHaveLength(1);
  });

  test("both writers of one workspace's sets contend for the same lock", async () => {
    const keys = await runRolledBack(async (tx) => {
      const { workspaceId } = await seedScope(tx);

      await loadWorkspaceAnonymizationTermsForWrite(tx, workspaceId);
      await countWorkspaceAnonymizationAllowlistForWrite(tx, workspaceId);

      return await heldAdvisoryLockKeys(tx);
    });

    // One key, so a blacklist create and an allowlist create on the
    // same workspace serialize against each other rather than racing.
    expect(keys).toHaveLength(1);
  });

  test("two workspaces take two locks, so unrelated writes do not serialize", async () => {
    // A constant lock key would pass every same-workspace test above while
    // queueing every workspace's anonymization writes behind every other's.
    // The scope has to be in the key, and this is what says so.
    const keys = await runRolledBack(async (tx) => {
      const { workspaceId } = await seedScope(tx);
      const other = await seedScope(tx);

      await loadWorkspaceAnonymizationTermsForWrite(tx, workspaceId);
      await loadWorkspaceAnonymizationTermsForWrite(tx, other.workspaceId);

      return await heldAdvisoryLockKeys(tx);
    });

    expect(keys).toHaveLength(2);
  });

  test("the org-wide replace takes a lock of its own", async () => {
    const keys = await runRolledBack(async (tx) => {
      const { organizationId, workspaceId } = await seedScope(tx);

      await loadWorkspaceAnonymizationTermsForWrite(tx, workspaceId);
      await loadOrganizationAnonymizationTermsForWrite(tx, organizationId);

      return await heldAdvisoryLockKeys(tx);
    });

    // Firm-wide edits must not queue behind every workspace's edits.
    expect(keys).toHaveLength(2);
  });
});
