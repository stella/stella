import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import { contacts } from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

import { lockContactCapacity } from "./contact-capacity";
import { deleteContactHandler } from "./delete";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!runPostgresTests || databaseUrl === undefined) {
  describe.skip("contact import and deletion ordering", () => {
    test("requires the migrated PostgreSQL test profile", () => {
      expect(runPostgresTests && databaseUrl !== undefined).toBe(false);
    });
  });
} else {
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
        await setup.db.insert(contacts).values({
          id: contactId,
          organizationId,
          type: "person",
          displayName: "Jana Nováková",
          externalSource: "address-book",
          externalId: "person-1",
          importedAt: new Date("2026-10-14T10:00:00Z"),
        });
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
          await setup.db
            .select({ id: contacts.id })
            .from(contacts)
            .where(eq(contacts.id, contactId)),
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
