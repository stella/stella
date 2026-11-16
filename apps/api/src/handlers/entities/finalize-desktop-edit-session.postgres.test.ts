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

import { rejectionOf } from "@stll/property-testing/rejection";
import { createTestClock } from "@stll/test-kit";

import { member, organization, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import {
  desktopEditSessions,
  entities,
  entityVersions,
  fields,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId } from "@/api/lib/branded-types";
import { hashDesktopEditSessionToken } from "@/api/lib/desktop-edit-sessions";
import { createFileKey } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { OBJECT_READ_TIMEOUT_MS, S3ObjectBudgetError } from "@/api/lib/s3";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import {
  responseByteFile,
  responseByteStream,
} from "@/api/tests/helpers/response-byte-stream";

import { finalizeDesktopEditSessionHandler } from "./finalize-desktop-edit-session";

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
