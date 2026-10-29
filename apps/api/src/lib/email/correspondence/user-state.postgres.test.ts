import { panic } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { ParsedCorrespondence } from "@stll/api-contract/correspondence";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  correspondence,
  correspondenceAttachments,
  correspondenceFilers,
  correspondenceSources,
  entities,
  entityVersions,
  fields,
  legalReaderAnnotations,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import {
  createCorrespondence,
  retireCorrespondenceSource,
} from "@/api/lib/email/correspondence/create";
import { parseDataBoxMessage } from "@/api/lib/email/correspondence/data-box/zfo";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { zfoFile } from "@/api/tests/fixtures/zfo";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("correspondence user state (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(Boolean(databaseUrl) && enabled).toBe(false);
    });
  });
} else {
  describe("correspondence user state (postgres)", () => {
    const gated = openGatedTestDatabase(databaseUrl);
    const db = markRlsDatabase(gated.db);
    const organizationId = mintAuthProviderId<"organization">();
    const userId = mintAuthProviderId<"user">();
    const assigneeId = mintAuthProviderId<"user">();
    const workspaceId = createSafeId<"workspace">();
    const safeDb = createSafeDb(db, [workspaceId], organizationId, userId);
    const actorScopedDb = createScopedDb(
      db,
      [workspaceId],
      organizationId,
      userId,
    );
    const assigneeScopedDb = createScopedDb(
      db,
      [workspaceId],
      organizationId,
      assigneeId,
    );
    const recordAuditEvent = createBackgroundAuditRecorder({
      organizationId,
      workspaceId,
      userId,
      execution: {
        performer: { type: "user", id: userId },
        trigger: { type: "system", source: "correspondence_state_test" },
      },
    });
    gated.cleanUp(async () => {
      await db.delete(organization).where(eq(organization.id, organizationId));
      for (const id of [userId, assigneeId]) {
        await db.delete(user).where(eq(user.id, id));
      }
    });
    beforeAll(async () => {
      await db.insert(user).values(
        [userId, assigneeId].map((id) => ({
          id,
          name: "Correspondence reviewer",
          email: `${id}@example.test`,
        })),
      );
      await db.insert(organization).values({
        id: organizationId,
        name: "Correspondence state fixture",
        slug: `correspondence-state-${organizationId}`,
        createdAt: new Date(),
      });
      await recordNewOrganizationAccessState(db, {
        organizationId,
        now: new Date(),
      });
      await db.insert(member).values(
        [userId, assigneeId].map((id) => ({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId: id,
          role: "owner",
          createdAt: new Date(),
        })),
      );
      await db.insert(workspaces).values({
        id: workspaceId,
        organizationId,
        name: "Correspondence state matter",
        reference: "CORRESPONDENCE-STATE",
      });
      await db.insert(workspaceMembers).values(
        [userId, assigneeId].map((id) => ({
          id: createSafeId<"workspaceMember">(),
          workspaceId,
          userId: id,
        })),
      );
    });

    const setupUpload = async (channel: "email" | "data_box") => {
      const entityId = createSafeId<"entity">();
      const attachmentId = createSafeId<"entity">();
      const replacementAttachmentId = createSafeId<"entity">();
      const attachmentPropertyId = createSafeId<"property">();
      const firstVersion = createSafeId<"entityVersion">();
      const secondVersion = createSafeId<"entityVersion">();
      const attachmentVersionId = createSafeId<"entityVersion">();
      const attachmentFieldId = createSafeId<"field">();
      const attachmentFileId = Bun.randomUUIDv7();
      await actorScopedDb(async (tx) => {
        await tx.insert(entities).values(
          [entityId, attachmentId, replacementAttachmentId].map((id) => ({
            id,
            workspaceId,
            name: "Reviewed source document",
            createdBy: userId,
          })),
        );
        await tx.insert(entityVersions).values([
          { id: firstVersion, workspaceId, entityId, versionNumber: 1 },
          { id: secondVersion, workspaceId, entityId, versionNumber: 2 },
          {
            id: attachmentVersionId,
            workspaceId,
            entityId: attachmentId,
            versionNumber: 1,
          },
        ]);
        await tx.insert(properties).values({
          id: attachmentPropertyId,
          workspaceId,
          name: "Evidence file",
          status: "fresh",
          content: { version: 1, type: "file" },
          tool: { version: 1, type: "manual-input" },
        });
        await tx.insert(fields).values({
          id: attachmentFieldId,
          workspaceId,
          entityVersionId: attachmentVersionId,
          propertyId: attachmentPropertyId,
          content: {
            version: 1,
            type: "file",
            id: attachmentFileId,
            fileName: "evidence.pdf",
            mimeType: "application/pdf",
            sizeBytes: 128,
            encrypted: false,
            sha256Hex: "d".repeat(64),
            pdfFileId: null,
          },
        });
        await tx
          .update(entities)
          .set({ currentVersionId: firstVersion })
          .where(eq(entities.id, entityId));
        await tx
          .update(entities)
          .set({ currentVersionId: attachmentVersionId })
          .where(eq(entities.id, attachmentId));
      });
      const parsedBox = parseDataBoxMessage(await zfoFile());
      if (parsedBox.isErr()) {
        throw parsedBox.error;
      }
      const common = {
        source: "upload" as const,
        sourceEntityId: entityId,
        originalSignature: { status: "unverified" as const },
        contentHash: "a".repeat(64),
        from: { address: "sender@example.test", name: null },
        to: [],
        cc: [],
        subject: "Original correspondence",
        sentAt: null,
        receivedAt: "2026-10-29T00:00:00.000Z",
        inReplyTo: null,
        references: [],
        bodyText: "Original body",
        bodyHtml: null,
      };
      const parsed =
        channel === "email"
          ? ({
              ...common,
              channel,
              dataBox: null,
              direction: "in" as const,
              messageId: "original@example.test",
            } satisfies ParsedCorrespondence)
          : ({
              ...common,
              channel,
              dataBox: parsedBox.value.envelope,
              direction: null,
              messageId: parsedBox.value.envelope.messageId,
            } satisfies ParsedCorrespondence);
      const attachment = {
        entityId: attachmentId,
        filename: "evidence.pdf",
        mediaType: "application/pdf",
        byteSize: 128,
        scanVerdict: "clean" as const,
      };
      const initial = await createCorrespondence({
        safeDb,
        organizationId,
        workspaceId,
        filer: { type: "user", userId },
        parsed,
        attachments: [attachment],
        expectedSourceVersionId: firstVersion,
        recordAuditEvent,
      });
      if (initial.type === "error") {
        throw initial.error;
      }
      if (initial.type !== "ok") {
        return panic(`Initial filing failed: ${initial.type}`);
      }
      await actorScopedDb(async (tx) => {
        await tx
          .update(correspondence)
          .set({ handlingState: "handled", assigneeId })
          .where(eq(correspondence.id, initial.id));
        await tx
          .update(entities)
          .set({
            name: "User-renamed attachment",
            status: "reviewed",
            priority: "high",
          })
          .where(eq(entities.id, attachmentId));
      });
      await assigneeScopedDb(async (tx) => {
        await tx.insert(correspondenceFilers).values({
          organizationId,
          workspaceId,
          correspondenceId: initial.id,
          filedByUserId: assigneeId,
          filedByDisplay: {
            status: "active",
            name: "Original filer",
            email: "filer@example.test",
          },
          filedAt: new Date("2026-10-28T00:00:00.000Z"),
        });
      });
      const annotationId = createSafeId<"legalReaderAnnotation">();
      const annotations = await actorScopedDb(async (tx) => {
        await tx.insert(legalReaderAnnotations).values({
          id: annotationId,
          organizationId,
          workspaceId,
          userId,
          targetType: "matter-document",
          targetId: attachmentFieldId,
          entityId: attachmentId,
          pageTextSha256: "c".repeat(64),
          kind: "comment",
          blockAnchorId: "page-1",
          startOffset: 0,
          endOffset: 8,
          quote: "Evidence",
          body: "Preserve this review comment",
        });
        return await tx
          .select()
          .from(legalReaderAnnotations)
          .where(eq(legalReaderAnnotations.entityId, attachmentId));
      });
      return {
        annotations,
        entityId,
        attachmentId,
        replacementAttachmentId,
        parsed,
        secondVersion,
        attachment,
        initial,
      };
    };

    test.each(["email", "data_box"] as const)(
      "%s content updates and retirement preserve user state until explicit source deletion",
      async (channel) => {
        const {
          annotations,
          entityId,
          attachmentId,
          replacementAttachmentId,
          parsed,
          secondVersion,
          attachment,
          initial,
        } = await setupUpload(channel);
        const { filers, original } = await actorScopedDb(async (tx) => ({
          filers: await tx
            .select()
            .from(correspondenceFilers)
            .where(eq(correspondenceFilers.correspondenceId, initial.id)),
          original: (
            await tx
              .select()
              .from(correspondence)
              .where(eq(correspondence.id, initial.id))
          ).at(0),
        }));
        expect(filers).toHaveLength(2);
        await actorScopedDb(async (tx) => {
          await tx
            .update(entities)
            .set({ currentVersionId: secondVersion })
            .where(eq(entities.id, entityId));
        });
        const changed = {
          ...parsed,
          contentHash: "b".repeat(64),
          subject: "Corrected correspondence",
          bodyText: "Corrected body",
        };
        const updated = await createCorrespondence({
          safeDb,
          organizationId,
          workspaceId,
          filer: { type: "user", userId },
          parsed: changed,
          attachments: [
            {
              ...attachment,
              entityId: replacementAttachmentId,
              filename: "replacement.pdf",
            },
          ],
          expectedSourceVersionId: secondVersion,
          recordAuditEvent,
        });
        expect(updated).toMatchObject({
          type: "ok",
          id: initial.id,
          created: false,
        });
        const retainedState = await actorScopedDb(async (tx) => {
          const record = await tx
            .select()
            .from(correspondence)
            .where(eq(correspondence.id, initial.id));
          const currentFilers = await tx
            .select()
            .from(correspondenceFilers)
            .where(eq(correspondenceFilers.correspondenceId, initial.id));
          const currentAttachments = await tx
            .select({ entityId: correspondenceAttachments.entityId })
            .from(correspondenceAttachments)
            .where(eq(correspondenceAttachments.correspondenceId, initial.id));
          const renamedAttachment = await tx
            .select({
              name: entities.name,
              status: entities.status,
              priority: entities.priority,
            })
            .from(entities)
            .where(eq(entities.id, attachmentId));
          const currentAnnotations = await tx
            .select()
            .from(legalReaderAnnotations)
            .where(eq(legalReaderAnnotations.entityId, attachmentId));
          return {
            record,
            filers: currentFilers,
            attachments: currentAttachments,
            renamedAttachment,
            annotations: currentAnnotations,
            sources: await tx
              .select()
              .from(correspondenceSources)
              .where(eq(correspondenceSources.correspondenceId, initial.id)),
            allAttachments: await tx
              .select()
              .from(correspondenceAttachments)
              .where(
                eq(correspondenceAttachments.correspondenceId, initial.id),
              ),
          };
        });
        expect(retainedState.record).toMatchObject([
          {
            id: initial.id,
            createdAt: original?.createdAt,
            handlingState: "handled",
            assigneeId,
            subject: changed.subject,
            bodyText: changed.bodyText,
            contentHash: changed.contentHash,
          },
        ]);
        expect(retainedState.filers).toEqual(filers);
        expect(retainedState.attachments).toEqual([
          { entityId: replacementAttachmentId },
        ]);
        expect(retainedState.renamedAttachment).toEqual([
          {
            name: "User-renamed attachment",
            status: "reviewed",
            priority: "high",
          },
        ]);
        expect(retainedState.annotations).toEqual(annotations);
        expect(
          await retireCorrespondenceSource({
            safeDb,
            organizationId,
            workspaceId,
            sourceEntityId: entityId,
            expectedSourceVersionId: secondVersion,
            recordAuditEvent,
          }),
        ).toMatchObject({ type: "ok" });
        await actorScopedDb(async (tx) => {
          expect(
            await tx
              .select()
              .from(correspondence)
              .where(eq(correspondence.id, initial.id)),
          ).toEqual(retainedState.record);
          expect(
            await tx
              .select()
              .from(correspondenceFilers)
              .where(eq(correspondenceFilers.correspondenceId, initial.id)),
          ).toEqual(filers);
          expect(
            await tx
              .select()
              .from(correspondenceSources)
              .where(eq(correspondenceSources.correspondenceId, initial.id)),
          ).toEqual(retainedState.sources);
          expect(
            await tx
              .select()
              .from(correspondenceAttachments)
              .where(
                eq(correspondenceAttachments.correspondenceId, initial.id),
              ),
          ).toEqual(retainedState.allAttachments);
          await tx.delete(entities).where(eq(entities.id, entityId));
          expect(
            await tx
              .select()
              .from(correspondence)
              .where(eq(correspondence.id, initial.id)),
          ).toEqual([]);
          expect(
            await tx
              .select()
              .from(correspondenceSources)
              .where(eq(correspondenceSources.correspondenceId, initial.id)),
          ).toEqual([]);
          expect(
            await tx
              .select()
              .from(correspondenceFilers)
              .where(eq(correspondenceFilers.correspondenceId, initial.id)),
          ).toEqual([]);
          expect(
            await tx
              .select()
              .from(correspondenceAttachments)
              .where(
                eq(correspondenceAttachments.correspondenceId, initial.id),
              ),
          ).toEqual([]);
          expect(
            await tx
              .select({ id: entities.id })
              .from(entities)
              .where(eq(entities.id, attachmentId)),
          ).toEqual([{ id: attachmentId }]);
          expect(
            await tx
              .select()
              .from(legalReaderAnnotations)
              .where(eq(legalReaderAnnotations.entityId, attachmentId)),
          ).toEqual(annotations);
        });
      },
    );
  });
}
