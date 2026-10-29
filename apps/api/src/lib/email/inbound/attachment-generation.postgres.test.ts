import { Result } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { ParsedCorrespondence } from "@stll/api-contract/correspondence";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  correspondenceAttachments,
  entities,
  entityVersions,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { createCorrespondence } from "@/api/lib/email/correspondence/create";
import { finishCorrespondenceAttachments } from "@/api/lib/email/inbound/persistence";
import type { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { lockWorkspaceForEntityCreate } from "@/api/lib/entity-cap-lock";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const generationChanges = [
  { name: "source version", changesVersion: true, changesHash: false },
  { name: "content hash", changesVersion: false, changesHash: true },
  {
    name: "source version and content hash",
    changesVersion: true,
    changesHash: true,
  },
] as const;

type AttachmentGeneration = Parameters<
  typeof finishCorrespondenceAttachments
>[0]["generation"];

const makeDocumentWriter =
  (
    entityId: ReturnType<typeof createSafeId<"entity">>,
    beforeWrite?: () => Promise<void>,
  ): typeof createEntityFromBuffer =>
  async ({
    scopedDb: writerScopedDb,
    workspaceId: targetWorkspaceId,
    userId: creatorId,
    fileName,
    afterCreate,
  }) => {
    await beforeWrite?.();
    const value = {
      entityId,
      entityVersionId: createSafeId<"entityVersion">(),
      fieldId: createSafeId<"field">(),
      fileName,
      renamed: false,
    };
    await writerScopedDb(async (tx) => {
      await lockWorkspaceForEntityCreate(tx, targetWorkspaceId);
      await tx.insert(entities).values({
        id: value.entityId,
        workspaceId: targetWorkspaceId,
        name: fileName,
        createdBy: creatorId,
      });
      await afterCreate?.(tx, value);
    });
    return Result.ok(value);
  };

if (!databaseUrl || !enabled) {
  describe.skip("correspondence attachment generation fencing", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(Boolean(databaseUrl) && enabled).toBe(false);
    });
  });
} else {
  describe("correspondence attachment generation fencing", () => {
    const gated = openGatedTestDatabase(databaseUrl);
    const db = markRlsDatabase(gated.db);
    const organizationId = mintAuthProviderId<"organization">();
    const userId = mintAuthProviderId<"user">();
    const workspaceId = createSafeId<"workspace">();
    const safeDb = createSafeDb(db, [workspaceId], organizationId, userId);
    const scopedDb = createScopedDb(db, [workspaceId], organizationId, userId);
    const recordAuditEvent = createBackgroundAuditRecorder({
      organizationId,
      workspaceId,
      userId,
      execution: {
        performer: { type: "user", id: userId },
        trigger: { type: "system", source: "attachment_generation_test" },
      },
    });

    gated.cleanUp(async () => {
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(eq(user.id, userId));
    });

    beforeAll(async () => {
      await db.insert(user).values({
        id: userId,
        name: "Attachment generation fixture",
        email: `${userId}@example.test`,
      });
      await db.insert(organization).values({
        id: organizationId,
        name: "Attachment generation fixture",
        slug: `attachment-generation-${organizationId}`,
        createdAt: new Date(),
      });
      await recordNewOrganizationAccessState(db, {
        organizationId,
        now: new Date(),
      });
      await db.insert(member).values({
        id: mintAuthProviderIdValue(),
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      });
      await db.insert(workspaces).values({
        id: workspaceId,
        organizationId,
        name: "Attachment generation matter",
        reference: "ATTACHMENT-GENERATION",
      });
      await db.insert(workspaceMembers).values({
        id: createSafeId<"workspaceMember">(),
        workspaceId,
        userId,
      });
    });

    test.each(generationChanges)(
      "rolls back an attachment writer after the $name changes",
      async ({ changesVersion, changesHash }) => {
        const sourceEntityId = createSafeId<"entity">();
        const version1 = createSafeId<"entityVersion">();
        const version2 = createSafeId<"entityVersion">();
        const initialHash = "a".repeat(64);
        const replacementHash = changesHash ? "b".repeat(64) : initialHash;
        const replacementVersion = changesVersion ? version2 : version1;
        await scopedDb(async (tx) => {
          await tx.insert(entities).values({
            id: sourceEntityId,
            workspaceId,
            name: "Uploaded correspondence source",
            createdBy: userId,
          });
          await tx.insert(entityVersions).values([
            {
              id: version1,
              workspaceId,
              entityId: sourceEntityId,
              versionNumber: 1,
            },
            {
              id: version2,
              workspaceId,
              entityId: sourceEntityId,
              versionNumber: 2,
            },
          ]);
          await tx
            .update(entities)
            .set({ currentVersionId: version1 })
            .where(eq(entities.id, sourceEntityId));
        });

        const correspondenceArgs = (
          contentHash: string,
          sourceVersionId: typeof version1,
        ) => {
          const hashLabel = contentHash === initialHash ? "a" : "b";
          return {
            safeDb,
            organizationId,
            workspaceId,
            filer: { type: "user" as const, userId },
            parsed: {
              source: "upload",
              sourceEntityId,
              originalSignature: { status: "unverified" },
              contentHash,
              from: { address: "sender@example.test", name: null },
              to: [],
              cc: [],
              subject: `Generation ${hashLabel}`,
              sentAt: null,
              receivedAt: "2026-10-29T00:00:00.000Z",
              inReplyTo: null,
              references: [],
              bodyText: `Body ${hashLabel}`,
              bodyHtml: null,
              channel: "email",
              dataBox: null,
              direction: "in",
              messageId: `${hashLabel}@example.test`,
            } satisfies ParsedCorrespondence,
            attachments: [],
            expectedSourceVersionId: sourceVersionId,
            recordAuditEvent,
          };
        };
        const initial = await createCorrespondence(
          correspondenceArgs(initialHash, version1),
        );
        if (initial.type !== "ok") {
          throw new Error(
            `Initial correspondence filing failed: ${initial.type}`,
          );
        }

        const writerEntered = Promise.withResolvers<undefined>();
        const resumeWriter = Promise.withResolvers<undefined>();
        const staleEntityId = createSafeId<"entity">();
        const createDocument = makeDocumentWriter(staleEntityId, async () => {
          writerEntered.resolve(undefined);
          await resumeWriter.promise;
        });
        const scannedFile = testScannedFile({
          bytes: new TextEncoder().encode("attachment content").buffer,
          mimeType: "text/plain",
          path: "attachment-generation.txt",
        });
        const oldGeneration: AttachmentGeneration = {
          type: "upload",
          sourceEntityId,
          sourceVersionId: version1,
          contentHash: initialHash,
        };
        const oldCompletion = finishCorrespondenceAttachments({
          correspondenceId: initial.id,
          scope: { organizationId, workspaceId, userId },
          scannedFiles: [scannedFile],
          scopedDb,
          recordAuditEvent,
          createDocument,
          parentId: null,
          generation: oldGeneration,
        });

        await writerEntered.promise;
        try {
          await scopedDb(async (tx) => {
            await tx
              .update(entities)
              .set({ currentVersionId: replacementVersion })
              .where(eq(entities.id, sourceEntityId));
          });
          const refreshed = await createCorrespondence(
            correspondenceArgs(replacementHash, replacementVersion),
          );
          if (refreshed.type !== "ok" || refreshed.id !== initial.id) {
            throw new Error(`Correspondence refresh failed: ${refreshed.type}`);
          }
        } finally {
          resumeWriter.resolve(undefined);
        }

        const completion = await oldCompletion;
        expect(completion.isErr()).toBe(true);
        expect(
          completion.isErr() ? completion.error.message : "attachment linked",
        ).toBe("Correspondence attachment generation changed");
        await scopedDb(async (tx) => {
          expect(
            await tx
              .select({ id: entities.id })
              .from(entities)
              .where(eq(entities.id, staleEntityId)),
          ).toEqual([]);
          expect(
            await tx
              .select({
                entityId: correspondenceAttachments.entityId,
                ordinal: correspondenceAttachments.ordinal,
              })
              .from(correspondenceAttachments)
              .where(
                eq(correspondenceAttachments.correspondenceId, initial.id),
              ),
          ).toEqual([]);
        });

        const currentGeneration: AttachmentGeneration = {
          type: "upload",
          sourceEntityId,
          sourceVersionId: replacementVersion,
          contentHash: replacementHash,
        };
        const currentEntityId = createSafeId<"entity">();
        const currentWriter = makeDocumentWriter(currentEntityId);
        const currentCompletion = await finishCorrespondenceAttachments({
          correspondenceId: initial.id,
          scope: { organizationId, workspaceId, userId },
          scannedFiles: [scannedFile],
          scopedDb,
          recordAuditEvent,
          createDocument: currentWriter,
          parentId: null,
          generation: currentGeneration,
        });
        expect(currentCompletion.isOk()).toBe(true);
        await scopedDb(async (tx) => {
          expect(
            await tx
              .select({
                entityId: correspondenceAttachments.entityId,
                ordinal: correspondenceAttachments.ordinal,
              })
              .from(correspondenceAttachments)
              .where(
                eq(correspondenceAttachments.correspondenceId, initial.id),
              ),
          ).toEqual([{ entityId: currentEntityId, ordinal: 0 }]);
        });
      },
    );
  });
}
