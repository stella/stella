import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { withTimeout } from "@stll/concurrency/with-timeout";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  contactSearchDocuments,
  contacts,
  entities,
  entityVersions,
  extractedContent,
  fields,
  properties,
  searchDocuments,
  workspaceSearchDocuments,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import { upsertSearchDocument } from "@/api/lib/search/index-entity";
import {
  upsertContactSearchDocument,
  upsertWorkspaceSearchDocuments,
  upsertWorkspaceSearchDocument,
} from "@/api/lib/search/index-global";
import { persistNativeExtractionProjection } from "@/api/lib/search/process-extraction";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { waitForBlockedPid } from "@/api/tests/helpers/flow-review-gate";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const pairs = [
  { kind: "entity", parent: "organization" },
  { kind: "entity", parent: "workspace" },
  { kind: "native", parent: "organization" },
  { kind: "native", parent: "workspace" },
  { kind: "contact", parent: "organization" },
  { kind: "workspace", parent: "organization" },
  { kind: "workspace", parent: "workspace" },
] as const;
const schedules = pairs.flatMap((pair) =>
  (["deletion", "repair"] as const).map((first) => ({ ...pair, first })),
);
if (!databaseUrl || !runPostgresTests) {
  describe.skip("projection parent serialization against Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test.each(schedules)(
    "$kind repair and $parent deletion serialize when $first starts first",
    async ({ kind, parent, first }) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient();
        const repair = openClient({ connection: { statement_timeout: 5000 } });
        const deletion = openClient({
          connection: { statement_timeout: 5000 },
        });
        const observer = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const workspaceId = createSafeId<"workspace">();
        const survivingWorkspaceId = createSafeId<"workspace">();
        const entityId = createSafeId<"entity">();
        const versionId = createSafeId<"entityVersion">();
        const contactId = createSafeId<"contact">();
        const propertyId = createSafeId<"property">();
        const fieldId = createSafeId<"field">();
        const sourceFileId = Bun.randomUUIDv7();
        const sourceSha256Hex = "a".repeat(64);
        const envelope = await encryptContent(
          organizationId,
          "Projection extraction",
        );
        const firstReady = Promise.withResolvers<undefined>();
        const releaseFirst = Promise.withResolvers<undefined>();
        const pending: Promise<void>[] = [];
        try {
          await setup.db.insert(organization).values({
            id: organizationId,
            name: "Projection serialization",
            slug: organizationId,
            createdAt: new Date(),
          });
          await setup.db.insert(workspaces).values({
            id: workspaceId,
            organizationId,
            name: "Projection matter",
            reference: "PROJ",
          });
          if (kind === "workspace" && parent === "workspace") {
            await setup.db.insert(workspaces).values({
              id: survivingWorkspaceId,
              organizationId,
              name: "Surviving matter",
              reference: "SURV",
            });
          }
          await setup.db.insert(entities).values({
            id: entityId,
            workspaceId,
            name: "Projection source",
            kind: "document",
          });
          await setup.db
            .insert(entityVersions)
            .values({ id: versionId, entityId, workspaceId, versionNumber: 1 });
          await setup.db
            .update(entities)
            .set({ currentVersionId: versionId })
            .where(eq(entities.id, entityId));
          await setup.db.insert(contacts).values({
            id: contactId,
            organizationId,
            type: "person",
            displayName: "Projection contact",
            firstName: "Projection",
          });
          await setup.db.insert(properties).values({
            id: propertyId,
            workspaceId,
            name: "File",
            content: { type: "file", version: 1 },
            tool: { type: "manual-input", version: 1 },
            status: "fresh",
            system: true,
            kinds: ["document"],
          });
          await setup.db.insert(fields).values({
            id: fieldId,
            workspaceId,
            entityVersionId: versionId,
            propertyId,
            content: {
              type: "file",
              version: 1,
              id: sourceFileId,
              sha256Hex: sourceSha256Hex,
              fileName: "source.txt",
              mimeType: "text/plain",
              sizeBytes: 10,
              encrypted: false,
              pdfFileId: null,
            },
          });
          const project = async (
            database: Pick<GatedTestDb, "query" | "select" | "transaction">,
          ) => {
            switch (kind) {
              case "native": {
                const outcome = await persistNativeExtractionProjection(
                  {
                    charCount: 21,
                    ...envelope,
                    entityId,
                    entityVersionId: versionId,
                    fieldId,
                    organizationId,
                    workspaceId,
                    sourceFileId,
                    sourceSha256Hex,
                  },
                  database,
                );
                return outcome;
              }
              case "entity":
                await upsertSearchDocument(entityId, { database });
                return undefined;
              case "contact":
                await upsertContactSearchDocument(contactId, database);
                return undefined;
              case "workspace":
                if (parent === "workspace") {
                  await upsertWorkspaceSearchDocuments(
                    [survivingWorkspaceId, workspaceId],
                    database,
                  );
                  return undefined;
                }
                await upsertWorkspaceSearchDocument(workspaceId, database);
                return undefined;
              default:
                kind satisfies never;
                return undefined;
            }
          };
          // Replacement owns an existing projection before preview FK checks.
          const seeded = await project(setup.db);
          if (kind === "native") {
            expect(seeded).toBe("persisted");
            await setup.db
              .delete(extractedContent)
              .where(eq(extractedContent.entityId, entityId));
          }
          await setup.db
            .update(entities)
            .set({ name: "Updated projection" })
            .where(eq(entities.id, entityId));
          await setup.db
            .update(contacts)
            .set({ displayName: "Updated projection" })
            .where(eq(contacts.id, contactId));
          await setup.db
            .update(workspaces)
            .set({ name: "Updated projection" })
            .where(eq(workspaces.id, workspaceId));
          if (kind === "workspace" && parent === "workspace") {
            await setup.db
              .update(workspaces)
              .set({ name: "Updated survivor" })
              .where(eq(workspaces.id, survivingWorkspaceId));
          }
          const repairPidRows = await repair.sql<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          const deletionPidRows = await deletion.sql<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          const repairPid =
            repairPidRows.at(0)?.pid ?? panic("Repair session missing");
          const deletionPid =
            deletionPidRows.at(0)?.pid ?? panic("Deletion session missing");
          const repairDatabase = {
            query: repair.db.query,
            select: repair.db.select.bind(repair.db),
            transaction: async <T>(run: (tx: Transaction) => Promise<T>) =>
              await repair.db.transaction(async (tx) => {
                const result = await run(tx);
                if (first === "repair") {
                  switch (kind) {
                    case "entity":
                      expect(
                        (
                          await tx
                            .select({ title: searchDocuments.title })
                            .from(searchDocuments)
                            .where(eq(searchDocuments.entityId, entityId))
                        ).at(0)?.title,
                      ).toBe("Updated projection");
                      break;
                    case "contact":
                      expect(
                        (
                          await tx
                            .select({ title: contactSearchDocuments.title })
                            .from(contactSearchDocuments)
                            .where(
                              eq(contactSearchDocuments.contactId, contactId),
                            )
                        ).at(0)?.title,
                      ).toBe("Updated projection");
                      break;
                    case "workspace":
                      expect(
                        (
                          await tx
                            .select({ title: workspaceSearchDocuments.title })
                            .from(workspaceSearchDocuments)
                            .where(
                              eq(
                                workspaceSearchDocuments.workspaceId,
                                workspaceId,
                              ),
                            )
                        ).at(0)?.title,
                      ).toBe("Updated projection");
                      break;
                    case "native":
                      expect(
                        (
                          await tx
                            .select({ ciphertext: extractedContent.ciphertext })
                            .from(extractedContent)
                            .where(eq(extractedContent.entityId, entityId))
                        ).at(0)?.ciphertext,
                      ).toEqual(envelope.ciphertext);
                      break;
                    default:
                      kind satisfies never;
                  }
                }
                if (first === "repair") {
                  firstReady.resolve(undefined);
                  await releaseFirst.promise;
                }
                return result;
              }),
          };
          const runRepair = async () => {
            const outcome = await project(repairDatabase);
            if (kind === "native") {
              expect(outcome).toBe(
                first === "deletion" ? "source_cancelled" : "persisted",
              );
            }
          };
          const runDeletion = async () => {
            await deletion.db.transaction(async (tx) => {
              await tx.execute(
                parent === "organization"
                  ? sql`SELECT id FROM organization WHERE id = ${organizationId} FOR UPDATE`
                  : sql`SELECT id FROM organization WHERE id = ${organizationId} FOR KEY SHARE`,
              );
              if (parent === "workspace") {
                await tx.execute(
                  sql`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`,
                );
              }
              if (first === "deletion") {
                firstReady.resolve(undefined);
                await releaseFirst.promise;
              }
              if (parent === "organization") {
                await tx
                  .delete(organization)
                  .where(eq(organization.id, organizationId));
              } else {
                await tx
                  .delete(workspaces)
                  .where(eq(workspaces.id, workspaceId));
              }
            });
          };
          pending.push(first === "deletion" ? runDeletion() : runRepair());
          await withTimeout(async () => await firstReady.promise, {
            label: "first projection transaction barrier",
            timeoutMs: 3000,
          });
          pending.push(first === "deletion" ? runRepair() : runDeletion());
          await waitForBlockedPid(observer.sql, {
            waitingPid: first === "deletion" ? repairPid : deletionPid,
            holdingPid: first === "deletion" ? deletionPid : repairPid,
          });
          releaseFirst.resolve(undefined);
          const outcomes = await Promise.allSettled(pending);
          expect(outcomes.map(({ status }) => status)).toEqual([
            "fulfilled",
            "fulfilled",
          ]);
          expect(
            await setup.db
              .select()
              .from(searchDocuments)
              .where(eq(searchDocuments.entityId, entityId)),
          ).toEqual([]);
          expect(
            await setup.db
              .select()
              .from(contactSearchDocuments)
              .where(eq(contactSearchDocuments.contactId, contactId)),
          ).toEqual([]);
          expect(
            await setup.db
              .select()
              .from(workspaceSearchDocuments)
              .where(eq(workspaceSearchDocuments.workspaceId, workspaceId)),
          ).toEqual([]);
          expect(
            await setup.db
              .select()
              .from(extractedContent)
              .where(eq(extractedContent.entityId, entityId)),
          ).toEqual([]);
          if (kind === "workspace" && parent === "workspace") {
            expect(
              (
                await setup.db
                  .select({ title: workspaceSearchDocuments.title })
                  .from(workspaceSearchDocuments)
                  .where(
                    eq(
                      workspaceSearchDocuments.workspaceId,
                      survivingWorkspaceId,
                    ),
                  )
              ).at(0)?.title,
            ).toBe("Updated survivor");
          }
          expect(
            await setup.db.query.workspaces.findFirst({
              where: { id: { eq: workspaceId } },
            }),
          ).toBeUndefined();
        } finally {
          releaseFirst.resolve(undefined);
          await Promise.allSettled(pending);
          try {
            await Promise.all(pending);
          } finally {
            await setup.db
              .delete(organization)
              .where(eq(organization.id, organizationId));
          }
        }
      });
    },
    15_000,
  );
  test("overlapping matter repairs serialize opposite input orders", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const setup = openClient();
      const first = openClient({ connection: { statement_timeout: 5000 } });
      const second = openClient({ connection: { statement_timeout: 5000 } });
      const organizationId = mintAuthProviderId<"organization">();
      const workspaceIds = [
        createSafeId<"workspace">(),
        createSafeId<"workspace">(),
      ];
      const arrived = Promise.withResolvers<undefined>();
      let arrivals = 0;
      const pending: Promise<void>[] = [];
      const gated = (database: GatedTestDb) => ({
        query: database.query,
        select: database.select.bind(database),
        transaction: async <T>(run: (tx: Transaction) => Promise<T>) =>
          await database.transaction(async (tx) => {
            arrivals += 1;
            if (arrivals === 2) {
              arrived.resolve(undefined);
            }
            await withTimeout(async () => await arrived.promise, {
              label: "overlapping projection transaction barrier",
              timeoutMs: 3000,
            });
            return await run(tx);
          }),
      });
      try {
        await setup.db.insert(organization).values({
          id: organizationId,
          name: "Overlapping repairs",
          slug: organizationId,
          createdAt: new Date(),
        });
        await setup.db.insert(workspaces).values(
          workspaceIds.map((id, index) => ({
            id,
            organizationId,
            name: `Matter ${index}`,
            reference: `OVERLAP-${index}`,
          })),
        );
        await upsertWorkspaceSearchDocuments(workspaceIds, setup.db);
        await setup.db
          .update(workspaces)
          .set({ name: "Updated overlapping matter" })
          .where(eq(workspaces.organizationId, organizationId));
        pending.push(
          upsertWorkspaceSearchDocuments(workspaceIds, gated(first.db)),
        );
        pending.push(
          upsertWorkspaceSearchDocuments(
            workspaceIds.toReversed(),
            gated(second.db),
          ),
        );
        const outcomes = await Promise.allSettled(pending);
        expect(outcomes.map(({ status }) => status)).toEqual([
          "fulfilled",
          "fulfilled",
        ]);
        const rows = await setup.db
          .select({ title: workspaceSearchDocuments.title })
          .from(workspaceSearchDocuments)
          .where(eq(workspaceSearchDocuments.organizationId, organizationId));
        expect(rows).toHaveLength(workspaceIds.length);
        expect(
          rows.every(({ title }) => title === "Updated overlapping matter"),
        ).toBe(true);
      } finally {
        arrived.resolve(undefined);
        await Promise.allSettled(pending);
        try {
          await Promise.all(pending);
        } finally {
          await setup.db
            .delete(organization)
            .where(eq(organization.id, organizationId));
        }
      }
    });
  }, 15_000);
}
