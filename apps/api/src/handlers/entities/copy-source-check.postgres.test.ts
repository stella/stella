import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  entities,
  entityVersions,
  fields,
  properties,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { writeFileVersion } from "@/api/lib/entity-versions/write-file-version";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  copyEntities,
  ENTITY_SNAPSHOT_COLUMNS,
  EVERY_LIVE_VERSION_SELECT,
  remapFileIds,
} from "./copy-utils";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const noAudit = async () => undefined;

if (!databaseUrl || !runPostgresTests) {
  describe.skip("source transfer serialization against Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test.each(["writer", "move"] as const)(
    "%s arriving first determines the source transfer outcome",
    async (first) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient();
        const mover = openClient({
          connection: { lock_timeout: 250, statement_timeout: 10_000 },
        });
        const writer = openClient({
          connection: { lock_timeout: 250, statement_timeout: 10_000 },
        });
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const sourceWorkspaceId = createSafeId<"workspace">();
        const targetWorkspaceId = createSafeId<"workspace">();
        const documentId = createSafeId<"entity">();
        const versionId = createSafeId<"entityVersion">();
        const newVersionId = createSafeId<"entityVersion">();
        const sourcePropertyId = createSafeId<"property">();
        const targetPropertyId = createSafeId<"property">();
        const firstLocked = Promise.withResolvers<undefined>();
        const releaseFirst = Promise.withResolvers<undefined>();

        const tasks: Promise<unknown>[] = [];
        try {
          await setup.db.insert(organization).values({
            id: organizationId,
            name: "Transfer concurrency",
            slug: organizationId,
            createdAt: new Date(),
          });
          await setup.db.insert(user).values({
            id: userId,
            name: "Transfer user",
            email: `${userId}@example.test`,
          });
          await setup.db.insert(workspaces).values([
            {
              id: sourceWorkspaceId,
              organizationId,
              name: "Source",
              reference: "SRC",
            },
            {
              id: targetWorkspaceId,
              organizationId,
              name: "Target",
              reference: "TGT",
            },
          ]);
          await setup.db.insert(properties).values([
            {
              id: sourcePropertyId,
              workspaceId: sourceWorkspaceId,
              name: "File",
              content: { type: "file", version: 1 },
              tool: { type: "manual-input", version: 1 },
              status: "fresh",
              system: true,
              kinds: ["document"],
            },
            {
              id: targetPropertyId,
              workspaceId: targetWorkspaceId,
              name: "File",
              content: { type: "file", version: 1 },
              tool: { type: "manual-input", version: 1 },
              status: "fresh",
              system: true,
              kinds: ["document"],
            },
          ]);
          await setup.db.insert(entities).values({
            id: documentId,
            workspaceId: sourceWorkspaceId,
            name: "Original.txt",
            kind: "document",
            docSequence: 1,
          });
          await setup.db.insert(entityVersions).values({
            id: versionId,
            entityId: documentId,
            workspaceId: sourceWorkspaceId,
            versionNumber: 1,
          });
          await setup.db.insert(fields).values({
            id: createSafeId<"field">(),
            workspaceId: sourceWorkspaceId,
            entityVersionId: versionId,
            propertyId: sourcePropertyId,
            content: {
              type: "file",
              version: 1,
              id: allocateFileObject(),
              fileName: "Original.txt",
              mimeType: "text/plain",
              sizeBytes: 8,
              encrypted: false,
              sha256Hex: "a".repeat(64),
              pdfFileId: null,
            },
          });
          await setup.db
            .update(entities)
            .set({ currentVersionId: versionId })
            .where(eq(entities.id, documentId));
          const source = await setup.db.query.entities.findFirst({
            where: { id: { eq: documentId } },
            columns: ENTITY_SNAPSHOT_COLUMNS,
            with: EVERY_LIVE_VERSION_SELECT,
          });
          if (!source) {
            throw new TypeError("Expected seeded document");
          }
          const sourceSnapshot = [source];
          const sourceFile = source.versions.at(0)?.fields.at(0)?.content;
          if (sourceFile?.type !== "file") {
            throw new TypeError("Expected source file");
          }
          const targetSnapshot = structuredClone(source);
          for (const version of targetSnapshot.versions) {
            for (const field of version.fields) {
              field.propertyId = targetPropertyId;
            }
          }
          const writable = remapFileIds(
            [targetSnapshot],
            [
              {
                sourceEntityId: documentId,
                sourceFileId: sourceFile.id,
                newFileId: allocateFileObject(),
                mimeType: sourceFile.mimeType,
                sourceKey: "source",
                targetKey: "target",
              },
            ],
          );
          const move = () =>
            mover.db.transaction(async (rawTx) => {
              const tx = asTestRaw<Transaction>(rawTx);
              const result = await copyEntities({
                tx,
                organizationId,
                sourceWorkspaceId,
                targetWorkspaceId,
                targetParentId: null,
                userId,
                recordAuditEvent: noAudit,
                sourceEntityId: documentId,
                sourceEntities: writable,
                transfer: { type: "move", sourceWorkspaceId, sourceSnapshot },
                fieldMapping: { type: "omit" },
                dependencies: {
                  requestNativeExtractionRuns: async () => [],
                  enqueueEntitySearchRepairs: async () => {
                    if (first === "move") {
                      firstLocked.resolve(undefined);
                      await releaseFirst.promise;
                    }
                  },
                },
              });
              if (Result.isOk(result)) {
                await rawTx.delete(entities).where(eq(entities.id, documentId));
              }
              return result;
            });
          const write = () =>
            writer.db.transaction(
              async (rawTx) =>
                await writeFileVersion({
                  tx: asTestRaw<Transaction>(rawTx),
                  organizationId,
                  workspaceId: sourceWorkspaceId,
                  entityId: documentId,
                  userId,
                  recordAuditEvent: noAudit,
                  entityVersionId: newVersionId,
                  fieldId: createSafeId<"field">(),
                  fileId: allocateFileObject(),
                  fileName: "New.txt",
                  mimeType: "text/plain",
                  sizeBytes: 8,
                  sha256Hex: "b".repeat(64),
                  source: null,
                  writePolicy: { type: "replace-current-file" },
                  afterWrite: async () => {
                    if (first === "writer") {
                      firstLocked.resolve(undefined);
                      await releaseFirst.promise;
                    }
                  },
                }),
            );
          // The winner keeps its transaction open until Postgres confirms
          // the losing operation actually waited on a conflicting row lock.
          // The timeout is the loser's final outcome; neither operation retries.
          if (first === "writer") {
            const writing = write();
            tasks.push(writing);
            await Promise.race([
              firstLocked.promise,
              writing.then(() => {
                throw new TypeError(
                  "Writer settled before transaction barrier",
                );
              }),
            ]);
            const refused = await Result.tryPromise(move);
            expect(Result.isError(refused)).toBe(true);
            if (Result.isOk(refused)) {
              throw new TypeError("Expected a blocked move");
            }
            expect(getPgErrorCode(refused.error)).toBe(
              PG_ERROR.LOCK_NOT_AVAILABLE,
            );
            releaseFirst.resolve(undefined);
            expect((await writing).status).toBe("ok");
            expect(
              await setup.db.$count(
                entities,
                eq(entities.workspaceId, targetWorkspaceId),
              ),
            ).toBe(0);
            expect(
              await setup.db.$count(
                entityVersions,
                eq(entityVersions.entityId, documentId),
              ),
            ).toBe(2);
            const sourceAfter = await setup.db.query.entities.findFirst({
              where: { id: { eq: documentId } },
            });
            expect(sourceAfter?.currentVersionId).toBe(newVersionId);
          } else {
            const moving = move();
            tasks.push(moving);
            await Promise.race([
              firstLocked.promise,
              moving.then(() => {
                throw new TypeError("Move settled before transaction barrier");
              }),
            ]);
            const refused = await Result.tryPromise(write);
            expect(Result.isError(refused)).toBe(true);
            if (Result.isOk(refused)) {
              throw new TypeError("Expected a blocked writer");
            }
            expect(getPgErrorCode(refused.error)).toBe(
              PG_ERROR.LOCK_NOT_AVAILABLE,
            );
            releaseFirst.resolve(undefined);
            expect(Result.isOk(await moving)).toBe(true);
            expect(
              await setup.db.$count(
                entities,
                eq(entities.workspaceId, sourceWorkspaceId),
              ),
            ).toBe(0);
            expect(
              await setup.db.$count(
                entities,
                eq(entities.workspaceId, targetWorkspaceId),
              ),
            ).toBe(1);
            expect(
              await setup.db.$count(
                entityVersions,
                eq(entityVersions.id, newVersionId),
              ),
            ).toBe(0);
            expect(
              await setup.db.$count(
                entityVersions,
                eq(entityVersions.workspaceId, targetWorkspaceId),
              ),
            ).toBe(1);
          }
        } finally {
          releaseFirst.resolve(undefined);
          try {
            await Promise.all(tasks);
          } finally {
            await setup.db
              .delete(organization)
              .where(eq(organization.id, organizationId));
            await setup.db.delete(user).where(eq(user.id, userId));
          }
        }
      });
    },
    30_000,
  );
}
