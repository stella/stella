import { expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { createContactVatIdRepair } from "./contact-vat-id-repair";
import { createUngatedTableGateForTests } from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";

const REPAIR = createContactVatIdRepair({
  sleep: async () => {},
  readVerdict: async () => ({
    kind: "normal",
    signals: [
      {
        indicator: "ebs_balance",
        kind: "normal",
        value: 90,
        threshold: 70,
        observedAt: "2026-10-24T12:00:00.000Z",
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

type ContactRow = { id: string; tax_id: string | null; vat_id: string | null };

const MIGRATION_PATH = new URL(
  "../../drizzle/20261031200838_contact_vat_id_check/migration.sql",
  import.meta.url,
);

/**
 * The database as the deploy finds it: contacts written before the check,
 * then the migration that adds it NOT VALID.
 */
const removeCheck = async (client: PgliteClient) => {
  await client.query(
    'ALTER TABLE contacts DROP CONSTRAINT IF EXISTS "contacts_vat_id_check"',
  );
};

const applyCheckMigration = async (client: PgliteClient) => {
  for (const statement of (await Bun.file(MIGRATION_PATH).text())
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)) {
    await client.query(statement);
  }
};

const checkValidated = async (client: PgliteClient) =>
  (
    await client.query<{ validated: boolean }>(
      "SELECT convalidated AS validated FROM pg_constraint WHERE conname = 'contacts_vat_id_check'",
    )
  ).rows.at(0)?.validated;

const readContacts = async (client: PgliteClient): Promise<ContactRow[]> =>
  (
    await client.query<ContactRow>(
      "SELECT id::text AS id, tax_id, vat_id FROM contacts ORDER BY id",
    )
  ).rows;

const insertContact = async (
  client: PgliteClient,
  { taxId, vatId }: { taxId: string | null; vatId: string | null },
) => {
  const id = createSafeId<"contact">();
  await client.query(
    `INSERT INTO contacts (id, organization_id, type, display_name, tax_id, vat_id)
     VALUES ($1, 'org-vat-repair', 'organization', 'Client', $2, $3)`,
    [id, taxId, vatId],
  );
  return id;
};

/** Moved: an EU VAT number in tax_id with no vat_id, as stored, spacing kept. */
const MOVABLE = ["DE298765432", "sk 2020 123 456", "ATU12345678"];
/** Kept: national numbers, register numbers, and rows that have a VAT ID. */
const KEPT = [
  { taxId: "2020123456", vatId: null },
  { taxId: "HRB123456", vatId: null },
  { taxId: "GB123456789", vatId: null },
  { taxId: "DE298765432", vatId: "DE111111111" },
  { taxId: null, vatId: "CZ12345678" },
  { taxId: null, vatId: null },
];
/** More movable rows than two batches, so the repair resumes across them. */
const BULK = 1203;

test("moves every EU VAT number from tax_id to vat_id without losing a row or a value, and converges", async () => {
  const client = await createTestPglite();
  const connection = connectionOver(client);
  await client.query(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ('org-vat-repair', 'Firm', 'firm-vat-repair', now())`,
  );
  await removeCheck(client);
  for (const taxId of MOVABLE) {
    await insertContact(client, { taxId, vatId: null });
  }
  for (const row of KEPT) {
    await insertContact(client, row);
  }
  await client.query(
    `INSERT INTO contacts (id, organization_id, type, display_name, tax_id)
     SELECT gen_random_uuid(), 'org-vat-repair', 'organization', 'Bulk ' || n,
            'CZ' || lpad(n::text, 8, '0')
       FROM generate_series(1, $1::int) AS n`,
    [BULK],
  );
  await applyCheckMigration(client);
  expect(await checkValidated(client)).toBe(false);
  const before = await readContacts(client);

  expect((await REPAIR.readCompletion(connection)).type).toBe("incomplete");
  expect(
    await REPAIR.repair(connection, createUngatedTableGateForTests(connection)),
  ).toEqual({ type: "complete" });
  expect((await REPAIR.readCompletion(connection)).type).toBe("complete");
  expect(await checkValidated(client)).toBe(true);

  const after = await readContacts(client);
  expect(after).toHaveLength(before.length);
  const afterById = new Map(after.map((row) => [row.id, row]));
  let moved = 0;
  for (const row of before) {
    const repaired = afterById.get(row.id);
    const movable =
      row.vat_id === null &&
      row.tax_id !== null &&
      (MOVABLE.includes(row.tax_id) || row.tax_id.startsWith("CZ"));
    if (movable) {
      moved += 1;
      expect(repaired).toEqual({
        id: row.id,
        tax_id: null,
        vat_id: row.tax_id,
      });
    } else {
      expect(repaired).toEqual(row);
    }
  }
  expect(moved).toBe(MOVABLE.length + BULK);

  // A second run is a no-op.
  expect(
    await REPAIR.repair(connection, createUngatedTableGateForTests(connection)),
  ).toEqual({ type: "complete" });
  expect(await readContacts(client)).toEqual(after);

  // The validated check refuses a new EU VAT number in tax_id without a
  // vat_id, so completion stays a catalog fact.
  expect(
    await insertContact(client, { taxId: "DE298765432", vatId: null }).then(
      () => "stored",
      () => "refused",
    ),
  ).toBe("refused");
  await insertContact(client, { taxId: "DE298765432", vatId: "DE298765432" });
  expect((await REPAIR.readCompletion(connection)).type).toBe("complete");
}, 120_000);
