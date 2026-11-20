import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";
import { compareCodeUnit } from "@stll/collation";
import { withTimeout } from "@stll/concurrency/with-timeout";
import { roleAllows } from "@stll/permissions";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  documentProcessingRuns,
  entities,
  entityVersions,
  fields,
  folioCollabRooms,
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  pendingUploads,
  properties,
  timeEntries,
  timeTimers,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { finalizeEntityVersion } from "@/api/handlers/uploads/entity-version";
import { archiveWorkspaceHandler } from "@/api/handlers/workspaces/archive";
import { createSafeId } from "@/api/lib/branded-types";
import {
  lockWorkspaceLifecycle,
  withAggregateLock,
} from "@/api/lib/db/aggregate-lock";
import { UPLOAD_DOCUMENT_SOURCE } from "@/api/lib/document-source";
import { CALLER_AUTHORIZED } from "@/api/lib/entities/buffer-write-authority";
import { lockWorkspaceForEntityCreate } from "@/api/lib/entity-cap-lock";
import { publishCheckpointInTransaction } from "@/api/lib/entity-versions/publish-folio-collab-checkpoint";
import { officeFileEncryption } from "@/api/lib/files/detect-file-encryption";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";
import { cents } from "@/api/lib/money";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

import { writeFileVersion } from "./write-file-version";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const recordAuditEvent = async () => undefined;

const seedFixture = async (db: GatedTestDb) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const entityId = createSafeId<"entity">();
  const versionId = createSafeId<"entityVersion">();
  const propertyId = createSafeId<"property">();
  const fieldId = createSafeId<"field">();
  const uploadId = createSafeId<"pendingUpload">();
  const roomId = createSafeId<"folioCollabRoom">();
  const checkpointFileId = createSafeId<"userFile">();
  const sha256Hex = "a".repeat(64);
  const checkpointUpdatedAt = new Date();
  await db.insert(organization).values({
    id: organizationId,
    name: "Version lock fixture",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: userId,
    name: "Version writer",
    email: `${userId}@example.test`,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Version matter",
    reference: workspaceId,
  });
  await db.insert(organizationAccessStates).values({
    organizationId,
    state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
  });
  await db.insert(member).values({
    id: Bun.randomUUIDv7(),
    organizationId,
    userId,
    role: "member",
    createdAt: checkpointUpdatedAt,
  });
  await db.insert(workspaceMembers).values({
    id: createSafeId<"workspaceMember">(),
    workspaceId,
    userId,
  });
  await db.insert(entities).values({
    id: entityId,
    workspaceId,
    name: "Version source",
    kind: "document",
  });
  await db
    .insert(entityVersions)
    .values({ id: versionId, entityId, workspaceId, versionNumber: 1 });
  await db
    .update(entities)
    .set({ currentVersionId: versionId })
    .where(eq(entities.id, entityId));
  await db.insert(properties).values({
    id: propertyId,
    workspaceId,
    name: "File",
    content: { type: "file", version: 1 },
    tool: { type: "manual-input", version: 1 },
    status: "fresh",
    system: true,
    kinds: ["document"],
  });
  await db.insert(fields).values({
    id: fieldId,
    workspaceId,
    entityVersionId: versionId,
    propertyId,
    content: {
      type: "file",
      version: 1,
      id: allocateFileObject(),
      fileName: "source.docx",
      mimeType: DOCX_MIME_TYPE,
      sizeBytes: 10,
      sha256Hex,
      encrypted: false,
      pdfFileId: null,
    },
  });
  await db.insert(pendingUploads).values({
    id: uploadId,
    workspaceId,
    organizationId,
    userId,
    purpose: "entity_version",
    purposeData: { type: "entity_version", entityId },
    declaredName: "source.docx",
    declaredMime: DOCX_MIME_TYPE,
    declaredSize: 10,
    declaredSha256: sha256Hex,
    status: "scanning",
    claimedByRequestId: "version-lock-claim",
    expiresAt: new Date(Date.now() + 60_000),
  });
  await db.insert(folioCollabRooms).values({
    id: roomId,
    workspaceId,
    entityId,
    propertyId,
    baseVersionId: versionId,
    sourceVersionId: versionId,
    fileName: "source.docx",
    yjsSnapshotFileId: createSafeId<"userFile">(),
    docxCheckpointFileId: checkpointFileId,
    docxCheckpointSha256Hex: sha256Hex,
    docxCheckpointUpdatedAt: checkpointUpdatedAt,
  });
  return {
    organizationId,
    userId,
    workspaceId,
    entityId,
    versionId,
    propertyId,
    fieldId,
    uploadId,
    roomId,
    sha256Hex,
    checkpointRoom: {
      checkpointFileId,
      checkpointScanWarnings: null,
      checkpointSha256Hex: sha256Hex,
      checkpointSnapshotSha256Hex: null,
      checkpointSizeBytes: 10,
      checkpointUpdatedAt,
      entityId,
      fileName: "source.docx",
      generation: 0,
      propertyId,
    },
    cleanup: async () => {
      await deleteOrganizationsForTest(db, [organizationId]);
      await db.delete(user).where(eq(user.id, userId));
    },
  };
};

type Fixture = Awaited<ReturnType<typeof seedFixture>>;
type BarrierOptions = {
  run: (tx: Transaction, fixture: Fixture) => Promise<void>;
  workspaceMode?: "update";
  prepareFixture?: (db: GatedTestDb, fixture: Fixture) => Promise<void>;
  acquireParent?: (tx: Transaction, fixture: Fixture) => Promise<void>;
};

const againstCap = async ({
  run,
  workspaceMode,
  prepareFixture,
  acquireParent,
}: BarrierOptions) => {
  const url = databaseUrl ?? panic("Postgres test requires DATABASE_URL");
  await withGatedTestClients(url, async ({ openClient }) => {
    const cap = openClient({ max: 1, connection: { statement_timeout: 5000 } });
    const writer = openClient({
      max: 1,
      connection: { statement_timeout: 5000 },
    });
    const observer = openClient({ max: 1 });
    const fixture = await seedFixture(cap.db);
    await prepareFixture?.(cap.db, fixture);
    const releaseCap = Promise.withResolvers<undefined>();
    const capReady = Promise.withResolvers<undefined>();
    const writerReady = Promise.withResolvers<undefined>();
    const releaseWriter = Promise.withResolvers<undefined>();
    const capPid =
      (await cap.sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`).at(0)
        ?.pid ?? panic("Missing cap PID");
    const writerPid =
      (await writer.sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`).at(
        0,
      )?.pid ?? panic("Missing writer PID");
    let capWork: Promise<void> | undefined;
    let writerWork: Promise<void> | undefined;
    try {
      capWork = cap.db.transaction(async (tx) => {
        if (acquireParent === undefined) {
          await lockWorkspaceForEntityCreate(
            asTestRaw<Transaction>(tx),
            fixture.workspaceId,
          );
        } else {
          await acquireParent(asTestRaw<Transaction>(tx), fixture);
        }
        capReady.resolve(undefined);
        await releaseCap.promise;
        // These are the rows downstream callers acquire. NOWAIT proves that
        // the waiting writer has retained none of them behind the parent.
        await tx
          .select({ id: entities.id })
          .from(entities)
          .where(eq(entities.id, fixture.entityId))
          .for("update", { noWait: true });
        await tx
          .select({ id: pendingUploads.id })
          .from(pendingUploads)
          .where(eq(pendingUploads.id, fixture.uploadId))
          .for("update", { noWait: true });
        await tx
          .select({ id: folioCollabRooms.id })
          .from(folioCollabRooms)
          .where(eq(folioCollabRooms.id, fixture.roomId))
          .for("update", { noWait: true });
        await tx
          .update(entities)
          .set({ name: "Cap completed" })
          .where(eq(entities.id, fixture.entityId));
      });
      await withTimeout(async () => await capReady.promise, {
        timeoutMs: 3000,
        label: "cap parent barrier",
      });
      writerWork = writer.db.transaction(async (tx) => {
        await run(asTestRaw<Transaction>(tx), fixture);
        writerReady.resolve(undefined);
        await releaseWriter.promise;
      });
      await waitForBlockedPid(observer.sql, {
        waitingPid: writerPid,
        holdingPid: capPid,
      });
      releaseCap.resolve(undefined);
      await capWork;
      await withTimeout(async () => await writerReady.promise, {
        timeoutMs: 3000,
        label: "version writer completion",
      });
      if (workspaceMode === "update") {
        await cap.db.transaction(async (tx) => {
          const result = await withAggregateLock({
            tx: asTestRaw<Transaction>(tx),
            aggregate: "workspace",
            id: {
              id: fixture.workspaceId,
              organizationId: fixture.organizationId,
            },
            mode: "key share",
            wait: "nowait",
          });
          expect(result.status).toBe("busy");
        });
      }
      releaseWriter.resolve(undefined);
      await writerWork;
      expect(
        (
          await cap.db
            .select({ name: entities.name })
            .from(entities)
            .where(eq(entities.id, fixture.entityId))
        ).at(0)?.name,
      ).toBe("Cap completed");
    } finally {
      releaseCap.resolve(undefined);
      releaseWriter.resolve(undefined);
      await Promise.allSettled(
        [capWork, writerWork].filter((work) => work !== undefined),
      );
      await fixture.cleanup();
    }
  });
};

const transactionSafeDb =
  (tx: Transaction): SafeDb =>
  async (operation) =>
    Result.ok(await operation(tx));

const archiveSafeDbIn = (
  tx: Transaction,
  fixture: Awaited<ReturnType<typeof seedFixture>>,
): SafeDb =>
  createSafeDb(
    markRlsDatabase(tx),
    [fixture.workspaceId],
    fixture.organizationId,
    fixture.userId,
  );

if (!databaseUrl || !enabled) {
  describe.skip("file version parent order (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("file version parent order (postgres)", () => {
    test("timer presence permission snapshot matches canonical matter-update roles", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const [routine] = await db
          .select({ source: sql<string>`prosrc` })
          .from(sql`pg_catalog.pg_proc`)
          .where(
            sql`oid = 'public.stella_matter_has_running_timers(uuid)'::regprocedure`,
          );
        const roles = routine?.source.match(
          /allowed_workspace_update_roles constant text\[\] := ARRAY\[(?<roles>[^\]]+)\]/u,
        )?.groups?.["roles"];
        expect(roles).toBeDefined();
        const installed = [...(roles ?? "").matchAll(/'(?<role>[^']+)'/gu)].map(
          (match) =>
            match.groups?.["role"] ?? panic("Matched role capture must exist"),
        );
        const allowed = ORGANIZATION_ROLE_NAMES.filter((role) =>
          roleAllows(role, { workspace: ["update"] }),
        );
        expect(installed.toSorted(compareCodeUnit)).toEqual(
          allowed.toSorted(compareCodeUnit),
        );
      });
    });

    test("does not archive while OCR has an active dispatch claim", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const fixture = await seedFixture(db);
        try {
          await db.insert(documentProcessingRuns).values({
            id: createSafeId<"documentProcessingRun">(),
            organizationId: fixture.organizationId,
            workspaceId: fixture.workspaceId,
            entityId: fixture.entityId,
            entityVersionId: fixture.versionId,
            fieldId: fixture.fieldId,
            sourceFileId: Bun.randomUUIDv7(),
            sourceSha256Hex: fixture.sha256Hex,
            kind: "ocr",
            requestSource: "manual",
            status: "running",
          });
          const result = await db.transaction(
            async (tx) =>
              await Result.gen(() =>
                archiveWorkspaceHandler({
                  safeDb: archiveSafeDbIn(asTestRaw<Transaction>(tx), fixture),
                  workspaceId: fixture.workspaceId,
                  recordAuditEvent,
                }),
              ),
          );
          expect(Result.isError(result)).toBe(true);
          expect(result).toMatchObject({ error: { status: 409 } });
          expect(
            (
              await db
                .select({ status: workspaces.status })
                .from(workspaces)
                .where(eq(workspaces.id, fixture.workspaceId))
            ).at(0)?.status,
          ).toBe("active");
        } finally {
          await fixture.cleanup();
        }
      });
    });

    test("does not archive while a timer is active", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const fixture = await seedFixture(db);
        try {
          await db.insert(timeEntries).values({
            id: createSafeId<"timeEntry">(),
            organizationId: fixture.organizationId,
            workspaceId: fixture.workspaceId,
            userId: fixture.userId,
            dateWorked: "2026-10-11",
            timezoneId: "Europe/Prague",
            durationMinutes: 1,
            billedMinutes: 1,
            rateAtEntry: cents(0),
            currency: "CZK",
            narrative: "Timer fixture",
            timerStartedAt: new Date(),
          });
          const result = await db.transaction(
            async (tx) =>
              await Result.gen(() =>
                archiveWorkspaceHandler({
                  safeDb: archiveSafeDbIn(asTestRaw<Transaction>(tx), fixture),
                  workspaceId: fixture.workspaceId,
                  recordAuditEvent,
                }),
              ),
          );
          expect(Result.isError(result)).toBe(true);
          expect(result).toMatchObject({
            error: {
              status: 409,
              message: "Stop active timers before archiving this matter",
            },
          });
          expect(
            (
              await db
                .select({ status: workspaces.status })
                .from(workspaces)
                .where(eq(workspaces.id, fixture.workspaceId))
            ).at(0)?.status,
          ).toBe("active");
        } finally {
          await fixture.cleanup();
        }
      });
    });

    test.each([
      { state: "running", matter: "same", timerOwner: "actor", blocked: true },
      {
        state: "running",
        matter: "same",
        timerOwner: "colleague",
        blocked: true,
      },
      {
        state: "paused",
        matter: "same",
        timerOwner: "colleague",
        blocked: false,
      },
      {
        state: "running",
        matter: "other",
        timerOwner: "colleague",
        blocked: false,
      },
      {
        state: "running",
        matter: "unassigned",
        timerOwner: "colleague",
        blocked: false,
      },
    ] as const)(
      "archive handles a $state current timer owned by $timerOwner assigned to $matter matter",
      async ({ state, matter, timerOwner, blocked }) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const db = openClient().db;
          const fixture = await seedFixture(db);
          const colleagueId = mintAuthProviderId<"user">();
          try {
            await db.insert(user).values({
              id: colleagueId,
              name: "Timer colleague",
              email: `${colleagueId}@example.test`,
            });
            const startedAt = new Date("2026-10-11T09:00:00.000Z");
            await db.insert(member).values({
              id: Bun.randomUUIDv7(),
              organizationId: fixture.organizationId,
              userId: colleagueId,
              role: "member",
              createdAt: startedAt,
            });
            await db.insert(workspaceMembers).values({
              id: createSafeId<"workspaceMember">(),
              workspaceId: fixture.workspaceId,
              userId: colleagueId,
            });
            const otherWorkspaceId = createSafeId<"workspace">();
            if (matter === "other") {
              await db.insert(workspaces).values({
                id: otherWorkspaceId,
                organizationId: fixture.organizationId,
                name: "Other timer matter",
                reference: otherWorkspaceId,
              });
              await db.insert(workspaceMembers).values({
                id: createSafeId<"workspaceMember">(),
                workspaceId: otherWorkspaceId,
                userId: colleagueId,
              });
            }
            const timerId = createSafeId<"timeTimer">();
            const ownerUserId =
              timerOwner === "actor" ? fixture.userId : colleagueId;
            const timerDb = createScopedDb(
              markRlsDatabase(db),
              [
                fixture.workspaceId,
                ...(matter === "other" ? [otherWorkspaceId] : []),
              ],
              fixture.organizationId,
              ownerUserId,
            );
            const archiverDb = createSafeDb(
              markRlsDatabase(db),
              [fixture.workspaceId],
              fixture.organizationId,
              fixture.userId,
            );
            await timerDb(
              async (tx) =>
                await tx.insert(timeTimers).values({
                  id: timerId,
                  organizationId: fixture.organizationId,
                  userId: ownerUserId,
                  workspaceId: {
                    same: fixture.workspaceId,
                    other: otherWorkspaceId,
                    unassigned: null,
                  }[matter],
                  state,
                  startedAt,
                  lastResumedAt: state === "running" ? startedAt : null,
                }),
            );
            const beforeTimer = await timerDb(
              async (tx) =>
                await tx.query.timeTimers.findFirst({
                  where: { id: { eq: timerId } },
                }),
            );
            expect(beforeTimer?.state).toBe(state);
            expect(
              await db
                .select()
                .from(timeEntries)
                .where(eq(timeEntries.workspaceId, fixture.workspaceId)),
            ).toHaveLength(0);
            let auditCount = 0;
            const result = await Result.gen(() =>
              archiveWorkspaceHandler({
                safeDb: archiverDb,
                workspaceId: fixture.workspaceId,
                recordAuditEvent: async () => {
                  auditCount += 1;
                },
              }),
            );
            expect(Result.isError(result)).toBe(blocked);
            if (blocked) {
              expect(result).toMatchObject({
                error: {
                  status: 409,
                  message: "Stop active timers before archiving this matter",
                },
              });
            }
            const workspace = await db.query.workspaces.findFirst({
              where: { id: { eq: fixture.workspaceId } },
            });
            expect(workspace?.status).toBe(blocked ? "active" : "archived");
            expect(auditCount).toBe(blocked ? 0 : 1);
            expect(
              await timerDb(
                async (tx) =>
                  await tx.query.timeTimers.findFirst({
                    where: { id: { eq: timerId } },
                  }),
              ),
            ).toEqual(beforeTimer);
          } finally {
            await fixture.cleanup();
            await db.delete(user).where(eq(user.id, colleagueId));
          }
        });
      },
    );

    test("archive sees a timer committed while it waits on the lifecycle fence", async () => {
      await againstCap({
        acquireParent: async (tx, fixture) => {
          await lockWorkspaceLifecycle(tx, fixture.workspaceId);
          await createScopedDb(
            markRlsDatabase(tx),
            [fixture.workspaceId],
            fixture.organizationId,
            fixture.userId,
          )(async (timerTx) => {
            const startedAt = new Date("2026-10-11T09:00:00.000Z");
            await timerTx.insert(timeTimers).values({
              id: createSafeId<"timeTimer">(),
              organizationId: fixture.organizationId,
              userId: fixture.userId,
              workspaceId: fixture.workspaceId,
              state: "running",
              startedAt,
              lastResumedAt: startedAt,
            });
          });
        },
        run: async (tx, fixture) => {
          let auditCount = 0;
          const result = await Result.gen(() =>
            archiveWorkspaceHandler({
              safeDb: archiveSafeDbIn(tx, fixture),
              workspaceId: fixture.workspaceId,
              recordAuditEvent: async () => {
                auditCount += 1;
              },
            }),
          );
          expect(result).toMatchObject({
            error: {
              status: 409,
              message: "Stop active timers before archiving this matter",
            },
          });
          expect(auditCount).toBe(0);
          expect(
            await tx.query.workspaces.findFirst({
              where: { id: { eq: fixture.workspaceId } },
            }),
          ).toMatchObject({ status: "active" });
        },
      });
    });

    test("canonical version writes wait before locking the entity", async () => {
      await againstCap({
        run: async (tx, fixture) => {
          const result = await writeFileVersion({
            authority: CALLER_AUTHORIZED,
            tx,
            organizationId: fixture.organizationId,
            workspaceId: fixture.workspaceId,
            entityId: fixture.entityId,
            userId: fixture.userId,
            recordAuditEvent,
            entityVersionId: createSafeId<"entityVersion">(),
            fieldId: createSafeId<"field">(),
            fileId: allocateFileObject(),
            fileName: "replacement.docx",
            mimeType: DOCX_MIME_TYPE,
            encryption: officeFileEncryption(DOCX_MIME_TYPE),
            sizeBytes: 10,
            sha256Hex: fixture.sha256Hex,
            source: UPLOAD_DOCUMENT_SOURCE,
            writePolicy: { type: "replace-current-file" },
          });
          expect(result.status).toBe("ok");
        },
      });
    });

    test("file-property version writes acquire UPDATE before the entity", async () => {
      await againstCap({
        workspaceMode: "update",
        run: async (tx, fixture) => {
          const result = await writeFileVersion({
            authority: CALLER_AUTHORIZED,
            tx,
            organizationId: fixture.organizationId,
            workspaceId: fixture.workspaceId,
            entityId: fixture.entityId,
            userId: fixture.userId,
            recordAuditEvent,
            entityVersionId: createSafeId<"entityVersion">(),
            fieldId: createSafeId<"field">(),
            fileId: allocateFileObject(),
            fileName: "replacement.docx",
            mimeType: DOCX_MIME_TYPE,
            encryption: officeFileEncryption(DOCX_MIME_TYPE),
            sizeBytes: 10,
            sha256Hex: fixture.sha256Hex,
            source: UPLOAD_DOCUMENT_SOURCE,
            writePolicy: {
              type: "pdf-signature",
              expectedCurrentVersionId: fixture.versionId,
              filePropertyId: fixture.propertyId,
            },
          });
          expect(result.status).toBe("ok");
        },
      });
    });

    test("upload finalization waits before locking the pending upload", async () => {
      await againstCap({
        prepareFixture: async (db, fixture) => {
          await db
            .update(entities)
            .set({ readOnly: true })
            .where(eq(entities.id, fixture.entityId));
        },
        run: async (tx, fixture) => {
          const bytes = new ArrayBuffer(10);
          const result = await Result.gen(() =>
            finalizeEntityVersion({
              safeDb: transactionSafeDb(tx),
              recordAuditEvent,
              organizationId: fixture.organizationId,
              workspaceId: fixture.workspaceId,
              userId: fixture.userId,
              fileBuffer: bytes,
              declaredName: "replacement.txt",
              declaredMime: "text/plain",
              declaredSize: 10,
              declaredSha256Hex: fixture.sha256Hex,
              purposeData: {
                type: "entity_version",
                entityId: fixture.entityId,
              },
              scanned: testScannedFile({ bytes, mimeType: "text/plain" }),
              scanWarnings: undefined,
              uploadId: fixture.uploadId,
              claimRequestId: "version-lock-claim",
              promoteTmpObject: async () =>
                Result.ok({
                  intentId: createSafeId<"pendingUpload">(),
                  cleanup: async () => undefined,
                }),
            }),
          );
          expect(Result.isError(result)).toBe(true);
          expect(result).toMatchObject({
            error: { rejectReason: "entity-read-only" },
          });
        },
      });
    });

    test("publication holds UPDATE before acquiring its room", async () => {
      await againstCap({
        workspaceMode: "update",
        run: async (tx, fixture) => {
          const result = await publishCheckpointInTransaction({
            tx,
            body: {
              roomId: fixture.roomId,
              expectedGeneration: 1,
              expectedSha256Hex: fixture.sha256Hex,
              idempotencyKey: Bun.randomUUIDv7(),
            },
            checkpointKey: "fixture-checkpoint",
            checkpointRoom: fixture.checkpointRoom,
            organizationId: fixture.organizationId,
            recordAuditEvent,
            source: {
              cleanupIntentId: createSafeId<"pendingUpload">(),
              fileId: allocateFileObject(),
              key: "fixture-source",
              organizationId: fixture.organizationId,
            },
            storedSha256Hex: fixture.sha256Hex,
            storedSizeBytes: 10,
            userId: fixture.userId,
            workspaceId: fixture.workspaceId,
          });
          expect(result.status).toBe("checkpoint-changed");
        },
      });
    });

    test("archive waits on the cap parent before checking activity", async () => {
      await againstCap({
        workspaceMode: "update",
        run: async (tx, fixture) => {
          const result = await Result.gen(() =>
            archiveWorkspaceHandler({
              safeDb: archiveSafeDbIn(tx, fixture),
              workspaceId: fixture.workspaceId,
              recordAuditEvent,
            }),
          );
          expect(result).toEqual(Result.ok({ success: true }));
          expect(
            (
              await tx
                .select({ status: workspaces.status })
                .from(workspaces)
                .where(eq(workspaces.id, fixture.workspaceId))
            ).at(0)?.status,
          ).toBe("archived");
        },
      });
    });
  });
}
