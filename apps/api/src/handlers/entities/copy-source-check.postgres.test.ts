import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { organization, user } from "@/api/db/auth-schema";
import { databaseRelations } from "@/api/db/database-relations";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  desktopEditSessions,
  entities,
  entityVersions,
  fields,
  properties,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { lockDesktopEditTarget } from "@/api/lib/entity-versions/desktop-edit-session-utils";
import { writeFileVersion } from "@/api/lib/entity-versions/write-file-version";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { serverBuiltFileEncryption } from "@/api/lib/files/detect-file-encryption";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  copyEntities,
  ENTITY_SNAPSHOT_COLUMNS,
  EVERY_LIVE_VERSION_SELECT,
  remapFileIds,
} from "./copy-utils";
import { openDesktopEditSessionHandler } from "./open-desktop-edit-session";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const noAudit = async () => undefined;
const owners = ["entity", "version", "field"] as const;
const lockOrderPairs = [
  "version-write",
  "restore",
  "same-matter-move",
  "processing-dispatch",
  "processing-projection",
  "desktop-open",
] as const;
const schedules = [
  ...owners.flatMap((owner) =>
    (["writer", "move"] as const).map((first) => ({ owner, first })),
  ),
  ...lockOrderPairs.flatMap((owner) =>
    (["writer", "move"] as const).map((first) => ({ owner, first })),
  ),
];

if (!databaseUrl || !runPostgresTests) {
  describe.skip("source transfer serialization against Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test.each(schedules)(
    "$owner writer and move preserve source state when $first arrives first",
    async ({ owner, first }) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient();
        const mover = openClient();
        const writer = openClient();
        const probe = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const sourceWorkspaceId = createSafeId<"workspace">();
        const targetWorkspaceId = createSafeId<"workspace">();
        const documentId = createSafeId<"entity">();
        const folderId = createSafeId<"entity">();
        const versionId = createSafeId<"entityVersion">();
        const fieldId = createSafeId<"field">();
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
            id: fieldId,
            workspaceId: sourceWorkspaceId,
            entityVersionId: versionId,
            propertyId: sourcePropertyId,
            content: {
              type: "file",
              version: 1,
              id: allocateFileObject(),
              fileName: "Original.txt",
              mimeType:
                owner === "desktop-open" ? DOCX_MIME_TYPE : "text/plain",
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
          if (owner === "same-matter-move") {
            await setup.db.insert(entities).values({
              id: folderId,
              workspaceId: sourceWorkspaceId,
              name: "Destination",
              kind: "folder",
            });
          }
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
          const move = async () =>
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
          const writeCarriedRow = async (
            tx: Transaction,
            rowOwner: (typeof owners)[number],
          ) => {
            switch (rowOwner) {
              case "entity":
                return await tx
                  .update(entities)
                  .set({ name: "Changed.txt" })
                  .where(eq(entities.id, documentId))
                  .returning({ id: entities.id });
              case "version":
                return await tx
                  .update(entityVersions)
                  .set({ detectedLanguage: "CS" })
                  .where(eq(entityVersions.id, versionId))
                  .returning({ id: entityVersions.id });
              case "field":
                return await tx
                  .update(fields)
                  .set({ content: { ...sourceFile, fileName: "Changed.txt" } })
                  .where(eq(fields.id, fieldId))
                  .returning({ id: fields.id });
              default:
                return rowOwner satisfies never;
            }
          };
          // These are the same mutations as rename, version annotation and
          // derivative updates: none acquires a workspace row lock.
          const write = async () =>
            writer.db.transaction(async (tx) => {
              switch (owner) {
                case "entity":
                case "version":
                case "field": {
                  const changed = await writeCarriedRow(
                    asTestRaw<Transaction>(tx),
                    owner,
                  );
                  if (first === "writer") {
                    firstLocked.resolve(undefined);
                    await releaseFirst.promise;
                  }
                  return changed;
                }
                case "desktop-open": {
                  await lockDesktopEditTarget({
                    tx: asTestRaw<Transaction>(tx),
                    entityId: documentId,
                    propertyId: sourcePropertyId,
                    workspaceId: sourceWorkspaceId,
                  });
                  // The real insert takes workspace KEY SHARE and version/entity
                  // FK locks; no workspace UPDATE lock is acquired by this owner.
                  const inserted = await tx
                    .insert(desktopEditSessions)
                    .values({
                      id: createSafeId<"desktopEditSession">(),
                      workspaceId: sourceWorkspaceId,
                      entityId: documentId,
                      propertyId: sourcePropertyId,
                      baseVersionId: versionId,
                      createdBy: userId,
                      fileType: "docx",
                      fileName: "Original.docx",
                      checkpointFileId: createSafeId<"userFile">(),
                      sessionTokenHash: "a".repeat(64),
                      tokenExpiresAt: new Date(Date.now() + 60_000),
                    })
                    .returning({ id: desktopEditSessions.id });
                  firstLocked.resolve(undefined);
                  await releaseFirst.promise;
                  return inserted;
                }
                case "version-write":
                case "restore":
                case "same-matter-move":
                case "processing-dispatch":
                case "processing-projection": {
                  // Park at the existing owner's entity -> workspace boundary.
                  // Restore/reparent and processing use the SQL locks documented
                  // in their owners; version writes execute their canonical owner.
                  await tx
                    .select({ id: entities.id })
                    .from(entities)
                    .where(eq(entities.id, documentId))
                    .for("update");
                  if (owner === "processing-projection") {
                    await tx
                      .select({ id: entityVersions.id })
                      .from(entityVersions)
                      .where(eq(entityVersions.id, versionId))
                      .for("update");
                    await tx
                      .select({ id: fields.id })
                      .from(fields)
                      .where(eq(fields.id, fieldId))
                      .for("update");
                  }
                  firstLocked.resolve(undefined);
                  await releaseFirst.promise;
                  if (owner === "version-write") {
                    const written = await writeFileVersion({
                      tx: asTestRaw<Transaction>(tx),
                      organizationId,
                      workspaceId: sourceWorkspaceId,
                      entityId: documentId,
                      userId,
                      recordAuditEvent: noAudit,
                      entityVersionId: createSafeId<"entityVersion">(),
                      fieldId: createSafeId<"field">(),
                      fileId: allocateFileObject(),
                      fileName: "New.txt",
                      mimeType: "text/plain",
                      encryption: serverBuiltFileEncryption(),
                      sizeBytes: 8,
                      sha256Hex: "b".repeat(64),
                      source: null,
                      writePolicy: { type: "replace-current-file" },
                    });
                    expect(written.status).toBe("ok");
                  } else {
                    await tx
                      .select({ id: workspaces.id })
                      .from(workspaces)
                      .where(eq(workspaces.id, sourceWorkspaceId))
                      .for("update");
                    if (owner === "restore") {
                      const restoredId = createSafeId<"entityVersion">();
                      await tx.insert(entityVersions).values({
                        id: restoredId,
                        entityId: documentId,
                        workspaceId: sourceWorkspaceId,
                        versionNumber: 2,
                      });
                      await tx.insert(fields).values({
                        entityVersionId: restoredId,
                        propertyId: sourcePropertyId,
                        workspaceId: sourceWorkspaceId,
                        content: sourceFile,
                      });
                      await tx
                        .update(entities)
                        .set({ currentVersionId: restoredId })
                        .where(eq(entities.id, documentId));
                    }
                    if (owner === "same-matter-move") {
                      await tx
                        .update(entities)
                        .set({ parentId: folderId })
                        .where(eq(entities.id, documentId));
                    }
                    if (owner === "processing-projection") {
                      await tx
                        .update(fields)
                        .set({
                          content: { ...sourceFile, fileName: "Projected.txt" },
                        })
                        .where(eq(fields.id, fieldId));
                    }
                    await tx
                      .update(workspaces)
                      .set({ lastActivityAt: new Date() })
                      .where(eq(workspaces.id, sourceWorkspaceId));
                  }
                  return [{ id: documentId }];
                }
                default:
                  return owner satisfies never;
              }
            });
          if (first === "writer") {
            const writing = write();
            tasks.push(writing);
            await Promise.race([
              firstLocked.promise,
              writing.then(() => {
                throw new TypeError("Writer settled before barrier");
              }),
            ]);
            const refused = await move();
            expect(Result.isError(refused)).toBe(true);
            if (Result.isOk(refused)) {
              throw new TypeError("Expected move refusal");
            }
            expect(refused.error.status).toBe(409);
            expect(refused.error.code).toBe("entity_transfer_source_changed");
            expect(refused.error.retryable).toBe(true);
            releaseFirst.resolve(undefined);
            expect(await writing).toHaveLength(1);
            expect(
              await setup.db.$count(
                entities,
                eq(entities.workspaceId, targetWorkspaceId),
              ),
            ).toBe(0);
            const after = await setup.db.query.entities.findFirst({
              where: { id: { eq: documentId } },
              columns: ENTITY_SNAPSHOT_COLUMNS,
              with: EVERY_LIVE_VERSION_SELECT,
            });
            expect(after).toBeDefined();
            if (owner === "version-write" || owner === "restore") {
              expect(after?.versions).toHaveLength(2);
              expect(after?.currentVersionId).not.toBe(versionId);
            }
            if (owner === "same-matter-move") {
              expect(after?.parentId).toBe(folderId);
            }
            if (owner === "desktop-open") {
              expect(
                await setup.db.$count(
                  desktopEditSessions,
                  eq(desktopEditSessions.entityId, documentId),
                ),
              ).toBe(1);
            }
            if (owner === "processing-projection") {
              const projected = after?.versions.at(0)?.fields.at(0)?.content;
              expect(projected?.type === "file" && projected.fileName).toBe(
                "Projected.txt",
              );
            }

            if (owner === "entity") {
              expect(after?.name).toBe("Changed.txt");
            }
            if (owner === "version") {
              expect(after?.versions.at(0)?.detectedLanguage).toBe("CS");
            }
            if (owner === "field") {
              const content = after?.versions.at(0)?.fields.at(0)?.content;
              expect(content?.type === "file" && content.fileName).toBe(
                "Changed.txt",
              );
            }
          } else {
            const moving = move();
            tasks.push(moving);
            await Promise.race([
              firstLocked.promise,
              moving.then(() => {
                throw new TypeError("Move settled before barrier");
              }),
            ]);
            // Observe each decisive row lock without a test-only timeout. This
            // also makes removal of ANY source lock fail this test. The normal
            // writer below still uses the production waiting UPDATE semantics.
            const locked = await Result.tryPromise(async () =>
              probe.db.transaction(async (tx) => {
                if (owner === "entity") {
                  return await tx
                    .select({ id: entities.id })
                    .from(entities)
                    .where(eq(entities.id, documentId))
                    .for("update", { noWait: true });
                }
                if (owner === "version") {
                  return await tx
                    .select({ id: entityVersions.id })
                    .from(entityVersions)
                    .where(eq(entityVersions.id, versionId))
                    .for("update", { noWait: true });
                }
                return await tx
                  .select({ id: fields.id })
                  .from(fields)
                  .where(eq(fields.id, fieldId))
                  .for("update", { noWait: true });
              }),
            );
            expect(Result.isError(locked)).toBe(true);
            if (Result.isOk(locked)) {
              throw new TypeError(
                "Expected the source row to remain locked until deletion",
              );
            }
            expect(getPgErrorCode(locked.error)).toBe(
              PG_ERROR.LOCK_NOT_AVAILABLE,
            );
            const writerStarted = Promise.withResolvers<undefined>();
            const writeAfterMove = async () => {
              if (owner === "desktop-open") {
                const sessionDb = drizzle({
                  client: writer.sql,
                  relations: databaseRelations,
                  logger: {
                    logQuery: (query) => {
                      // This event occurs after the handler read the pinned
                      // source target and begins the real FK-checked INSERT.
                      if (
                        query.startsWith('insert into "desktop_edit_sessions"')
                      ) {
                        writerStarted.resolve(undefined);
                      }
                    },
                  },
                });
                const opened = await Result.gen(() =>
                  openDesktopEditSessionHandler({
                    body: {
                      entityId: documentId,
                      propertyId: sourcePropertyId,
                    },
                    organizationId,
                    recordAuditEvent: noAudit,
                    safeDb: asTestRaw<SafeDb>(
                      createSafeDb(
                        markRlsDatabase(sessionDb),
                        [sourceWorkspaceId],
                        organizationId,
                        userId,
                      ),
                    ),
                    userId,
                    workspaceId: sourceWorkspaceId,
                  }),
                );
                expect(Result.isError(opened)).toBe(true);
                if (Result.isOk(opened)) {
                  throw new TypeError("Expected moved desktop target refusal");
                }
                expect(HandlerError.is(opened.error)).toBe(true);
                if (!HandlerError.is(opened.error)) {
                  throw new TypeError(
                    "Expected a typed desktop target refusal",
                  );
                }
                expect(opened.error.status).toBe(409);
                expect(opened.error.code).toBe(
                  "entity_transfer_source_changed",
                );
                expect(opened.error.retryable).toBe(true);
                expect(getPgErrorCode(opened.error)).not.toBe(
                  PG_ERROR.DEADLOCK_DETECTED,
                );
                return [];
              }
              return await writer.db.transaction(async (tx) => {
                // Establish the competing session before committing the move.
                await tx
                  .select({ id: workspaces.id })
                  .from(workspaces)
                  .where(eq(workspaces.id, sourceWorkspaceId));
                writerStarted.resolve(undefined);
                if (owner === "version-write") {
                  const outcome = await writeFileVersion({
                    tx: asTestRaw<Transaction>(tx),
                    organizationId,
                    workspaceId: sourceWorkspaceId,
                    entityId: documentId,
                    userId,
                    recordAuditEvent: noAudit,
                    entityVersionId: createSafeId<"entityVersion">(),
                    fieldId: createSafeId<"field">(),
                    fileId: allocateFileObject(),
                    fileName: "New.txt",
                    mimeType: "text/plain",
                    encryption: serverBuiltFileEncryption(),
                    sizeBytes: 8,
                    sha256Hex: "b".repeat(64),
                    source: null,
                    writePolicy: { type: "replace-current-file" },
                  });
                  expect(outcome.status).toBe("entity-not-found");
                  return [];
                }
                if (
                  owner === "restore" ||
                  owner === "same-matter-move" ||
                  owner === "processing-dispatch" ||
                  owner === "processing-projection"
                ) {
                  const sourceRows = await tx
                    .select({ id: entities.id })
                    .from(entities)
                    .where(eq(entities.id, documentId))
                    .for("update");
                  // These owners stop before workspace/run/projection writes
                  // when the decisive source row no longer exists.
                  expect(sourceRows).toHaveLength(0);
                  return sourceRows;
                }
                return await writeCarriedRow(asTestRaw<Transaction>(tx), owner);
              });
            };
            const writing = writeAfterMove();
            tasks.push(writing);
            await Promise.race([
              writerStarted.promise,
              writing.then(() => {
                throw new TypeError(
                  "Writer settled before starting its overlapping mutation",
                );
              }),
            ]);
            releaseFirst.resolve(undefined);
            expect(Result.isOk(await moving)).toBe(true);
            // Zero affected rows is the UPDATE writer's clean gone outcome;
            // it cannot report a successful edit discarded by source deletion.
            expect(await writing).toHaveLength(0);
            expect(
              await setup.db.$count(
                entities,
                eq(entities.workspaceId, sourceWorkspaceId),
              ),
            ).toBe(owner === "same-matter-move" ? 1 : 0);
            expect(
              await setup.db.$count(
                entities,
                eq(entities.workspaceId, targetWorkspaceId),
              ),
            ).toBe(1);
            const target = await setup.db.query.entities.findFirst({
              where: { workspaceId: { eq: targetWorkspaceId } },
              columns: ENTITY_SNAPSHOT_COLUMNS,
              with: EVERY_LIVE_VERSION_SELECT,
            });
            expect(target?.name).toBe("Original.txt");
            expect(target?.versions).toHaveLength(1);
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
