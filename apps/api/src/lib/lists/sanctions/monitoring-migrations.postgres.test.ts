import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";
import { readFileSync } from "node:fs";

import type { Transaction } from "@/api/db/root";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const OWNER = "monitoring_migrations_owner";
const ORG_A = "monitoring-migrations-a";
const ORG_B = "monitoring-migrations-b";
const CONTACT_A = "f1539c42-16e2-4a99-a989-c8caf725a111";
const CONTACT_B = "f1539c42-16e2-4a99-a989-c8caf725b111";
const EDITION = "f1539c42-16e2-4a99-a989-c8caf725e111";
const EVENT_A = "f1539c42-16e2-4a99-a989-c8caf725a222";
const EVENT_B = "f1539c42-16e2-4a99-a989-c8caf725b222";
const SOURCE = "eu";

const MONITORING_TABLES = [
  "sanctions_contact_screenings",
  "sanctions_contact_matches",
  "sanctions_screening_events",
] as const;

const applyMigration = async (tx: Transaction, directory: string) => {
  const migration = readFileSync(
    new URL(`../../../../drizzle/${directory}/migration.sql`, import.meta.url),
    "utf-8",
  );
  await tx.execute(
    sql.raw(migration.replaceAll("--> statement-breakpoint", "\n")),
  );
};

// Replaying the committed DDL makes this independent of schema-generated test
// policies. The transaction restores the original migrated database on exit.
const withCommittedMonitoring = async (
  url: string,
  operation: (tx: Transaction) => Promise<void>,
) => {
  await withGatedTestClients(url, async ({ openClient }) => {
    try {
      await openClient().db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
        await tx.execute(
          sql`DROP TRIGGER IF EXISTS sanctions_new_source_fanout ON public.sanctions_sources`,
        );
        await tx.execute(
          sql`DROP TRIGGER IF EXISTS sanctions_active_edition_fanout ON public.sanctions_sources`,
        );
        await tx.execute(
          sql`DROP TRIGGER IF EXISTS contacts_sanctions_mark_insert ON public.contacts`,
        );
        await tx.execute(
          sql`DROP TRIGGER IF EXISTS contacts_sanctions_mark_update ON public.contacts`,
        );
        await tx.execute(
          sql`DROP TRIGGER IF EXISTS organization_sanctions_mark_insert ON public.organization_settings`,
        );
        await tx.execute(
          sql`DROP TRIGGER IF EXISTS organization_sanctions_mark_update ON public.organization_settings`,
        );
        await tx.execute(
          sql`DROP FUNCTION IF EXISTS public.enqueue_sanctions_edition_fanout(), public.mark_sanctions_contact_insert(), public.mark_sanctions_contact_update(), public.mark_sanctions_organization_insert(), public.mark_sanctions_organization_update()`,
        );
        await tx.execute(
          sql`DROP TABLE public.sanctions_edition_fanouts, public.sanctions_monitoring_backfills, public.sanctions_contact_marks, public.sanctions_organization_marks, public.sanctions_screening_events, public.sanctions_contact_matches, public.sanctions_contact_screenings`,
        );
        await tx.execute(
          sql`ALTER TABLE public.contacts DROP COLUMN sanctions_monitoring_mode, DROP CONSTRAINT contacts_org_id_unique`,
        );
        await tx.execute(
          sql`ALTER TABLE public.organization_settings DROP COLUMN sanctions_monitoring_mode`,
        );
        // The prior committed concurrent-index migration supplies this prerequisite;
        // concurrent index construction cannot participate in a rollback fixture.
        await tx.execute(
          sql`CREATE UNIQUE INDEX contacts_org_id_unique ON public.contacts (organization_id, id)`,
        );
        await applyMigration(tx, "20261003122800_sanctions_monitoring");
        await tx.execute(
          sql.raw(`CREATE ROLE ${OWNER} NOLOGIN NOSUPERUSER NOBYPASSRLS`),
        );
        await tx.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO ${OWNER}`));
        for (const table of MONITORING_TABLES) {
          await tx.execute(
            sql.raw(`ALTER TABLE public.${table} OWNER TO ${OWNER}`),
          );
        }
        await tx.execute(
          sql`INSERT INTO public.organization (id, name, slug, created_at) VALUES (${ORG_A}, 'Monitoring A', ${ORG_A}, now()), (${ORG_B}, 'Monitoring B', ${ORG_B}, now())`,
        );
        await tx.execute(
          sql`INSERT INTO public.contacts (id, organization_id, type, display_name) VALUES (${CONTACT_A}, ${ORG_A}, 'person', 'Jan Novák'), (${CONTACT_B}, ${ORG_B}, 'person', 'Ján Novák')`,
        );
        await tx.execute(
          sql`INSERT INTO public.sanctions_sources (id, issuer, marker_url) VALUES (${SOURCE}, 'EU', 'https://example.test/list') ON CONFLICT DO NOTHING`,
        );
        await tx.execute(
          sql`INSERT INTO public.sanctions_editions (id, source_id, marker_key, published_at, content_hash, entry_count, state) VALUES (${EDITION}, ${SOURCE}, ${"a".repeat(64)}, '2026-10-02', ${"b".repeat(64)}, 1, 'ready')`,
        );
        await operation(tx);
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) {
        throw error;
      }
    }
  });
};

const failureMessages = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return `${error.message} ${"cause" in error ? failureMessages(error.cause) : ""}`;
};

type RejectedStatementOptions = {
  tx: Transaction;
  statement: ReturnType<typeof sql>;
  message: string;
};

const expectRejectedStatement = async ({
  tx,
  statement,
  message,
}: RejectedStatementOptions) => {
  const result = await Result.tryPromise(async () => {
    await tx.transaction(async (savepoint) => {
      await savepoint.execute(statement);
    });
  });
  if (result.isOk()) {
    panic("Expected statement rejection");
  }
  expect(failureMessages(result.error)).toContain(message);
};

type InsertRowOptions = {
  table: (typeof MONITORING_TABLES)[number];
  organization: string;
  contact: string;
  entry: string;
  event: string;
};

const insertRow = ({
  table,
  organization,
  contact,
  entry,
  event,
}: InsertRowOptions) => {
  switch (table) {
    case "sanctions_contact_screenings":
      return sql`INSERT INTO public.sanctions_contact_screenings (organization_id, contact_id, source_id, edition_id, status, contact_fingerprint, checked_at) VALUES (${organization}, ${contact}, ${SOURCE}, ${EDITION}, 'clear', 'fingerprint', now()) RETURNING *`;
    case "sanctions_contact_matches":
      return sql`INSERT INTO public.sanctions_contact_matches (organization_id, contact_id, source_id, source_entry_id, edition_id, state, contact_fingerprint, entry_hash, match, updated_at) VALUES (${organization}, ${contact}, ${SOURCE}, ${entry}, ${EDITION}, 'active', 'fingerprint', 'entry-hash', '{"name":"Jan Novák"}', now()) RETURNING *`;
    case "sanctions_screening_events":
      return sql`INSERT INTO public.sanctions_screening_events (id, organization_id, contact_id, source_id, source_entry_id, type, new_edition_id, reason, new_match, created_at) VALUES (${event}, ${organization}, ${contact}, ${SOURCE}, ${entry}, 'new', ${EDITION}, 'new-match', '{"name":"Jan Novák"}', now()) RETURNING *`;
    default: {
      const exhaustive: never = table;
      return exhaustive;
    }
  }
};

const assertForcedRls = async (tx: Transaction, tables: readonly string[]) => {
  const rows = await tx.execute<{
    name: string;
    enabled: boolean;
    forced: boolean;
  }>(sql`
    SELECT relname AS name, relrowsecurity AS enabled, relforcerowsecurity AS forced
    FROM pg_class JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
    WHERE pg_namespace.nspname = 'public' AND relname IN (${sql.join(
      tables.map((table) => sql`${table}`),
      sql`, `,
    )})
    ORDER BY relname
  `);
  expect(rows).toEqual(
    tables.toSorted().map((name) => ({ name, enabled: true, forced: true })),
  );
};

const asApplication = async (tx: Transaction) => {
  await tx.execute(sql`SET LOCAL ROLE stella`);
  await tx.execute(
    sql`SELECT set_config('app.organization_id', ${ORG_A}, true)`,
  );
  const identity = await tx.execute<{
    role: string;
    superuser: boolean;
    bypass: boolean;
  }>(
    sql`SELECT current_user AS role, rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
  );
  expect(identity).toEqual([
    { role: "stella", superuser: false, bypass: false },
  ]);
};

const asOwner = async (tx: Transaction) => {
  await tx.execute(sql.raw(`SET LOCAL ROLE ${OWNER}`));
  await tx.execute(sql`SELECT set_config('app.organization_id', '', true)`);
  const identity = await tx.execute<{
    role: string;
    superuser: boolean;
    bypass: boolean;
  }>(
    sql`SELECT current_user AS role, rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
  );
  expect(identity).toEqual([{ role: OWNER, superuser: false, bypass: false }]);
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("committed monitoring migrations on PostgreSQL", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  test("committed monitoring migrations isolate every operation on all three tables", async () => {
    await withCommittedMonitoring(databaseUrl, async (tx) => {
      await assertForcedRls(tx, MONITORING_TABLES);
      for (const table of MONITORING_TABLES) {
        await tx.execute(
          insertRow({
            table,
            organization: ORG_B,
            contact: CONTACT_B,
            entry: "b",
            event: EVENT_B,
          }),
        );
      }
      await asApplication(tx);
      for (const table of MONITORING_TABLES) {
        const relation = sql.identifier(table);
        expect(
          await tx.execute(
            sql`SELECT * FROM ${relation} WHERE organization_id = ${ORG_B}`,
          ),
        ).toEqual([]);
        expect(
          await tx.execute(
            sql`UPDATE ${relation} SET contact_id = contact_id WHERE organization_id = ${ORG_B} RETURNING *`,
          ),
        ).toEqual([]);
        expect(
          await tx.execute(
            sql`DELETE FROM ${relation} WHERE organization_id = ${ORG_B} RETURNING *`,
          ),
        ).toEqual([]);
        await expectRejectedStatement({
          tx,
          statement: insertRow({
            table,
            organization: ORG_B,
            contact: CONTACT_B,
            entry: "denied",
            event: EVENT_A,
          }),
          message: "row-level security",
        });
        await expectRejectedStatement({
          tx,
          statement: insertRow({
            table,
            organization: ORG_A,
            contact: CONTACT_B,
            entry: "mismatched",
            event: EVENT_A,
          }),
          message: "foreign key constraint",
        });
        expect(
          await tx.execute(
            insertRow({
              table,
              organization: ORG_A,
              contact: CONTACT_A,
              entry: "a",
              event: EVENT_A,
            }),
          ),
        ).toHaveLength(1);
        expect(await tx.execute(sql`SELECT * FROM ${relation}`)).toHaveLength(
          1,
        );
        if (table !== "sanctions_screening_events") {
          expect(
            await tx.execute(
              sql`UPDATE ${relation} SET contact_fingerprint = 'updated' WHERE organization_id = ${ORG_A} RETURNING *`,
            ),
          ).toHaveLength(1);
          expect(
            await tx.execute(
              sql`DELETE FROM ${relation} WHERE organization_id = ${ORG_A} RETURNING *`,
            ),
          ).toHaveLength(1);
        }
      }
      await asOwner(tx);
      for (const table of MONITORING_TABLES) {
        const relation = sql.identifier(table);
        expect(
          await tx.execute(
            sql`SELECT * FROM ${relation} WHERE organization_id = ${ORG_B}`,
          ),
        ).toHaveLength(1);
        if (table !== "sanctions_screening_events") {
          expect(
            await tx.execute(
              insertRow({
                table,
                organization: ORG_A,
                contact: CONTACT_A,
                entry: "owner",
                event: EVENT_A,
              }),
            ),
          ).toHaveLength(1);
          expect(
            await tx.execute(
              sql`UPDATE ${relation} SET contact_fingerprint = 'owner' WHERE organization_id = ${ORG_B} RETURNING *`,
            ),
          ).toHaveLength(1);
          expect(
            await tx.execute(
              sql`DELETE FROM ${relation} WHERE organization_id = ${ORG_B} RETURNING *`,
            ),
          ).toHaveLength(1);
        }
      }
    });
  }, 120_000);

  test("committed orchestration tables isolate tenant CRUD on PostgreSQL", async () => {
    await withCommittedMonitoring(databaseUrl, async (tx) => {
      await applyMigration(tx, "20261003122900_sanctions_monitoring_marks");
      await applyMigration(tx, "20261003123000_sanctions_monitoring_backfills");
      const tables = [
        "sanctions_contact_marks",
        "sanctions_organization_marks",
        "sanctions_monitoring_backfills",
      ] as const;
      await assertForcedRls(tx, [...tables, "sanctions_edition_fanouts"]);
      for (const table of tables) {
        await tx.execute(
          sql.raw(`ALTER TABLE public.${table} OWNER TO ${OWNER}`),
        );
      }
      type RowOptions = {
        table: (typeof tables)[number];
        organization: string;
        contact: string;
      };
      const rowFor = ({ table, organization, contact }: RowOptions) => {
        switch (table) {
          case "sanctions_contact_marks":
            return sql`INSERT INTO public.sanctions_contact_marks (organization_id, contact_id) VALUES (${organization}, ${contact}) RETURNING *`;
          case "sanctions_organization_marks":
            return sql`INSERT INTO public.sanctions_organization_marks (organization_id) VALUES (${organization}) RETURNING *`;
          case "sanctions_monitoring_backfills":
            return sql`INSERT INTO public.sanctions_monitoring_backfills (organization_id, source_id, edition_id) VALUES (${organization}, ${SOURCE}, ${EDITION}) RETURNING *`;
          default: {
            const exhaustive: never = table;
            return exhaustive;
          }
        }
      };
      for (const table of tables) {
        await tx.execute(
          rowFor({ table, organization: ORG_B, contact: CONTACT_B }),
        );
      }
      await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
      await tx.execute(
        sql`INSERT INTO public.sanctions_edition_fanouts (source_id, edition_id) VALUES (${SOURCE}, ${EDITION}) ON CONFLICT (source_id) DO UPDATE SET edition_id = excluded.edition_id`,
      );
      await tx.execute(sql`RESET ROLE`);
      await asApplication(tx);
      for (const table of tables) {
        const relation = sql.identifier(table);
        expect(
          await tx.execute(
            sql`SELECT * FROM ${relation} WHERE organization_id = ${ORG_B}`,
          ),
        ).toEqual([]);
        expect(
          await tx.execute(
            sql`UPDATE ${relation} SET generation = generation + 1 WHERE organization_id = ${ORG_B} RETURNING *`,
          ),
        ).toEqual([]);
        expect(
          await tx.execute(
            sql`DELETE FROM ${relation} WHERE organization_id = ${ORG_B} RETURNING *`,
          ),
        ).toEqual([]);
        await expectRejectedStatement({
          tx,
          statement: rowFor({
            table,
            organization: ORG_B,
            contact: CONTACT_B,
          }),
          message: "row-level security",
        });
        expect(
          await tx.execute(
            rowFor({ table, organization: ORG_A, contact: CONTACT_A }),
          ),
        ).toHaveLength(1);
        // The worker's explicit organization predicate and direct role-level read agree.
        expect(
          await tx.execute(
            sql`SELECT organization_id FROM ${relation} WHERE organization_id = ${ORG_A}`,
          ),
        ).toEqual([{ organization_id: ORG_A }]);
        expect(
          await tx.execute(sql`SELECT organization_id FROM ${relation}`),
        ).toEqual([{ organization_id: ORG_A }]);
        await expectRejectedStatement({
          tx,
          statement: sql`UPDATE ${relation} SET organization_id = ${ORG_B} WHERE organization_id = ${ORG_A}`,
          message: "row-level security",
        });
        expect(
          await tx.execute(
            sql`UPDATE ${relation} SET generation = generation + 1 WHERE organization_id = ${ORG_A} RETURNING generation::text AS generation`,
          ),
        ).toEqual([{ generation: "2" }]);
        expect(
          await tx.execute(
            sql`DELETE FROM ${relation} WHERE organization_id = ${ORG_A} RETURNING *`,
          ),
        ).toHaveLength(1);
      }
      await expectRejectedStatement({
        tx,
        statement: rowFor({
          table: "sanctions_contact_marks",
          organization: ORG_A,
          contact: CONTACT_B,
        }),
        message: "foreign key constraint",
      });
      await expectRejectedStatement({
        tx,
        statement: sql`INSERT INTO public.sanctions_edition_fanouts (source_id) VALUES (${SOURCE})`,
        message: "permission denied",
      });
      await expectRejectedStatement({
        tx,
        statement: sql`UPDATE public.sanctions_edition_fanouts SET state = 'complete' WHERE source_id = ${SOURCE}`,
        message: "permission denied",
      });
      await expectRejectedStatement({
        tx,
        statement: sql`DELETE FROM public.sanctions_edition_fanouts WHERE source_id = ${SOURCE}`,
        message: "permission denied",
      });
      expect(
        await tx.execute(
          sql`SELECT source_id FROM public.sanctions_edition_fanouts WHERE source_id = ${SOURCE}`,
        ),
      ).toEqual([{ source_id: SOURCE }]);
      await asOwner(tx);
      for (const table of tables) {
        const relation = sql.identifier(table);
        expect(
          await tx.execute(
            sql`SELECT organization_id FROM ${relation} WHERE organization_id = ${ORG_B}`,
          ),
        ).toEqual([{ organization_id: ORG_B }]);
        expect(
          await tx.execute(
            rowFor({ table, organization: ORG_A, contact: CONTACT_A }),
          ),
        ).toHaveLength(1);
        expect(
          await tx.execute(
            sql`UPDATE ${relation} SET generation = generation + 1 WHERE organization_id = ${ORG_B} RETURNING generation::text AS generation`,
          ),
        ).toEqual([{ generation: "2" }]);
        expect(
          await tx.execute(
            sql`DELETE FROM ${relation} WHERE organization_id = ${ORG_B} RETURNING *`,
          ),
        ).toHaveLength(1);
      }
    });
  }, 120_000);

  test("screening history cannot be changed or deleted by the application role", async () => {
    await withCommittedMonitoring(databaseUrl, async (tx) => {
      await asApplication(tx);
      const statement = insertRow({
        table: "sanctions_screening_events",
        organization: ORG_A,
        contact: CONTACT_A,
        entry: "history",
        event: EVENT_A,
      });
      const before = await tx.execute(statement);
      expect(before).toHaveLength(1);
      expect(
        await tx.execute(
          sql`UPDATE public.sanctions_screening_events SET old_match = '{"name":"Changed"}', new_match = '{"name":"Changed"}', reason = 'edited', type = 'changed' WHERE id = ${EVENT_A} RETURNING *`,
        ),
      ).toEqual([]);
      expect(
        await tx.execute(
          sql`DELETE FROM public.sanctions_screening_events WHERE id = ${EVENT_A} RETURNING *`,
        ),
      ).toEqual([]);
      expect(
        await tx.execute(
          sql`SELECT * FROM public.sanctions_screening_events WHERE id = ${EVENT_A}`,
        ),
      ).toEqual(before);
      await asOwner(tx);
      expect(
        await tx.execute(
          insertRow({
            table: "sanctions_screening_events",
            organization: ORG_B,
            contact: CONTACT_B,
            entry: "owner-history",
            event: EVENT_B,
          }),
        ),
      ).toHaveLength(1);
      expect(
        await tx.execute(
          sql`SELECT * FROM public.sanctions_screening_events WHERE id = ${EVENT_A}`,
        ),
      ).toEqual(before);
      expect(
        await tx.execute(
          sql`UPDATE public.sanctions_screening_events SET reason = 'owner-edit' WHERE id = ${EVENT_A} RETURNING *`,
        ),
      ).toEqual([]);
      expect(
        await tx.execute(
          sql`DELETE FROM public.sanctions_screening_events WHERE id = ${EVENT_A} RETURNING *`,
        ),
      ).toEqual([]);
      expect(
        await tx.execute(
          sql`SELECT * FROM public.sanctions_screening_events WHERE id = ${EVENT_A}`,
        ),
      ).toEqual(before);
      // RESET returns to CI's administrative identity; this bypass is intentional
      // and is distinct from the forced-RLS, non-superuser owner checked above.
      await tx.execute(sql`RESET ROLE`);
      const administrator = await tx.execute<{ bypass: boolean }>(
        sql`SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
      );
      expect(administrator).toEqual([{ bypass: true }]);
      expect(
        await tx.execute(
          sql`UPDATE public.sanctions_screening_events SET reason = 'administrative' WHERE id = ${EVENT_A} RETURNING *`,
        ),
      ).toHaveLength(1);
      expect(
        await tx.execute(
          sql`DELETE FROM public.sanctions_screening_events WHERE id = ${EVENT_A} RETURNING *`,
        ),
      ).toHaveLength(1);
    });
  }, 120_000);
}
