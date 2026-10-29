import { Result } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { DATA_BOX_MESSAGE_MIME_TYPE } from "@stll/api-contract/data-box";
import {
  EML_MIME_TYPE,
  MSG_MIME_TYPE,
} from "@stll/api-contract/email-mime-types";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  correspondence,
  correspondenceAttachments,
  correspondenceFilers,
  correspondenceSources,
  entities,
  entityVersions,
  fields,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import {
  emlFile,
  GOLDEN_MESSAGE,
} from "@/api/lib/email/inbound/email-file.test-fixture";
import { INBOUND_MAIL_LIMITS } from "@/api/lib/email/inbound/limits";
import {
  fileUploadedMail,
  retireUploadedMailSource,
} from "@/api/lib/email/inbound/upload";
import { fileSecurityRejection } from "@/api/lib/file-scan/rejection";
import { FileScanRejectedError } from "@/api/lib/file-scan/scan-upload";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { FIXTURE_MESSAGE, zfoFile } from "@/api/tests/fixtures/zfo";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type FilingOptions = Parameters<typeof fileUploadedMail>[0];

const terminalCases = [
  { name: "invalid content", reason: "invalid_content", invalidContent: true },
  {
    name: "retirement unavailable",
    reason: "no_sender",
    text: "Subject: Draft\r\n\r\nBody",
    unavailable: true,
  },
  { name: "superseded attempt", reason: "source_changed", superseded: true },
  { name: "deleted source", reason: "source_missing", deleted: true },
  {
    name: "non-correspondence",
    reason: "not_email",
    mimeType: "application/pdf",
  },
  {
    name: "missing uploader",
    reason: "no_uploader",
    change: "remove_uploader",
  },
  {
    name: "removed matter access",
    reason: "no_matter_access",
    change: "remove_access",
  },
  {
    name: "delivered attachment",
    reason: "correspondence_attachment",
    change: "attach",
  },
  {
    name: "malformed RFC 5322",
    reason: "malformed_message",
    text: "From: a@example.com\r\nFrom: b@example.com\r\n\r\nBody",
  },
  {
    name: "malformed Outlook",
    reason: "malformed_message",
    mimeType: MSG_MIME_TYPE,
    text: "not a compound file",
  },
  {
    name: "malformed data-box",
    reason: "data_box_not_signed_data",
    mimeType: DATA_BOX_MESSAGE_MIME_TYPE,
    text: "not a CMS file",
  },
  {
    name: "missing sender",
    reason: "no_sender",
    text: "Subject: Draft\r\n\r\nBody",
  },
  { name: "oversized email", reason: "message_too_large", oversized: true },
  {
    name: "rejected attachment",
    reason: "attachment_rejected",
    mimeType: DATA_BOX_MESSAGE_MIME_TYPE,
    rejection: true,
  },
] as const;

if (!databaseUrl || !runPostgresTests) {
  describe.skip("uploaded correspondence source generations", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("uploaded correspondence source generations", () => {
    const gated = openGatedTestDatabase(databaseUrl);
    const testDb = markRlsDatabase(gated.db);
    const ids = {
      orgA: mintAuthProviderId<"organization">(),
      userA1: mintAuthProviderId<"user">(),
      userAdmin: mintAuthProviderId<"user">(),
      wsA1: createSafeId<"workspace">(),
      memberA1wsA1: createSafeId<"workspaceMember">(),
      filePropertyA1: createSafeId<"property">(),
    };
    const fixtureScopedDb = createScopedDb(
      testDb,
      [ids.wsA1],
      ids.orgA,
      ids.userA1,
    );
    gated.cleanUp(async () => {
      await testDb.delete(organization).where(eq(organization.id, ids.orgA));
      for (const id of [ids.userA1, ids.userAdmin]) {
        await testDb.delete(user).where(eq(user.id, id));
      }
    });
    beforeAll(async () => {
      await testDb.insert(user).values(
        [ids.userA1, ids.userAdmin].map((id) => ({
          id,
          name: "Upload source fixture",
          email: `${id}@example.test`,
        })),
      );
      await testDb.insert(organization).values({
        id: ids.orgA,
        name: "Upload source fixture",
        slug: `upload-source-${ids.orgA}`,
        createdAt: new Date(),
      });
      await recordNewOrganizationAccessState(testDb, {
        organizationId: ids.orgA,
        now: new Date(),
      });
      await testDb.insert(member).values([
        {
          id: mintAuthProviderIdValue(),
          organizationId: ids.orgA,
          userId: ids.userA1,
          role: "member",
          createdAt: new Date(),
        },
        {
          id: mintAuthProviderIdValue(),
          organizationId: ids.orgA,
          userId: ids.userAdmin,
          role: "owner",
          createdAt: new Date(),
        },
      ]);
      await testDb.insert(workspaces).values({
        id: ids.wsA1,
        organizationId: ids.orgA,
        name: "Upload source matter",
        reference: "UPLOAD-SOURCE",
      });
      await testDb.insert(workspaceMembers).values({
        id: ids.memberA1wsA1,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
      });
      await testDb.insert(properties).values({
        id: ids.filePropertyA1,
        workspaceId: ids.wsA1,
        name: "File",
        status: "fresh",
        content: { version: 1, type: "file" },
        tool: { version: 1, type: "manual-input" },
      });
    });

    test.each(terminalCases)(
      "a replacement ending in $name reconciles only its source generation",
      async (scenario) => {
        const entityId = createSafeId<"entity">();
        const scope = {
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          entityId,
        };
        const scopedDbForUploader: NonNullable<
          FilingOptions["scopedDbForUploader"]
        > = ({ userId }) =>
          createScopedDb(testDb, [ids.wsA1], ids.orgA, userId);
        const scopedDbForSource: NonNullable<
          FilingOptions["scopedDbForSource"]
        > = () => createScopedDb(testDb, [ids.wsA1], ids.orgA, null);
        await testDb.insert(entities).values({
          id: entityId,
          workspaceId: ids.wsA1,
          name: "Versioned correspondence",
          createdBy: ids.userA1,
        });
        const addVersion = async (versionNumber: number, mimeType: string) => {
          const versionId = createSafeId<"entityVersion">();
          const fileId = `source-${versionId}`;
          await testDb.insert(entityVersions).values({
            id: versionId,
            workspaceId: ids.wsA1,
            entityId,
            versionNumber,
            createdBy: versionNumber === 1 ? ids.userA1 : ids.userAdmin,
          });
          await testDb.insert(fields).values({
            id: createSafeId<"field">(),
            workspaceId: ids.wsA1,
            entityVersionId: versionId,
            propertyId: ids.filePropertyA1,
            content: {
              type: "file",
              id: fileId,
              mimeType,
              fileName: "letter",
              sizeBytes: 128,
              pdfFileId: null,
              sha256Hex: "a".repeat(64),
              encrypted: false,
              version: 1,
            },
          });
          await testDb
            .update(entities)
            .set({ currentVersionId: versionId })
            .where(eq(entities.id, entityId));
          return fileId;
        };
        const initialFileId = await addVersion(1, EML_MIME_TYPE);
        const initial = await fileUploadedMail({
          database: testDb,
          scope,
          sourceFileId: initialFileId,
          mimeType: EML_MIME_TYPE,
          bytes: emlFile(GOLDEN_MESSAGE),
          scopedDbForUploader,
          scopedDbForSource,
        });
        expect(initial.isOk() && initial.value.status).toBe("filed");
        if (initial.isErr() || initial.value.status === "skipped") {
          throw new Error(
            "The initial file must establish correspondence before replacement",
          );
        }
        const oldId = initial.value.correspondenceId;
        const initialSources = await fixtureScopedDb(
          async (tx) =>
            await tx
              .select()
              .from(correspondenceSources)
              .where(eq(correspondenceSources.entityId, entityId)),
        );
        const initialFilers = await fixtureScopedDb(
          async (tx) =>
            await tx
              .select()
              .from(correspondenceFilers)
              .where(eq(correspondenceFilers.correspondenceId, oldId)),
        );
        const initialAttachments = await fixtureScopedDb(
          async (tx) =>
            await tx
              .select()
              .from(correspondenceAttachments)
              .where(eq(correspondenceAttachments.correspondenceId, oldId)),
        );
        const mimeType =
          "mimeType" in scenario ? scenario.mimeType : EML_MIME_TYPE;
        const change = "change" in scenario ? scenario.change : undefined;
        if (change === "remove_access") {
          await testDb
            .delete(workspaceMembers)
            .where(eq(workspaceMembers.id, ids.memberA1wsA1));
        }
        const currentFileId = await addVersion(2, mimeType);
        if (change === "remove_uploader") {
          await testDb
            .update(entities)
            .set({ createdBy: null })
            .where(eq(entities.id, entityId));
        }
        if (change === "attach") {
          const deliveredFileId = createSafeId<"entity">();
          await testDb.insert(entities).values({
            id: deliveredFileId,
            workspaceId: ids.wsA1,
            name: "Other correspondence",
            createdBy: ids.userA1,
          });
          const delivered = await fileUploadedMail({
            database: testDb,
            scope: { ...scope, entityId: deliveredFileId },
            mimeType: EML_MIME_TYPE,
            bytes: emlFile(GOLDEN_MESSAGE),
            scopedDbForUploader,
            scopedDbForSource,
          });
          if (delivered.isErr() || delivered.value.status === "skipped") {
            throw new Error("Expected owning correspondence");
          }
          const correspondenceId = delivered.value.correspondenceId;
          await fixtureScopedDb(async (tx) => {
            await tx.insert(correspondenceAttachments).values({
              organizationId: ids.orgA,
              workspaceId: ids.wsA1,
              correspondenceId,
              entityId,
              ordinal: 0,
              filename: "letter.eml",
              mediaType: EML_MIME_TYPE,
              byteSize: 1,
              scanVerdict: "clean",
            });
          });
        }
        const rejectingScan: NonNullable<
          FilingOptions["scanAttachment"]
        > = async () => {
          const rejection = fileSecurityRejection({
            verdict: "reject",
            findings: [
              { rule: "test-rule", severity: "reject", message: "rejected" },
            ],
          });
          if (rejection === null) {
            throw new Error("Expected security rejection");
          }
          return Result.err(
            new FileScanRejectedError({
              message: rejection.message,
              rejection,
              inspectionFailures: [],
            }),
          );
        };
        const replacementBytes = async () => {
          if ("text" in scenario) {
            return new TextEncoder().encode(scenario.text).buffer;
          }
          if ("oversized" in scenario) {
            return new Uint8Array(INBOUND_MAIL_LIMITS.rawBytes + 1).buffer;
          }
          if ("rejection" in scenario) {
            return new Uint8Array(await zfoFile(FIXTURE_MESSAGE)).buffer;
          }
          return emlFile({ ...GOLDEN_MESSAGE, subject: "Replacement message" });
        };
        const bytes = await replacementBytes();
        if ("deleted" in scenario) {
          await testDb.delete(entities).where(eq(entities.id, entityId));
        }
        const verifyOriginal: NonNullable<
          FilingOptions["verifyOriginal"]
        > = async () => {
          const newestVersionId = createSafeId<"entityVersion">();
          await testDb.insert(entityVersions).values({
            id: newestVersionId,
            entityId,
            workspaceId: ids.wsA1,
            versionNumber: 3,
            createdBy: ids.userAdmin,
          });
          await testDb.insert(fields).values({
            id: createSafeId<"field">(),
            workspaceId: ids.wsA1,
            entityVersionId: newestVersionId,
            propertyId: ids.filePropertyA1,
            content: {
              type: "file",
              id: currentFileId,
              mimeType,
              fileName: "letter",
              sizeBytes: 128,
              pdfFileId: null,
              sha256Hex: "b".repeat(64),
              encrypted: false,
              version: 1,
            },
          });
          await testDb
            .update(entities)
            .set({ currentVersionId: newestVersionId })
            .where(eq(entities.id, entityId));
          const newest = await fileUploadedMail({
            database: testDb,
            scope,
            sourceFileId: currentFileId,
            mimeType,
            bytes: emlFile({ ...GOLDEN_MESSAGE, subject: "Newest message" }),
            scopedDbForUploader,
            scopedDbForSource,
          });
          expect(newest.isOk() && newest.value.status).toBe("duplicate");
          return Result.ok({ status: "unverified" });
        };
        try {
          for (const attempt of "superseded" in scenario ? [1] : [1, 2]) {
            const outcome = await fileUploadedMail({
              database: testDb,
              scope,
              sourceFileId: currentFileId,
              mimeType,
              bytes,
              scopedDbForUploader,
              scopedDbForSource,
              scanAttachment: rejectingScan,
              ...("invalidContent" in scenario
                ? {
                    createRecord: async () => ({
                      type: "invalid_content" as const,
                    }),
                  }
                : {}),
              ...("superseded" in scenario ? { verifyOriginal } : {}),
              ...("unavailable" in scenario && attempt === 1
                ? {
                    scopedDbForSource: () => async () => {
                      throw new Error("Retirement database unavailable");
                    },
                  }
                : {}),
            });
            if ("unavailable" in scenario && attempt === 1) {
              expect(outcome.isErr()).toBe(true);
              expect(
                await fixtureScopedDb(
                  async (tx) =>
                    await tx
                      .select({ id: correspondence.id })
                      .from(correspondence)
                      .where(eq(correspondence.id, oldId)),
                ),
              ).toHaveLength(1);
              continue;
            }
            expect({
              attempt,
              outcome: outcome.isOk() && outcome.value,
            }).toEqual({
              attempt,
              outcome: { status: "skipped", reason: scenario.reason },
            });
            const expectedRecords =
              "deleted" in scenario ? [] : [{ id: oldId }];
            expect(
              await fixtureScopedDb(
                async (tx) =>
                  await tx
                    .select({ id: correspondence.id })
                    .from(correspondence)
                    .where(eq(correspondence.id, oldId)),
              ),
            ).toEqual(expectedRecords);
            expect(
              await fixtureScopedDb(
                async (tx) =>
                  await tx
                    .select()
                    .from(correspondenceSources)
                    .where(eq(correspondenceSources.entityId, entityId)),
              ),
            ).toEqual("deleted" in scenario ? [] : initialSources);
            expect(
              await fixtureScopedDb(
                async (tx) =>
                  await tx
                    .select()
                    .from(correspondenceFilers)
                    .where(eq(correspondenceFilers.correspondenceId, oldId)),
              ),
            ).toEqual("deleted" in scenario ? [] : initialFilers);
            if (!("superseded" in scenario)) {
              expect(
                await fixtureScopedDb(
                  async (tx) =>
                    await tx
                      .select()
                      .from(correspondenceAttachments)
                      .where(
                        eq(correspondenceAttachments.correspondenceId, oldId),
                      ),
                ),
              ).toEqual("deleted" in scenario ? [] : initialAttachments);
            }
            if ("superseded" in scenario) {
              expect(
                await fixtureScopedDb(
                  async (tx) =>
                    await tx
                      .select({ subject: correspondence.subject })
                      .from(correspondence)
                      .where(eq(correspondence.sourceEntityId, entityId)),
                ),
              ).toEqual([{ subject: "Newest message" }]);
            }
            expect(
              await testDb
                .select({ id: entities.id })
                .from(entities)
                .where(eq(entities.id, entityId)),
            ).toHaveLength("deleted" in scenario ? 0 : 1);
          }
        } finally {
          if (change === "remove_access") {
            await testDb.insert(workspaceMembers).values({
              id: ids.memberA1wsA1,
              workspaceId: ids.wsA1,
              userId: ids.userA1,
            });
          }
        }
      },
    );

    test("unrelated files retire without locking the matter or source entity", async () => {
      const entityId = createSafeId<"entity">();
      await testDb.insert(entities).values({
        id: entityId,
        workspaceId: ids.wsA1,
        name: "Unrelated document",
        createdBy: ids.userA1,
      });
      const outcome = await retireUploadedMailSource({
        database: testDb,
        scope: { organizationId: ids.orgA, workspaceId: ids.wsA1, entityId },
        scopedDbForSource: () => async (run) =>
          await createScopedDb(
            testDb,
            [ids.wsA1],
            ids.orgA,
            null,
          )(async (tx) => {
            const result = await run(tx);
            const locks = await tx.execute(sql`
                SELECT 1 FROM pg_catalog.pg_locks
                WHERE pid = pg_backend_pid()
                  AND relation IN ('public.workspaces'::regclass, 'public.entities'::regclass)
                  AND mode IN ('RowShareLock', 'RowExclusiveLock')
              `);
            expect(locks).toHaveLength(0);
            return result;
          }),
      });
      expect(outcome.isOk() && outcome.value).toEqual({
        status: "skipped",
        reason: "not_email",
      });
    });

    test("only the current immutable file generation may file or retire uploaded correspondence", async () => {
      const entityId = createSafeId<"entity">();
      const initialVersionId = createSafeId<"entityVersion">();
      const currentVersionId = createSafeId<"entityVersion">();
      const initialFileId = "uploaded-email-generation";
      const currentFileId = "replacement-pdf-generation";
      const scope = {
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        entityId,
      };
      await testDb.insert(entities).values({
        id: entityId,
        workspaceId: ids.wsA1,
        name: "Uploaded letter",
        createdBy: ids.userA1,
      });
      await testDb.insert(entityVersions).values([
        {
          id: initialVersionId,
          entityId,
          workspaceId: ids.wsA1,
          versionNumber: 1,
        },
        {
          id: currentVersionId,
          entityId,
          workspaceId: ids.wsA1,
          versionNumber: 2,
        },
      ]);
      await testDb.insert(fields).values(
        [
          {
            versionId: initialVersionId,
            fileId: initialFileId,
            mimeType: EML_MIME_TYPE,
          },
          {
            versionId: currentVersionId,
            fileId: currentFileId,
            mimeType: "application/pdf",
          },
        ].map(
          ({ versionId, fileId, mimeType }) =>
            ({
              id: createSafeId<"field">(),
              workspaceId: ids.wsA1,
              entityVersionId: versionId,
              propertyId: ids.filePropertyA1,
              content: {
                type: "file" as const,
                id: fileId,
                mimeType,
                fileName: "letter",
                sizeBytes: 128,
                pdfFileId: null,
                sha256Hex: "a".repeat(64),
                encrypted: false,
                version: 1,
              },
            }) satisfies typeof fields.$inferInsert,
        ),
      );
      await testDb
        .update(entities)
        .set({ currentVersionId: initialVersionId })
        .where(eq(entities.id, entityId));
      const scopedDbForUploader: NonNullable<
        Parameters<typeof fileUploadedMail>[0]["scopedDbForUploader"]
      > = ({ userId }) => createScopedDb(testDb, [ids.wsA1], ids.orgA, userId);
      const scopedDbForSource: NonNullable<
        Parameters<typeof retireUploadedMailSource>[0]["scopedDbForSource"]
      > = () => createScopedDb(testDb, [ids.wsA1], ids.orgA, null);
      const initial = await fileUploadedMail({
        database: testDb,
        scope,
        sourceFileId: initialFileId,
        mimeType: EML_MIME_TYPE,
        bytes: emlFile(GOLDEN_MESSAGE),
        scopedDbForUploader,
        scopedDbForSource,
      });
      expect(initial.isOk() && initial.value.status).toBe("filed");
      const records = async () =>
        fixtureScopedDb(
          async (tx) =>
            await tx
              .select({ id: correspondence.id })
              .from(correspondence)
              .where(eq(correspondence.sourceEntityId, entityId)),
        );
      expect(await records()).toHaveLength(1);
      await testDb
        .update(entities)
        .set({ currentVersionId })
        .where(eq(entities.id, entityId));
      for (const sourceFileId of [initialFileId, undefined]) {
        const stale = await fileUploadedMail({
          database: testDb,
          scope,
          ...(sourceFileId === undefined ? {} : { sourceFileId }),
          mimeType: EML_MIME_TYPE,
          bytes: new ArrayBuffer(0),
          scopedDbForUploader,
          scopedDbForSource,
        });
        expect(stale.isOk() && stale.value).toEqual({
          status: "skipped",
          reason: "source_changed",
        });
      }
      const staleCleanup = await retireUploadedMailSource({
        database: testDb,
        scope,
        sourceFileId: initialFileId,
        scopedDbForSource,
      });
      expect(staleCleanup.isOk() && staleCleanup.value).toEqual({
        status: "skipped",
        reason: "source_changed",
      });
      expect(await records()).toHaveLength(1);
      const currentCleanup = await retireUploadedMailSource({
        database: testDb,
        scope,
        sourceFileId: currentFileId,
        scopedDbForSource,
      });
      expect(currentCleanup.isOk() && currentCleanup.value).toEqual({
        status: "skipped",
        reason: "not_email",
      });
      expect(await records()).toHaveLength(1);
    });
  });
}
