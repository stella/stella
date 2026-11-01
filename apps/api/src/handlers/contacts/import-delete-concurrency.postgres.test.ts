import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import { contacts } from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { withOwnerOrganizationScope } from "@/api/lib/db/owner-organization-scope";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { insertOwnerContacts } from "@/api/tests/helpers/owner-contacts";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

import { lockContactCapacity } from "./contact-capacity";
import { deleteContactHandler } from "./delete";
import { importContactRows } from "./import-contacts";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!runPostgresTests || databaseUrl === undefined) {
  describe.skip("contact import and deletion ordering", () => {
    test("requires the migrated PostgreSQL test profile", () => {
      expect(runPostgresTests && databaseUrl !== undefined).toBe(false);
    });
  });
} else {
  test("external contact imports write each normalized change once", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      try {
        await db.insert(organization).values({
          id: organizationId,
          name: "Contact import",
          slug: organizationId,
          createdAt: new Date(),
        });
        await db.insert(user).values({
          id: userId,
          name: "Import operator",
          email: `${userId}@example.test`,
          emailVerified: true,
        });
        const safeDb = createSafeDb(
          markRlsDatabase(db),
          [],
          organizationId,
          null,
        );
        const auditActions: string[] = [];
        const run = async (displayName: string) => {
          const result = await importContactRows({
            safeDb,
            organizationId,
            userId,
            recordAuditEvent: async (_tx, events) => {
              const batch = Array.isArray(events) ? events : [events];
              auditActions.push(...batch.map(({ action }) => action));
            },
            body: {
              importRequestId: createSafeId<"contactImportRequest">(),
              taxIdScheme: "none",
              rows: [
                {
                  id: createSafeId<"contact">(),
                  type: "person",
                  displayName,
                  external: { source: "address-book", id: "contact-1" },
                },
              ],
            },
          });
          if (result.isErr() || result.value.status === "conflict") {
            return panic("Contact import failed", { cause: result });
          }
          return result.value.result.results;
        };
        const stored = async () =>
          await withOwnerOrganizationScope(
            db,
            organizationId,
            async (scoped) =>
              await scoped
                .select()
                .from(contacts)
                .where(eq(contacts.organizationId, organizationId)),
          );
        expect(
          (await run("Imported contact")).map(({ status }) => status),
        ).toEqual(["created"]);
        const original = await stored();
        expect(auditActions).toHaveLength(1);
        expect(
          (await run("Imported contact")).map(({ status }) => status),
        ).toEqual(["unchanged"]);
        expect(await stored()).toEqual(original);
        expect(auditActions).toHaveLength(1);
        expect(
          (await run("Updated imported contact")).map(({ status }) => status),
        ).toEqual(["updated"]);
        const updated = await stored();
        expect(auditActions).toHaveLength(2);
        expect(updated).toHaveLength(1);
        expect(updated.at(0)?.externalChangeKey).not.toBe(
          original.at(0)?.externalChangeKey,
        );
        expect(
          (await run("Updated imported contact")).map(({ status }) => status),
        ).toEqual(["unchanged"]);
        expect(await stored()).toEqual(updated);
        expect(auditActions).toHaveLength(2);
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  });

  test("deletion waits for an import writer before removing its contact", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const setup = openClient();
      const importing = openClient();
      const deleting = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const contactId = createSafeId<"contact">();
      const releaseImport = Promise.withResolvers<undefined>();
      const importReady = Promise.withResolvers<number>();
      const pending: Promise<unknown>[] = [];
      try {
        await setup.db.insert(organization).values({
          id: organizationId,
          name: "Contact import ordering",
          slug: organizationId,
          createdAt: new Date(),
        });
        await insertOwnerContacts(setup.db, [
          {
            id: contactId,
            organizationId,
            type: "person",
            displayName: "Jana Nováková",
            externalSource: "address-book",
            externalId: "person-1",
            externalChangeKey: "initial",
            importedAt: new Date("2026-10-14T10:00:00Z"),
          },
        ]);
        const waitingPid =
          (
            await deleting.sql<
              { pid: number }[]
            >`SELECT pg_backend_pid() AS pid`
          ).at(0)?.pid ?? panic("Deletion backend PID is missing");
        const importTransaction = importing.db.transaction(async (tx) => {
          await lockContactCapacity(tx, organizationId);
          const session = await tx.execute<{ pid: number }>(
            sql`SELECT pg_backend_pid() AS pid`,
          );
          importReady.resolve(
            session.at(0)?.pid ?? panic("Import backend PID is missing"),
          );
          // No contact row is locked: deletion must join the shared writer fence.
          await releaseImport.promise;
        });
        pending.push(importTransaction);
        const holdingPid = await Promise.race([
          importReady.promise,
          importTransaction.then(() =>
            panic("Import fence ended before its barrier"),
          ),
        ]);
        const deletion = Result.gen(() =>
          deleteContactHandler({
            safeDb: createSafeDb(
              markRlsDatabase(deleting.db),
              [],
              organizationId,
              null,
            ),
            organizationId,
            contactId,
            recordAuditEvent: auditRecorderDouble(),
          }),
        );
        pending.push(deletion);
        await waitForBlockedPid(setup.sql, { waitingPid, holdingPid });
        releaseImport.resolve(undefined);
        await importTransaction;
        const outcome = await deletion;
        expect(outcome.isOk()).toBe(true);
        expect(
          await withOwnerOrganizationScope(
            setup.db,
            organizationId,
            async (scoped) =>
              await scoped
                .select({ id: contacts.id })
                .from(contacts)
                .where(eq(contacts.id, contactId)),
          ),
        ).toEqual([]);
      } finally {
        releaseImport.resolve(undefined);
        await Promise.allSettled(pending);
        await setup.db
          .delete(organization)
          .where(eq(organization.id, organizationId));
      }
    });
  });
}
