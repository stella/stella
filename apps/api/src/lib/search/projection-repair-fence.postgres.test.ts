import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { withTimeout } from "@stll/concurrency/with-timeout";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  contacts,
  contactSearchDocuments,
  searchProjectionRepairQueue,
  workspaces,
  workspaceSearchDocuments,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  createSearchProjectionRepairDeps,
  drainSearchProjectionRepairQueue,
  enqueueContactSearchRepairs,
  enqueueWorkspaceSearchRepairs,
} from "@/api/lib/search/projection-repair-queue";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type RepairDatabase = Parameters<typeof createSearchProjectionRepairDeps>[0];

const pauseFirstTransaction = ({
  database,
  release,
  sourceRead,
}: {
  database: GatedTestDb;
  release: Promise<undefined>;
  sourceRead: () => void;
}): RepairDatabase => {
  let paused = false;
  return asTestRaw<RepairDatabase>({
    delete: database.delete.bind(database),
    query: database.query,
    select: database.select.bind(database),
    transaction: async <T>(run: (tx: Transaction) => Promise<T>) => {
      if (!paused) {
        paused = true;
        sourceRead();
        await release;
      }
      return await database.transaction(
        async (tx) => await run(asTestRaw<Transaction>(tx)),
      );
    },
    update: database.update.bind(database),
  });
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("projection repair publication fences (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () =>
      expect(true).toBe(true));
  });
} else {
  // timeout: Each case races two real PostgreSQL transactions through lock barriers.
  test.each(["contact", "workspace"] as const)(
    "a delayed %s snapshot cannot overwrite a newer settled projection",
    async (kind) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const oldRepair = openClient();
        const currentRepair = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const contactId = createSafeId<"contact">();
        const workspaceId = createSafeId<"workspace">();
        const staleText = `stale-${kind}-${Bun.randomUUIDv7()}`;
        const currentText = `current-${kind}-${Bun.randomUUIDv7()}`;
        const oldSourceRead = Promise.withResolvers<undefined>();
        const releaseOld = Promise.withResolvers<undefined>();
        let oldDrain: Promise<unknown> | undefined;
        try {
          await currentRepair.db.insert(organization).values({
            createdAt: new Date(),
            id: organizationId,
            name: "Projection repair fence",
            slug: organizationId,
          });
          if (kind === "contact") {
            await currentRepair.db.insert(contacts).values({
              displayName: staleText,
              id: contactId,
              organizationId,
              type: "person",
            });
            await currentRepair.db.transaction(async (tx) => {
              await enqueueContactSearchRepairs(asTestRaw<Transaction>(tx), [
                contactId,
              ]);
            });
          } else {
            await currentRepair.db.insert(workspaces).values({
              id: workspaceId,
              name: staleText,
              organizationId,
              reference: "FENCE-1",
            });
            await currentRepair.db.transaction(async (tx) => {
              await enqueueWorkspaceSearchRepairs(asTestRaw<Transaction>(tx), [
                workspaceId,
              ]);
            });
          }

          const gatedOldDatabase = pauseFirstTransaction({
            database: oldRepair.db,
            release: releaseOld.promise,
            sourceRead: () => oldSourceRead.resolve(undefined),
          });
          oldDrain = drainSearchProjectionRepairQueue({
            deps: createSearchProjectionRepairDeps(gatedOldDatabase),
            limit: 1,
          });
          await withTimeout(async () => await oldSourceRead.promise, {
            label: `${kind} old projection source snapshot`,
            timeoutMs: 3000,
          });

          await currentRepair.db.transaction(async (tx) => {
            if (kind === "contact") {
              await tx
                .update(contacts)
                .set({ displayName: currentText })
                .where(eq(contacts.id, contactId));
              await enqueueContactSearchRepairs(asTestRaw<Transaction>(tx), [
                contactId,
              ]);
              return;
            }
            await tx
              .update(workspaces)
              .set({ name: currentText })
              .where(eq(workspaces.id, workspaceId));
            await enqueueWorkspaceSearchRepairs(asTestRaw<Transaction>(tx), [
              workspaceId,
            ]);
          });
          expect(
            await drainSearchProjectionRepairQueue({
              deps: createSearchProjectionRepairDeps(currentRepair.db),
              limit: 1,
            }),
          ).toEqual({ failed: 0, repaired: 1 });
          expect(
            await currentRepair.db.select().from(searchProjectionRepairQueue),
          ).toEqual([]);

          releaseOld.resolve(undefined);
          expect(await oldDrain).toEqual({ failed: 0, repaired: 1 });

          const titles =
            kind === "contact"
              ? await currentRepair.db
                  .select({ title: contactSearchDocuments.title })
                  .from(contactSearchDocuments)
                  .where(eq(contactSearchDocuments.contactId, contactId))
              : await currentRepair.db
                  .select({ title: workspaceSearchDocuments.title })
                  .from(workspaceSearchDocuments)
                  .where(eq(workspaceSearchDocuments.workspaceId, workspaceId));
          expect(titles).toEqual([{ title: currentText }]);
          expect(
            await currentRepair.db.select().from(searchProjectionRepairQueue),
          ).toEqual([]);
        } finally {
          releaseOld.resolve(undefined);
          await Promise.allSettled(oldDrain ? [oldDrain] : []);
          await currentRepair.db
            .delete(organization)
            .where(eq(organization.id, organizationId));
        }
      });
    },
    15_000,
  );
}
