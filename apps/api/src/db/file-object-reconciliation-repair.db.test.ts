import { expect, test } from "bun:test";

import { createTestPglite } from "@/api/tests/pglite-test-db";

import { createFileObjectReconciliationRepair } from "./file-object-reconciliation-repair";
import { createUngatedTableGateForTests } from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";

const REPAIR = createFileObjectReconciliationRepair({
  sleep: async () => {},
  log: () => {},
  readVerdict: async () => ({
    kind: "normal",
    signals: [
      {
        indicator: "ebs_balance",
        kind: "normal",
        value: 90,
        threshold: 70,
        observedAt: "2026-10-25T08:00:00.000Z",
        reason: "Injected health for repair semantics",
      },
    ],
  }),
});

type PgliteClient = Awaited<ReturnType<typeof createTestPglite>>;

const connectionOver = (client: PgliteClient): OnlineMigrationConnection => ({
  execute: async (query, params = []) => {
    await client.query(query, [...params]);
  },
  query: async (query, params = []) =>
    (await client.query(query, [...params])).rows,
  release: () => {},
});

const ORGANIZATION_ID = "org-file-reconciliation";
const CONSTRAINTS = [
  `"organization_file_objects_reconciliation_attempt_nonnegative" CHECK ("reconciliation_attempt_count" >= 0)`,
  `"organization_file_objects_reconciliation_state_domain" CHECK ("reconciliation_state" IN ('active', 'quarantined'))`,
  `"organization_file_objects_reconciliation_lifecycle" CHECK (("write_id" IS NULL AND "reconciliation_state" = 'active' AND "reconciliation_attempt_count" = 0 AND "reconcile_after" IS NULL) OR ("write_id" IS NOT NULL AND (("reconciliation_state" = 'active' AND "reconcile_after" IS NOT NULL) OR ("reconciliation_state" = 'quarantined' AND "reconcile_after" IS NULL))))`,
];
/** More unscheduled rows than two batches, so the repair resumes across them. */
const UNSCHEDULED = 1203;

type ObjectRow = {
  object_key: string;
  write_id: string | null;
  reconciliation_state: string;
  reconcile_after: string | null;
  updated_at: string;
};

const readObjects = async (client: PgliteClient): Promise<ObjectRow[]> =>
  (
    await client.query<ObjectRow>(
      `SELECT object_key, write_id, reconciliation_state,
              reconcile_after::text AS reconcile_after,
              updated_at::text AS updated_at
         FROM organization_file_objects ORDER BY object_key`,
    )
  ).rows;

test("schedules every unresolved write the migration found, validates the checks, and converges", async () => {
  const client = await createTestPglite();
  const connection = connectionOver(client);
  await client.query(
    "INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Firm', $1, now())",
    [ORGANIZATION_ID],
  );
  // The state migration 20261025090300 meets: write rows recorded before the
  // reconciliation columns, then the checks added NOT VALID.
  for (const constraint of CONSTRAINTS) {
    const name = constraint.slice(0, constraint.indexOf(" "));
    await client.query(
      `ALTER TABLE organization_file_objects DROP CONSTRAINT ${name}`,
    );
  }
  await client.query(
    "ALTER TABLE organization_file_objects DISABLE TRIGGER organization_file_objects_fill_reconciliation",
  );
  await client.query(
    `INSERT INTO organization_file_objects
       (organization_id, object_key, size_bytes, status, write_id,
        reservation_started_at, updated_at)
     SELECT $1, 'pending/' || lpad(n::text, 5, '0'), 0, 'reserved',
            'write-' || n, now(), '2026-10-01T00:00:00Z'::timestamptz + n * interval '1 second'
       FROM generate_series(1, $2::int) AS n`,
    [ORGANIZATION_ID, UNSCHEDULED],
  );
  await client.query(
    `INSERT INTO organization_file_objects
       (organization_id, object_key, size_bytes, status, updated_at)
     VALUES ($1, 'committed/kept', 1, 'committed', '2026-10-01T00:00:00Z')`,
    [ORGANIZATION_ID],
  );
  await client.query(
    "ALTER TABLE organization_file_objects ENABLE TRIGGER organization_file_objects_fill_reconciliation",
  );
  for (const constraint of CONSTRAINTS) {
    await client.query(
      `ALTER TABLE organization_file_objects ADD CONSTRAINT ${constraint} NOT VALID`,
    );
  }
  const before = await readObjects(client);

  expect((await REPAIR.readCompletion(connection)).type).toBe("incomplete");
  expect(
    await REPAIR.repair(connection, createUngatedTableGateForTests(connection)),
  ).toEqual({ type: "complete" });
  expect((await REPAIR.readCompletion(connection)).type).toBe("complete");

  const after = await readObjects(client);
  expect(after).toHaveLength(before.length);
  const afterByKey = new Map(after.map((row) => [row.object_key, row]));
  for (const row of before) {
    const repaired = afterByKey.get(row.object_key);
    if (row.write_id === null) {
      expect(repaired).toEqual(row);
      continue;
    }
    // Scheduled five minutes after its own last write; nothing else moves.
    expect(repaired).toEqual({
      ...row,
      reconcile_after: expect.any(String),
    });
    const scheduled = await client.query<{ matches: boolean }>(
      `SELECT reconcile_after = updated_at + interval '5 minutes' AS matches
         FROM organization_file_objects WHERE object_key = $1`,
      [row.object_key],
    );
    expect(scheduled.rows).toEqual([{ matches: true }]);
  }

  // A second run is a no-op.
  expect(
    await REPAIR.repair(connection, createUngatedTableGateForTests(connection)),
  ).toEqual({ type: "complete" });
  expect(await readObjects(client)).toEqual(after);
});
