import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

import { CLIENT_INVOICE_BACKFILL } from "./client-invoice-backfill";
import type { OnlineMigrationConnection } from "./online-migration-connection";

// A pre-migration database has neither invoice client values nor the new guard.
// Install the shipped guard after seeding legacy rows so the repair must obey it.
test("invoice client backfill resumes committed batches and reaches a fixed point", async () => {
  const database = new PGlite();
  await database.exec(`CREATE TABLE workspaces(id uuid PRIMARY KEY,organization_id text NOT NULL,client_id uuid);
 CREATE TABLE invoices(id uuid PRIMARY KEY,organization_id text NOT NULL,workspace_id uuid,client_id uuid,original_invoice_id uuid);
 CREATE TABLE invoice_lines(id uuid,invoice_id uuid,workspace_id uuid,organization_id text);
 INSERT INTO workspaces VALUES ('00000000-0000-0000-0000-000000000001','firm','00000000-0000-0000-0000-000000000010');
 INSERT INTO invoices(id,organization_id,workspace_id)
 SELECT ('00000000-0000-0000-0001-'||lpad(n::text,12,'0'))::uuid,'firm','00000000-0000-0000-0000-000000000001' FROM generate_series(1,501) n;
 INSERT INTO invoices VALUES ('00000000-0000-0000-0000-000000000002','firm','00000000-0000-0000-0000-000000000001',NULL,'00000000-0000-0000-0001-000000000001');`);
  const migration = await Bun.file(
    new URL(
      "../../drizzle/20261015140000_client_invoices/migration.sql",
      import.meta.url,
    ),
  ).text();
  const guard = migration
    .split("--> statement-breakpoint")
    .find((statement) =>
      statement.includes(
        "CREATE FUNCTION public.stella_invoice_client_guard()",
      ),
    );
  expect(guard).toBeDefined();
  if (!guard) {
    throw new TypeError("Shipped invoice guard missing");
  }
  await database.exec(guard);
  await database.exec(
    "CREATE TRIGGER invoices_client_guard BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION stella_invoice_client_guard()",
  );
  const connection = {
    execute: async (query, params = []) => {
      await database.query(query, [...params]);
    },
    query: async (query, params = []) =>
      (await database.query(query, [...params])).rows,
    release: () => {},
  } satisfies OnlineMigrationConnection;
  expect((await CLIENT_INVOICE_BACKFILL.readCompletion(connection)).type).toBe(
    "incomplete",
  );
  // Commit one bounded batch, as a deployment interrupted between batches would.
  await connection.query(`WITH batch AS (SELECT id FROM invoices WHERE original_invoice_id IS NULL ORDER BY id LIMIT 500)
 UPDATE invoices i SET client_id=w.client_id FROM workspaces w,batch WHERE i.id=batch.id AND i.workspace_id=w.id RETURNING i.id`);
  expect(
    (
      await database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM invoices WHERE client_id IS NULL",
      )
    ).rows,
  ).toEqual([{ count: 2 }]);
  await CLIENT_INVOICE_BACKFILL.repair(connection);
  expect((await CLIENT_INVOICE_BACKFILL.readCompletion(connection)).type).toBe(
    "complete",
  );
  const before = (await database.query("SELECT * FROM invoices ORDER BY id"))
    .rows;
  await CLIENT_INVOICE_BACKFILL.repair(connection);
  expect(
    (await database.query("SELECT * FROM invoices ORDER BY id")).rows,
  ).toEqual(before);
  expect(before).toHaveLength(502);
  await database.close();
});
