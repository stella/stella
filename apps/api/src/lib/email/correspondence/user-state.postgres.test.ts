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
  legalReaderAnnotations,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
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
      await db.insert(entities).values(
        [entityId, attachmentId, replacementAttachmentId].map((id) => ({
          id,
          workspaceId,
          name: "Reviewed source document",
          createdBy: userId,
        })),
      );
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
      const firstVersion = createSafeId<"entityVersion">();
      const secondVersion = createSafeId<"entityVersion">();
      await db.insert(entityVersions).values([
        { id: firstVersion, workspaceId, entityId, versionNumber: 1 },
        { id: secondVersion, workspaceId, entityId, versionNumber: 2 },
      ]);
      await db
        .update(entities)
        .set({ currentVersionId: firstVersion })
        .where(eq(entities.id, entityId));
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
      await db
        .update(correspondence)
        .set({ handlingState: "handled", assigneeId })
        .where(eq(correspondence.id, initial.id));
      await db.insert(correspondenceFilers).values({
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
      await db
        .update(entities)
        .set({
          name: "User-renamed attachment",
          status: "reviewed",
          priority: "high",
        })
        .where(eq(entities.id, attachmentId));
      const annotationId = createSafeId<"legalReaderAnnotation">();
      await db.insert(legalReaderAnnotations).values({
        id: annotationId,
        organizationId,
        workspaceId,
        userId,
        targetType: "matter-document",
        targetId: attachmentId,
        entityId: attachmentId,
        pageTextSha256: "c".repeat(64),
        kind: "comment",
        blockAnchorId: "page-1",
        startOffset: 0,
        endOffset: 8,
        quote: "Evidence",
        body: "Preserve this review comment",
      });
      const annotations = await db
        .select()
        .from(legalReaderAnnotations)
        .where(eq(legalReaderAnnotations.entityId, attachmentId));
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
        const filers = await db
          .select()
          .from(correspondenceFilers)
          .where(eq(correspondenceFilers.correspondenceId, initial.id));
        const [original] = await db
          .select()
          .from(correspondence)
          .where(eq(correspondence.id, initial.id));
        expect(filers).toHaveLength(2);
        await db
          .update(entities)
          .set({ currentVersionId: secondVersion })
          .where(eq(entities.id, entityId));
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
        expect(
          await db
            .select()
            .from(correspondence)
            .where(eq(correspondence.id, initial.id)),
        ).toMatchObject([
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
        expect(
          await db
            .select()
            .from(correspondenceFilers)
            .where(eq(correspondenceFilers.correspondenceId, initial.id)),
        ).toEqual(filers);
        expect(
          await db
            .select({ entityId: correspondenceAttachments.entityId })
            .from(correspondenceAttachments)
            .where(eq(correspondenceAttachments.correspondenceId, initial.id)),
        ).toEqual([{ entityId: replacementAttachmentId }]);
        expect(
          await db
            .select({
              name: entities.name,
              status: entities.status,
              priority: entities.priority,
            })
            .from(entities)
            .where(eq(entities.id, attachmentId)),
        ).toEqual([
          {
            name: "User-renamed attachment",
            status: "reviewed",
            priority: "high",
          },
        ]);
        expect(
          await db
            .select()
            .from(legalReaderAnnotations)
            .where(eq(legalReaderAnnotations.entityId, attachmentId)),
        ).toEqual(annotations);
        const retainedSources = await db
          .select()
          .from(correspondenceSources)
          .where(eq(correspondenceSources.correspondenceId, initial.id));
        const retainedAttachments = await db
          .select()
          .from(correspondenceAttachments)
          .where(eq(correspondenceAttachments.correspondenceId, initial.id));
        const beforeRetirement = await db
          .select()
          .from(correspondence)
          .where(eq(correspondence.id, initial.id));
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
        expect(
          await db
            .select()
            .from(correspondence)
            .where(eq(correspondence.id, initial.id)),
        ).toEqual(beforeRetirement);
        expect(
          await db
            .select()
            .from(correspondenceFilers)
            .where(eq(correspondenceFilers.correspondenceId, initial.id)),
        ).toEqual(filers);
        expect(
          await db
            .select()
            .from(correspondenceSources)
            .where(eq(correspondenceSources.correspondenceId, initial.id)),
        ).toEqual(retainedSources);
        expect(
          await db
            .select()
            .from(correspondenceAttachments)
            .where(eq(correspondenceAttachments.correspondenceId, initial.id)),
        ).toEqual(retainedAttachments);
        await db.delete(entities).where(eq(entities.id, entityId));
        expect(
          await db
            .select()
            .from(correspondence)
            .where(eq(correspondence.id, initial.id)),
        ).toEqual([]);
        expect(
          await db
            .select()
            .from(correspondenceSources)
            .where(eq(correspondenceSources.correspondenceId, initial.id)),
        ).toEqual([]);
        expect(
          await db
            .select()
            .from(correspondenceFilers)
            .where(eq(correspondenceFilers.correspondenceId, initial.id)),
        ).toEqual([]);
        expect(
          await db
            .select()
            .from(correspondenceAttachments)
            .where(eq(correspondenceAttachments.correspondenceId, initial.id)),
        ).toEqual([]);
        expect(
          await db
            .select({ id: entities.id })
            .from(entities)
            .where(eq(entities.id, attachmentId)),
        ).toEqual([{ id: attachmentId }]);
        expect(
          await db
            .select()
            .from(legalReaderAnnotations)
            .where(eq(legalReaderAnnotations.entityId, attachmentId)),
        ).toEqual(annotations);
      },
    );
  });
}
