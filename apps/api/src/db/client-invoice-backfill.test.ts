import { PGlite } from "@electric-sql/pglite";
import { Result } from "better-result";
import { expect, test } from "bun:test";

import { getPgErrorCode } from "@/api/lib/pg-error";

import {
  CLIENT_INVOICE_BACKFILL,
  CLIENT_INVOICE_TENANT_KEY,
} from "./client-invoice-backfill";
import {
  createUngatedTableGateForTests,
  INVOICE_TENANT_UNIQUE_INDEX,
} from "./online-ddl";
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
      "../../drizzle/20261026220000_client_invoices/migration.sql",
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

const tenantKeyConnection = (database: PGlite) =>
  ({
    execute: async (query, params = []) => {
      await database.query(query, [...params]);
    },
    query: async (query, params = []) =>
      (await database.query(query, [...params])).rows,
    release: () => {},
  }) satisfies OnlineMigrationConnection;

const seedTenantKeyTable = async (database: PGlite) => {
  await database.exec(
    `CREATE TABLE invoices(id uuid PRIMARY KEY, organization_id text NOT NULL, original_invoice_id uuid)`,
  );
};
const buildTenantIndex = async (database: PGlite) => {
  // PGlite runs one session; the index shape comes from the actual online declaration.
  await database.exec(
    INVOICE_TENANT_UNIQUE_INDEX.createSql.replace(" CONCURRENTLY", ""),
  );
};

test.each(["fresh", "unique attached"] as const)(
  "online tenant key installation resumes and enforces scope (%s)",
  async (stage) => {
    await using database = new PGlite();
    await seedTenantKeyTable(database);
    await buildTenantIndex(database);
    if (stage === "unique attached") {
      await database.exec(
        "ALTER TABLE invoices ADD CONSTRAINT invoices_id_org_unique UNIQUE USING INDEX invoices_id_org_unique",
      );
    }
    const connection = tenantKeyConnection(database);
    const tables = createUngatedTableGateForTests(connection);
    expect(
      (await CLIENT_INVOICE_TENANT_KEY.readCompletion(connection)).type,
    ).toBe("incomplete");
    const deferred = await CLIENT_INVOICE_TENANT_KEY.repair(connection, {
      run: async () => ({
        type: "deferred",
        step: "client-invoice-tenant-key",
        retryAfterMs: 1,
      }),
    });
    expect(deferred.type).toBe("deferred");
    expect(
      (await CLIENT_INVOICE_TENANT_KEY.readCompletion(connection)).type,
    ).toBe("incomplete");
    expect(
      (await CLIENT_INVOICE_TENANT_KEY.repair(connection, tables)).type,
    ).toBe("complete");
    expect(
      (await CLIENT_INVOICE_TENANT_KEY.readCompletion(connection)).type,
    ).toBe("complete");
    const readConstraints = async () =>
      (
        await database.query(
          `SELECT conname, contype, conkey::text, confkey::text, convalidated, conindid::text FROM pg_constraint WHERE conrelid='invoices'::regclass AND conname IN ('invoices_id_org_unique','invoices_original_organization_fk') ORDER BY conname`,
        )
      ).rows;
    const beforeReplay = await readConstraints();
    expect(beforeReplay).toHaveLength(2);
    expect(beforeReplay).toContainEqual(
      expect.objectContaining({
        conname: "invoices_original_organization_fk",
        convalidated: false,
      }),
    );
    expect(
      (await CLIENT_INVOICE_TENANT_KEY.repair(connection, tables)).type,
    ).toBe("complete");
    expect(await readConstraints()).toEqual(beforeReplay);
    await database.exec(
      `INSERT INTO invoices VALUES ('00000000-0000-4000-8000-000000000001','first',NULL),('00000000-0000-4000-8000-000000000002','first','00000000-0000-4000-8000-000000000001')`,
    );
    const refused = await Result.tryPromise(
      async () =>
        await database.exec(
          `INSERT INTO invoices VALUES ('00000000-0000-4000-8000-000000000003','other','00000000-0000-4000-8000-000000000001')`,
        ),
    );
    expect(refused.isErr()).toBe(true);
    if (refused.isErr()) {
      expect(getPgErrorCode(refused.error)).toBe("23503");
    }
    expect((await database.query("SELECT id FROM invoices")).rows).toHaveLength(
      2,
    );
  },
);

test.each([
  { name: "missing", sql: undefined },
  {
    name: "wrong columns",
    sql: "CREATE UNIQUE INDEX invoices_id_org_unique ON invoices (id)",
  },
  {
    name: "nonunique",
    sql: "CREATE INDEX invoices_id_org_unique ON invoices (id,organization_id)",
  },
  {
    name: "partial",
    sql: "CREATE UNIQUE INDEX invoices_id_org_unique ON invoices (id,organization_id) WHERE original_invoice_id IS NULL",
  },
])(
  "tenant key installation refuses an invalid index without adding constraints: %o",
  async ({ sql }) => {
    await using database = new PGlite();
    await seedTenantKeyTable(database);
    if (sql !== undefined) {
      await database.exec(sql);
    }
    const connection = tenantKeyConnection(database);
    for (const run of [
      async () => await CLIENT_INVOICE_TENANT_KEY.readCompletion(connection),
      async () =>
        await CLIENT_INVOICE_TENANT_KEY.repair(
          connection,
          createUngatedTableGateForTests(connection),
        ),
    ]) {
      const refused = await Result.tryPromise(async () => {
        await run();
      });
      expect(refused.isErr()).toBe(true);
      if (refused.isErr()) {
        expect(refused.error.message).toContain(
          "Invoice tenant key index is missing, stale or not ready",
        );
      }
    }
    expect(
      (
        await database.query(
          "SELECT conname FROM pg_constraint WHERE conrelid='invoices'::regclass AND conname IN ('invoices_id_org_unique','invoices_original_organization_fk')",
        )
      ).rows,
    ).toEqual([]);
  },
);

test("a same-named foreign key with another identity is refused before attachment", async () => {
  await using database = new PGlite();
  await seedTenantKeyTable(database);
  await buildTenantIndex(database);
  await database.exec(
    "ALTER TABLE invoices ADD CONSTRAINT invoices_original_organization_fk FOREIGN KEY (original_invoice_id) REFERENCES invoices(id) ON DELETE CASCADE NOT VALID",
  );
  const connection = tenantKeyConnection(database);
  const before = (
    await database.query(
      "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='invoices'::regclass ORDER BY conname",
    )
  ).rows;
  const refused = await Result.tryPromise(
    async () =>
      await CLIENT_INVOICE_TENANT_KEY.repair(
        connection,
        createUngatedTableGateForTests(connection),
      ),
  );
  expect(refused.isErr()).toBe(true);
  if (refused.isErr()) {
    expect(refused.error.message).toContain(
      "Invoice tenant constraints have an unexpected identity",
    );
  }
  expect(
    (
      await database.query(
        "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='invoices'::regclass ORDER BY conname",
      )
    ).rows,
  ).toEqual(before);
});
