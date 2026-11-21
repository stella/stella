import { panic, Result } from "better-result";
import { Queue } from "bullmq";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import {
  REALTIME_EVENT_TYPE,
  RESOURCE_TYPE,
  resourceRef,
  resourceUpdatedRealtimeEvent,
} from "@stll/api-contract";
import { markdownToStellaDocx } from "@stll/docx-authoring/markdown";
import { rejectionOf } from "@stll/property-testing/rejection";
import { sha256Hex } from "@stll/sha256/node";
import { createTestClock, settledWithin } from "@stll/test-kit";

import { member, organization, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import {
  auditLogs,
  bufferObjectCleanupIntents,
  desktopEditSessions,
  documentProcessingRuns,
  entities,
  entityVersions,
  fields,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { HttpStatusResponse } from "@/api/http/status";
import * as auditOwner from "@/api/lib/audit-log";
import { realtimeAuthorizers } from "@/api/lib/auth";
import { createSafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import * as auditInsertionOwner from "@/api/lib/db/audit-recording";
import { hashDesktopEditSessionToken } from "@/api/lib/desktop-edit-sessions";
import * as enqueueOwner from "@/api/lib/document-processing-enqueue";
import * as diffOwner from "@/api/lib/entity-versions/compute-version-diff";
import * as derivativeOwner from "@/api/lib/file-derivative-queue";
import { createFileKey } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import {
  createBullMqConnection,
  createRedisClient,
} from "@/api/lib/redis-client";
import { OBJECT_READ_TIMEOUT_MS, S3ObjectBudgetError } from "@/api/lib/s3";
import { requestNativeExtractionRun } from "@/api/lib/search/process-extraction";
import { startSse, stopSse } from "@/api/lib/sse";
import {
  createSseBroadcastPublisher,
  parseRedisPayload,
  REDIS_CHANNEL,
} from "@/api/lib/sse-broadcast";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import {
  responseByteFile,
  responseByteStream,
} from "@/api/tests/helpers/response-byte-stream";
import { storedDocumentConsumerFixture } from "@/api/tests/helpers/stored-document-consumer";
import { HAPPY_PATH_TIMEOUT_MS } from "@/api/tests/test-timeouts";

import { finalizeDesktopEditSessionHandler } from "./finalize-desktop-edit-session";
import releaseDesktopEditLock from "./release-desktop-edit-lock";

const clock = createTestClock();

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)(
  "desktop checkpoint storage read on PostgreSQL",
  () => {
    beforeEach(() => setSystemTime(new Date(clock.now())));
    afterEach(() => setSystemTime());
    const ids = {
      orgA: mintAuthProviderId<"organization">(),
      userA1: mintAuthProviderId<"user">(),
      wsA1: createSafeId<"workspace">(),
      entityA1: createSafeId<"entity">(),
      entityVersionA1: createSafeId<"entityVersion">(),
      filePropertyA1: createSafeId<"property">(),
    };
    beforeAll(async () => {
      await rootDb.insert(user).values({
        id: ids.userA1,
        name: "Checkpoint reader",
        email: `${ids.userA1}@example.test`,
      });
      await rootDb.insert(organization).values({
        id: ids.orgA,
        name: "Checkpoint storage",
        slug: `checkpoint-${ids.orgA}`,
        createdAt: new Date(clock.now()),
      });
      await recordNewOrganizationAccessState(rootDb, {
        organizationId: ids.orgA,
        now: new Date(clock.now()),
      });
      await rootDb.insert(member).values({
        id: mintAuthProviderIdValue(),
        organizationId: ids.orgA,
        userId: ids.userA1,
        role: "owner",
        createdAt: new Date(clock.now()),
      });
      await rootDb.insert(workspaces).values({
        id: ids.wsA1,
        organizationId: ids.orgA,
        name: "Checkpoint storage",
        reference: "CHECKPOINT-1",
        status: "active",
      });
      await rootDb.insert(workspaceMembers).values({
        id: createSafeId<"workspaceMember">(),
        workspaceId: ids.wsA1,
        userId: ids.userA1,
      });
      await rootDb.insert(entities).values({
        id: ids.entityA1,
        workspaceId: ids.wsA1,
        kind: "document",
        name: "Checkpoint document",
      });
      await rootDb.insert(entityVersions).values({
        id: ids.entityVersionA1,
        entityId: ids.entityA1,
        workspaceId: ids.wsA1,
      });
      await rootDb
        .update(entities)
        .set({ currentVersionId: ids.entityVersionA1 })
        .where(eq(entities.id, ids.entityA1));
      await rootDb.insert(properties).values({
        id: ids.filePropertyA1,
        workspaceId: ids.wsA1,
        name: "Document",
        content: { version: 1, type: "file" },
        tool: { version: 1, type: "manual-input" },
        status: "fresh",
      });
      await rootDb.insert(fields).values({
        id: createSafeId<"field">(),
        workspaceId: ids.wsA1,
        propertyId: ids.filePropertyA1,
        entityVersionId: ids.entityVersionA1,
        content: {
          version: 1,
          type: "file",
          id: createSafeId<"userFile">(),
          fileName: "document.docx",
          mimeType: DOCX_MIME_TYPE,
          sizeBytes: 1,
          encrypted: false,
          sha256Hex: "a".repeat(64),
          pdfFileId: null,
        },
      });
    });
    afterAll(async () => {
      await deleteOrganizationsForTest(rootDb, [ids.orgA]);
      await rootDb.delete(user).where(eq(user.id, ids.userA1));
    });

    test.each([
      "oversized",
      "undeclared-oversized",
      "invalid-archive",
      "deadline",
      "caller-abort",
    ] as const)(
      "a %s checkpoint cannot publish a desktop edit or retire its checkpoint",
      async (kind) => {
        const sessionId = createSafeId<"desktopEditSession">();
        const checkpointFileId = createSafeId<"userFile">();
        const sessionToken = `${sessionId}${sessionId}`.replaceAll("-", "");
        const byteLength =
          kind === "oversized" || kind === "undeclared-oversized"
            ? FILE_SIZE_LIMIT_BYTES.multipartDocument + 1
            : 1;
        using bodyFile = responseByteFile(byteLength);
        const checkpointKey = createFileKey({
          fileId: checkpointFileId,
          mimeType: DOCX_MIME_TYPE,
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
        });
        const store = startFakeS3({
          readResponse: ({ headers }) => {
            const responseHeaders = new Headers(headers);
            if (kind === "undeclared-oversized") {
              responseHeaders.delete("content-length");
            } else {
              responseHeaders.set("content-length", String(byteLength));
            }
            return new Response(
              kind === "undeclared-oversized"
                ? responseByteStream(byteLength).body
                : bodyFile.body,
              {
                headers: responseHeaders,
              },
            );
          },
        });
        store.put(
          envBase.S3_BUCKET,
          checkpointKey,
          new Uint8Array(1),
          DOCX_MIME_TYPE,
        );
        const caller = new AbortController();
        const deadline = new AbortController();
        const hold =
          kind === "deadline" || kind === "caller-abort"
            ? store.holdNext({ method: "GET", keyIncludes: checkpointKey })
            : null;
        const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
        const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(
          (milliseconds) =>
            milliseconds === OBJECT_READ_TIMEOUT_MS
              ? deadline.signal
              : originalTimeout(milliseconds),
        );
        try {
          await rootDb.insert(desktopEditSessions).values({
            id: sessionId,
            workspaceId: ids.wsA1,
            entityId: ids.entityA1,
            propertyId: ids.filePropertyA1,
            baseVersionId: ids.entityVersionA1,
            createdBy: ids.userA1,
            fileType: "docx",
            fileName: "checkpoint.docx",
            checkpointFileId,
            checkpointSha256Hex: "b".repeat(64),
            checkpointSizeBytes: 1,
            checkpointUpdatedAt: new Date(clock.now()),
            sessionTokenHash: hashDesktopEditSessionToken(sessionToken),
            tokenExpiresAt: new Date(clock.now() + 60_000),
          });
          const finalize = finalizeDesktopEditSessionHandler({
            body: { sessionToken },
            sessionId,
            request: new Request("http://localhost/desktop-edit/finalize", {
              signal: AbortSignal.any([
                caller.signal,
                AbortSignal.timeout(5000),
              ]),
            }),
            server: null,
          });
          if (hold !== null) {
            const failure = rejectionOf(finalize);
            try {
              await hold.reached;
              expect(timeoutSpy.mock.calls).toContainEqual([
                OBJECT_READ_TIMEOUT_MS,
              ]);
              (kind === "deadline" ? deadline : caller).abort();
              hold.release();
              expect(await failure).toMatchObject({ name: "AbortError" });
            } finally {
              caller.abort();
              hold.release();
              await failure;
            }
          } else if (kind === "invalid-archive") {
            const result = await finalize;
            expect(result).toBeInstanceOf(HttpStatusResponse);
            if (result instanceof HttpStatusResponse) {
              expect(result.code).toBe(422);
            }
          } else if (kind === "oversized") {
            expect(await rejectionOf(finalize)).toBeInstanceOf(
              S3ObjectBudgetError,
            );
          } else {
            expect(await rejectionOf(finalize)).toMatchObject({
              _tag: "S3ObjectReadError",
              message: expect.stringContaining("declared no usable length"),
            });
          }
          expect(
            store.requests.filter(({ method }) => method === "GET"),
          ).toHaveLength(1);
          expect(store.requests.every(({ method }) => method === "GET")).toBe(
            true,
          );
          expect(
            await rootDb
              .select({
                status: desktopEditSessions.status,
                finalizedVersionId: desktopEditSessions.finalizedVersionId,
              })
              .from(desktopEditSessions)
              .where(eq(desktopEditSessions.id, sessionId)),
          ).toEqual([{ status: "open", finalizedVersionId: null }]);
          expect(
            await rootDb
              .select({ currentVersionId: entities.currentVersionId })
              .from(entities)
              .where(eq(entities.id, ids.entityA1)),
          ).toEqual([{ currentVersionId: ids.entityVersionA1 }]);
          expect(
            await rootDb
              .select({ id: entityVersions.id })
              .from(entityVersions)
              .where(eq(entityVersions.entityId, ids.entityA1)),
          ).toEqual([{ id: ids.entityVersionA1 }]);
          expect(
            store.objects.has(`${envBase.S3_BUCKET}/${checkpointKey}`),
          ).toBe(true);
        } finally {
          caller.abort();
          hold?.release();
          timeoutSpy.mockRestore();
          try {
            await rootDb
              .delete(desktopEditSessions)
              .where(eq(desktopEditSessions.id, sessionId));
          } finally {
            store.stop();
          }
        }
      },
    );
  },
);

type DesktopCloseKind =
  | "released"
  | "no_checkpoint"
  | "base_version_diverged"
  | "checkpoint_matches_base"
  | "finalized";

const prepareDesktopClose = async (kind: DesktopCloseKind) => {
  const f = storedDocumentConsumerFixture();
  const store = startFakeS3();
  try {
    await f.seed();
    const document = await f.addDocument({
      fileName: "Review.docx",
      mimeType: DOCX_MIME_TYPE,
    });
    const base = new Uint8Array(
      Result.unwrap(
        await markdownToStellaDocx("# Review\n\nOriginal document."),
      ),
    );
    const changed = new Uint8Array(
      Result.unwrap(
        await markdownToStellaDocx("# Review\n\nUpdated document."),
      ),
    );
    const baseHash = sha256Hex(base);
    const checkpoint = kind === "checkpoint_matches_base" ? base : changed;
    const field = await rootDb.query.fields.findFirst({
      where: { id: { eq: document.fieldId } },
    });
    if (!field || field.content.type !== "file") {
      return panic("Desktop close fixture requires its file field");
    }
    await rootDb
      .update(fields)
      .set({
        content: {
          ...field.content,
          sizeBytes: base.byteLength,
          sha256Hex: baseHash,
        },
      })
      .where(eq(fields.id, document.fieldId));
    store.put(
      envBase.S3_BUCKET,
      document.key,
      new Uint8Array(base),
      DOCX_MIME_TYPE,
    );
    const sessionId = createSafeId<"desktopEditSession">();
    const checkpointFileId = createSafeId<"userFile">();
    const checkpointKey = createFileKey({
      fileId: checkpointFileId,
      mimeType: DOCX_MIME_TYPE,
      organizationId: f.organizationId,
      workspaceId: f.workspaceId,
    });
    if (kind !== "no_checkpoint") {
      store.put(
        envBase.S3_BUCKET,
        checkpointKey,
        new Uint8Array(checkpoint),
        DOCX_MIME_TYPE,
      );
    }
    const token = `${sessionId}${sessionId}`.replaceAll("-", "");
    await rootDb.insert(desktopEditSessions).values({
      id: sessionId,
      workspaceId: f.workspaceId,
      entityId: document.entityId,
      propertyId: field.propertyId,
      baseVersionId: document.entityVersionId,
      createdBy: f.userId,
      fileType: "docx",
      fileName: "Review.docx",
      checkpointFileId,
      checkpointSha256Hex:
        kind === "no_checkpoint" ? null : sha256Hex(checkpoint),
      checkpointSizeBytes:
        kind === "no_checkpoint" ? null : checkpoint.byteLength,
      checkpointUpdatedAt:
        kind === "no_checkpoint" ? null : new Date(clock.now()),
      sessionTokenHash: hashDesktopEditSessionToken(token),
      tokenExpiresAt: new Date(clock.now() + 60_000),
      createdAt: new Date(clock.now()),
    });
    let originalCurrentVersionId = document.entityVersionId;
    if (kind === "base_version_diverged") {
      originalCurrentVersionId = createSafeId<"entityVersion">();
      await rootDb.insert(entityVersions).values({
        id: originalCurrentVersionId,
        entityId: document.entityId,
        workspaceId: f.workspaceId,
        versionNumber: 2,
      });
      await rootDb
        .update(entities)
        .set({ currentVersionId: originalCurrentVersionId })
        .where(eq(entities.id, document.entityId));
    }
    return {
      f,
      document,
      sessionId,
      propertyId: field.propertyId,
      checkpointKey,
      store,
      originalCurrentVersionId,
      finalize: async () =>
        await finalizeDesktopEditSessionHandler({
          sessionId,
          body: { sessionToken: token },
          request: new Request("http://localhost/desktop-edit/finalize", {
            method: "POST",
          }),
          server: null,
        }),
      release: async () =>
        await releaseDesktopEditLock.handler(
          createTestHandlerContext<
            Parameters<typeof releaseDesktopEditLock.handler>[0]
          >({
            safeDb: f.safeDb,
            scopedDb: f.scopedDb,
            audit: f.recordAuditEvent,
            workspaceId: f.workspaceId,
            session: { activeOrganizationId: f.organizationId },
            user: { id: f.userId },
            body: { entityId: document.entityId, propertyId: field.propertyId },
          }),
        ),
      read: async () => {
        const session =
          (await rootDb.query.desktopEditSessions.findFirst({
            where: { id: { eq: sessionId } },
          })) ?? panic("Desktop fixture session is missing");
        const entity =
          (await rootDb.query.entities.findFirst({
            where: { id: { eq: document.entityId } },
          })) ?? panic("Desktop fixture entity is missing");
        const versionId =
          entity.currentVersionId ??
          panic("Desktop fixture current version is missing");
        return {
          session,
          entity,
          version: await rootDb.query.entityVersions.findFirst({
            where: { id: { eq: versionId } },
          }),
          file: await rootDb.query.fields.findFirst({
            where: {
              entityVersionId: { eq: versionId },
              propertyId: { eq: field.propertyId },
            },
          }),
          versions: await rootDb
            .select({ id: entityVersions.id })
            .from(entityVersions)
            .where(eq(entityVersions.entityId, document.entityId)),
          audits: await rootDb
            .select()
            .from(auditLogs)
            .where(eq(auditLogs.workspaceId, f.workspaceId)),
          native: await rootDb
            .select()
            .from(documentProcessingRuns)
            .where(eq(documentProcessingRuns.entityId, document.entityId)),
          intents: await rootDb
            .select()
            .from(bufferObjectCleanupIntents)
            .where(eq(bufferObjectCleanupIntents.workspaceId, f.workspaceId)),
        };
      },
      dispose: async () => {
        try {
          await f.dispose();
        } finally {
          store.stop();
        }
      },
    };
  } catch (error) {
    try {
      await f.dispose();
    } finally {
      store.stop();
    }
    throw error;
  }
};

type DesktopCloseFixture = Awaited<ReturnType<typeof prepareDesktopClose>>;
type DesktopPublication = Extract<
  NonNullable<ReturnType<typeof parseRedisPayload>>,
  { scope: "workspace" | "session" }
>;

const observeDesktopPublications = async (fixture: DesktopCloseFixture) => {
  const subscriber = createRedisClient({ storeClass: "cache" });
  const publisherClient = createRedisClient({ storeClass: "cache" });
  const publisher = createSseBroadcastPublisher({
    createClient: () => publisherClient,
  });
  const events: DesktopPublication[] = [];
  const markerId = createSafeId<"entityVersion">();
  let barrier = Promise.withResolvers<undefined>();
  try {
    await publisherClient.connect();
    await subscriber.subscribe(REDIS_CHANNEL, (raw) => {
      const payload = parseRedisPayload(raw);
      if (!payload) {
        return;
      }
      if (
        payload.scope === "workspace" &&
        payload.id === fixture.f.workspaceId &&
        payload.event.type === REALTIME_EVENT_TYPE.RESOURCE_UPDATED &&
        payload.event.resource.id === markerId
      ) {
        barrier.resolve(undefined);
        return;
      }
      if (
        (payload.scope === "workspace" &&
          payload.id === fixture.f.workspaceId) ||
        (payload.scope === "session" && payload.id === fixture.sessionId)
      ) {
        events.push(payload);
      }
    });
    startSse(realtimeAuthorizers, { publisher });
    return {
      events,
      flush: async () => {
        barrier = Promise.withResolvers<undefined>();
        await publisher.publishWorkspaceEvent(
          fixture.f.workspaceId,
          resourceUpdatedRealtimeEvent(
            resourceRef({ type: RESOURCE_TYPE.ENTITY_VERSION, id: markerId }),
          ),
        );
        await settledWithin(barrier.promise, {
          description: "desktop close publication barrier",
          timeoutMs: HAPPY_PATH_TIMEOUT_MS,
        });
      },
      close: () => {
        stopSse();
        subscriber.close();
        publisherClient.close();
      },
    };
  } catch (error) {
    stopSse();
    publisherClient.close();
    subscriber.close();
    throw error;
  }
};

const expectedDesktopPublications = (
  fixture: DesktopCloseFixture,
  kind: DesktopCloseKind,
): DesktopPublication[] => {
  const workspace: DesktopPublication = {
    scope: "workspace",
    id: fixture.f.workspaceId,
    event: {
      type: REALTIME_EVENT_TYPE.RESOURCE_UPDATED,
      resource: { type: RESOURCE_TYPE.ENTITY, id: fixture.document.entityId },
    },
  };
  const closed: DesktopPublication = {
    scope: "session",
    id: fixture.sessionId,
    event: {
      type: REALTIME_EVENT_TYPE.DESKTOP_EDIT_SESSION_CLOSED,
      data: null,
    },
  };
  switch (kind) {
    case "released":
      return [
        {
          scope: "session",
          id: fixture.sessionId,
          event: {
            type: REALTIME_EVENT_TYPE.SESSION_CLOSED,
            data: { reason: "released" },
          },
        },
        closed,
        workspace,
      ];
    case "base_version_diverged":
      return [];
    case "no_checkpoint":
    case "checkpoint_matches_base":
    case "finalized":
      return [workspace, closed];
    default:
      kind satisfies never;
      return panic("Unhandled desktop publication fixture");
  }
};

/** Observe real background work through its existing callable boundary. */
const finalizeWithObservedTails = async (fixture: DesktopCloseFixture) => {
  type TailOutcome = { type: "success" } | { type: "failure"; error: unknown };
  const derivativeDone = Promise.withResolvers<TailOutcome>();
  const diffDone = Promise.withResolvers<TailOutcome>();
  const derivative = derivativeOwner.enqueuePdfDerivativeOrMarkFailed;
  const diff = diffOwner.computeVersionDiffStats;
  const derivativeSpy = spyOn(
    derivativeOwner,
    "enqueuePdfDerivativeOrMarkFailed",
  ).mockImplementation(async (options) => {
    try {
      await derivative(options);
      derivativeDone.resolve({ type: "success" });
    } catch (error) {
      derivativeDone.resolve({ type: "failure", error });
      throw error;
    }
  });
  const diffSpy = spyOn(
    diffOwner,
    "computeVersionDiffStats",
  ).mockImplementation(async (options) => {
    try {
      await diff(options);
      diffDone.resolve({ type: "success" });
    } catch (error) {
      diffDone.resolve({ type: "failure", error });
      throw error;
    }
  });
  try {
    const result = await fixture.finalize();
    if (
      !(result instanceof HttpStatusResponse) &&
      result.outcome === "finalized"
    ) {
      const outcomes = await settledWithin(
        Promise.all([derivativeDone.promise, diffDone.promise]),
        {
          description: "desktop finalized background completion",
          timeoutMs: HAPPY_PATH_TIMEOUT_MS,
        },
      );
      expect(outcomes).toEqual([{ type: "success" }, { type: "success" }]);
    }
    return result;
  } finally {
    derivativeSpy.mockRestore();
    diffSpy.mockRestore();
  }
};

const observeDesktopEnqueues = (fixture: DesktopCloseFixture) => {
  const enqueue = enqueueOwner.enqueueDocumentProcessingRun;
  const calls: Parameters<typeof enqueue>[0][] = [];
  const ownedIds = new Set<Parameters<typeof enqueue>[0]>();
  const connection = createBullMqConnection({
    storeClass: "durable-coordination",
  });
  const queue = Result.unwrap(
    Result.try(
      () =>
        new Queue<enqueueOwner.DocumentProcessingJobData>(
          enqueueOwner.DOCUMENT_PROCESSING_QUEUE_NAME,
          { connection },
        ),
    ).mapError((error) => {
      connection.disconnect();
      return error;
    }),
  );
  const spy = spyOn(
    enqueueOwner,
    "enqueueDocumentProcessingRun",
  ).mockImplementation(async (runId) => {
    calls.push(runId);
    await enqueue(runId);
  });
  const assertJob = async (runId: Parameters<typeof enqueue>[0]) => {
    const job = await queue.getJob(
      createBullMqJobId(enqueueOwner.DOCUMENT_PROCESSING_QUEUE_NAME, runId),
    );
    expect(job?.data).toEqual({ runId });
    expect(job?.name).toBe(enqueueOwner.DOCUMENT_PROCESSING_OCR_JOB_NAME);
    expect(await job?.getState()).toBe("waiting");
  };
  return {
    calls,
    assertJob,
    own: (runId: Parameters<typeof enqueue>[0]) => ownedIds.add(runId),
    addUnrelated: async () => {
      const document = await fixture.f.addDocument({
        fileName: "Independent.docx",
        mimeType: DOCX_MIME_TYPE,
      });
      const runId = await rootDb.transaction(async (tx) =>
        requestNativeExtractionRun({ entityId: document.entityId, tx }),
      );
      if (!runId) {
        return panic("Independent desktop fixture requires a native run");
      }
      ownedIds.add(runId);
      await enqueue(runId);
      await assertJob(runId);
      return runId;
    },
    close: async () => {
      spy.mockRestore();
      try {
        const state = await fixture.read();
        for (const run of state.native) {
          ownedIds.add(run.id);
        }
        for (const runId of ownedIds) {
          const job = await queue.getJob(
            createBullMqJobId(
              enqueueOwner.DOCUMENT_PROCESSING_QUEUE_NAME,
              runId,
            ),
          );
          await job?.remove();
        }
      } finally {
        try {
          await queue.close();
        } finally {
          connection.disconnect();
        }
      }
    },
  };
};

describe.skipIf(!enabled)("desktop close transition ownership", () => {
  beforeEach(() => setSystemTime(new Date(clock.now())));
  afterEach(() => setSystemTime());
  for (const kind of [
    "released",
    "no_checkpoint",
    "base_version_diverged",
    "checkpoint_matches_base",
    "finalized",
  ] as const) {
    test(`${kind} preserves close state, audit and repeat outcome`, async () => {
      const fixture = await prepareDesktopClose(kind);
      let enqueues: ReturnType<typeof observeDesktopEnqueues> | undefined;
      let publications:
        Awaited<ReturnType<typeof observeDesktopPublications>> | undefined;
      try {
        enqueues = observeDesktopEnqueues(fixture);
        publications = await observeDesktopPublications(fixture);
        const result =
          kind === "released"
            ? await fixture.release()
            : await finalizeWithObservedTails(fixture);
        const state = await fixture.read();
        expect(state.session.status).toBe(
          kind === "finalized" ? "finalized" : "cancelled",
        );
        expect(state.session.closedAt).toEqual(new Date(clock.now()));
        expect(state.intents).toEqual([]);
        if (kind === "released") {
          expect(result).toEqual({ released: true });
        } else if (kind === "base_version_diverged") {
          expect(result).toBeInstanceOf(HttpStatusResponse);
          if (result instanceof HttpStatusResponse) {
            expect(result.code).toBe(409);
            expect(result.response).toMatchObject({
              message:
                "This file changed in stella while you were editing. Your local copy is preserved.",
            });
          }
        } else {
          expect(result).toMatchObject({
            outcome: kind === "finalized" ? "finalized" : "no_changes",
          });
        }
        if (kind === "finalized") {
          expect(state.versions).toHaveLength(2);
          expect(state.session.finalizedVersionId).toBe(
            state.entity.currentVersionId,
          );
          expect(state.entity.currentVersionId).not.toBe(
            fixture.document.entityVersionId,
          );
          expect(state.native).toHaveLength(1);
          const runId =
            state.native.at(0)?.id ??
            panic("Finalized fixture requires its native run");
          enqueues.own(runId);
          expect(enqueues.calls).toEqual([runId]);
          await enqueues.assertJob(runId);
          expect(state.file?.content).toMatchObject({
            type: "file",
            mimeType: DOCX_MIME_TYPE,
            encrypted: false,
            pdfFileId: null,
            pdfDerivative: { status: "not-required" },
          });
          expect(state.version?.diffWordsAdded).toBeGreaterThan(0);
          expect(state.version?.diffWordsRemoved).toBeGreaterThan(0);
          expect(state.audits).toHaveLength(3);
          expect(state.audits).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                resourceType: auditOwner.AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
                resourceId: state.session.finalizedVersionId,
              }),
              expect.objectContaining({
                resourceType: auditOwner.AUDIT_RESOURCE_TYPE.ENTITY,
                resourceId: fixture.document.entityId,
              }),
              expect.objectContaining({
                resourceType:
                  auditOwner.AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
                resourceId: fixture.sessionId,
                changes: {
                  status: { old: "open", new: "finalized" },
                  finalizedVersionId: {
                    old: null,
                    new: state.session.finalizedVersionId,
                  },
                },
              }),
            ]),
          );
        } else {
          expect(state.versions).toHaveLength(
            kind === "base_version_diverged" ? 2 : 1,
          );
          expect(state.entity.currentVersionId).toBe(
            fixture.originalCurrentVersionId,
          );
          expect(state.session.finalizedVersionId).toBeNull();
          expect(state.native).toEqual([]);
          expect(state.audits).toHaveLength(1);
          expect(state.audits.at(0)).toMatchObject({
            resourceType: auditOwner.AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
            resourceId: fixture.sessionId,
            metadata: {
              reason: kind === "released" ? "released_by_user" : kind,
            },
            changes: { status: { old: "open", new: "cancelled" } },
          });
        }
        await publications.flush();
        const expected = expectedDesktopPublications(fixture, kind);
        expect(
          publications.events.map(({ scope, id, event }) => ({
            scope,
            id,
            event,
          })),
        ).toEqual(expected);
        if (kind !== "finalized") {
          expect(enqueues.calls).toEqual([]);
        }
        const unrelatedRunId =
          kind === "no_checkpoint" ? await enqueues.addUnrelated() : undefined;
        const beforeDuplicate = [...enqueues.calls];
        const again =
          kind === "released"
            ? await fixture.release()
            : await fixture.finalize();
        if (kind === "released") {
          expect(again).toEqual({ released: false });
        } else {
          expect(again).toBeInstanceOf(HttpStatusResponse);
          if (again instanceof HttpStatusResponse) {
            expect(again.code).toBe(404);
            expect(again.response).toMatchObject({
              message: "Desktop edit session not found.",
            });
          }
        }
        await publications.flush();
        expect(
          publications.events.map(({ scope, id, event }) => ({
            scope,
            id,
            event,
          })),
        ).toEqual(expected);
        const repeated = await fixture.read();
        expect(repeated.audits).toEqual(state.audits);
        expect(repeated.versions).toEqual(state.versions);
        expect(enqueues.calls).toEqual(beforeDuplicate);
        if (unrelatedRunId) {
          await enqueues.assertJob(unrelatedRunId);
        }
      } finally {
        try {
          publications?.close();
        } finally {
          try {
            await enqueues?.close();
          } finally {
            await fixture.dispose();
          }
        }
      }
    });
  }

  test("a failed finalized audit rolls back the real close and its published object", async () => {
    const fixture = await prepareDesktopClose("finalized");
    let enqueues: ReturnType<typeof observeDesktopEnqueues> | undefined;
    let publications:
      Awaited<ReturnType<typeof observeDesktopPublications>> | undefined;
    const recordGroups = auditInsertionOwner.recordAuditGroups;
    const originalFailure = new Error("Desktop close audit fixture refusal");
    const recorded: Parameters<typeof recordGroups>[0][] = [];
    const auditSpy = spyOn(
      auditInsertionOwner,
      "recordAuditGroups",
    ).mockImplementation(async (options) => {
      await recordGroups(options);
      const ownedGroup = options.groups.find(
        ({ bindings, events }) =>
          bindings.organizationId === fixture.f.organizationId &&
          bindings.workspaceId === fixture.f.workspaceId &&
          bindings.userId === fixture.f.userId &&
          events.length === 3 &&
          events.some((entry) => entry.resourceId === fixture.sessionId),
      );
      if (ownedGroup) {
        recorded.push(options);
        throw originalFailure;
      }
    });
    try {
      enqueues = observeDesktopEnqueues(fixture);
      publications = await observeDesktopPublications(fixture);
      const failure = await rejectionOf(fixture.finalize());
      expect(failure).toBe(originalFailure);
      expect(recorded).toHaveLength(1);
      expect(recorded.at(0)?.groups.flatMap(({ events }) => events)).toEqual([
        expect.objectContaining({
          resourceType: auditOwner.AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
        }),
        expect.objectContaining({
          resourceType: auditOwner.AUDIT_RESOURCE_TYPE.ENTITY,
        }),
        expect.objectContaining({
          resourceType: auditOwner.AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
        }),
      ]);
      const state = await fixture.read();
      expect(state.session.status).toBe("open");
      expect(state.session.closedAt).toBeNull();
      expect(state.session.finalizedVersionId).toBeNull();
      expect(state.entity.currentVersionId).toBe(
        fixture.document.entityVersionId,
      );
      expect(state.versions).toEqual([
        { id: fixture.document.entityVersionId },
      ]);
      expect(state.native).toEqual([]);
      expect(enqueues.calls).toEqual([]);
      expect(state.audits).toEqual([]);
      expect(state.intents).toEqual([]);
      expect([...fixture.store.objects.keys()].toSorted()).toEqual(
        [
          `${envBase.S3_BUCKET}/${fixture.document.key}`,
          `${envBase.S3_BUCKET}/${fixture.checkpointKey}`,
        ].toSorted(),
      );
      await publications.flush();
      expect(publications.events).toEqual([]);
    } finally {
      auditSpy.mockRestore();
      try {
        publications?.close();
      } finally {
        try {
          await enqueues?.close();
        } finally {
          await fixture.dispose();
        }
      }
    }
  });
});
