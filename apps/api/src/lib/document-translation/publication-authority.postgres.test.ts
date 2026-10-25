/**
 * A translation publishes its output under the requester's current authority,
 * locked before the matter row in the member → assignment → matter order that
 * access changes take. A concurrent role change therefore waits for the
 * publication instead of interleaving with its matter lock.
 */

import { panic, Result } from "better-result";
import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  documentTranslationRuns,
  entities,
  entityVersions,
  fields,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import {
  DD_REPORT_KEY,
  getBuiltinReportTemplate,
  initBuiltinReportTemplates,
} from "@/api/handlers/reports/builtin-templates";
import * as aiConfigLoader from "@/api/lib/ai-config-loader";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { DEFAULT_MANAGED_AI_RESIDENCY } from "@/api/lib/chat/ai-data-policy";
import * as translationAI from "@/api/lib/document-translation/ai";
import { processDocumentTranslationRun } from "@/api/lib/document-translation/run-queue";
import { authorizeBufferWrite } from "@/api/lib/entities/buffer-write-authority";
import * as entityWriter from "@/api/lib/entities/create-from-buffer";
import type { CreateEntityFromBufferDependencies } from "@/api/lib/entities/create-from-buffer";
import { createFileKey } from "@/api/lib/files/utils";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedDocumentTranslationRunId } from "@/api/lib/safe-id-boundaries";
import { enqueueEntitySearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

// timeout: the run assembles, validates and scans a real DOCX before publishing.
setDefaultTimeout(120_000);

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests =
  process.env["STELLA_RUN_POSTGRES_TESTS"] === "true" &&
  databaseUrl !== undefined;
const state = createTestState({ file: import.meta.path, config: env });
const BUCKET = process.env["S3_BUCKET"] ?? "stella";

const noDerivatives = {
  broadcastWorkspaceResourceUpdated: () => undefined,
  enqueueImageThumbnailOrMarkFailed: async () => undefined,
  enqueuePdfDerivativeOrMarkFailed: async () => undefined,
  processExtraction: async () => undefined,
  enqueueEntitySearchRepairs,
  flushEntitySearchRepairs: async () => ({ failed: 0, repaired: 0 }),
  requestNativeExtractionRun: async () => null,
} satisfies CreateEntityFromBufferDependencies;

const backendPid = (rows: { pid: number }[]) =>
  rows.at(0)?.pid ?? panic("A backend pid is required");
const backendPidColumns = { pid: sql<number>`pg_backend_pid()` };
const sessionRow = sql`(SELECT 1) AS session_pid`;

describe.skipIf(!runPostgresTests)("document translation publication", () => {
  test("a concurrent role change waits for the publication's authority", async () => {
    await initBuiltinReportTemplates();
    const sourceDocument = getBuiltinReportTemplate(DD_REPORT_KEY);
    if (sourceDocument?.kind !== "docx") {
      panic("Translation publication needs a DOCX source");
    }
    await withGatedTestClients(
      databaseUrl ?? panic("Publication tests need DATABASE_URL"),
      async ({ openClient }) => {
        const { db } = openClient();
        const { db: revokingDb } = openClient({ max: 1 });
        const observer = openClient().sql;
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const memberId = Bun.randomUUIDv7();
        const workspaceId = createSafeId<"workspace">();
        const entityId = createSafeId<"entity">();
        const entityVersionId = createSafeId<"entityVersion">();
        const propertyId = createSafeId<"property">();
        const fieldId = createSafeId<"field">();
        const sourceFileId = Bun.randomUUIDv7();
        const runId = createSafeId<"documentTranslationRun">();
        const fakeS3 = startFakeS3();
        state.setConfig("FEATURE_FILE_USAGE_LIMITS", false);
        const realCreateEntityFromBuffer = entityWriter.createEntityFromBuffer;
        const authorized = Promise.withResolvers<number>();
        const release = Promise.withResolvers<undefined>();
        const settingsSpy = spyOn(
          aiConfigLoader,
          "loadOrgAISettings",
        ).mockImplementation(async () =>
          Result.ok({
            orgAIConfig: null,
            promptCachingEnabled: false,
            managedAIResidency: DEFAULT_MANAGED_AI_RESIDENCY,
          }),
        );
        const translateSpy = spyOn(
          translationAI,
          "translateTaggedSegments",
        ).mockImplementation(
          async ({ segments }) =>
            new Map(
              segments.map((segment) => [segment.id, segment.taggedText]),
            ),
        );
        // The real writer runs; the barrier holds the transaction right after
        // the run's own authorization, before the matter lock.
        const writeSpy = spyOn(
          entityWriter,
          "createEntityFromBuffer",
        ).mockImplementation(
          async (input) =>
            await realCreateEntityFromBuffer({
              ...input,
              dependencies: noDerivatives,
              authority: {
                type: "current-member",
                authorize: async (tx) => {
                  await authorizeBufferWrite(input.authority, tx);
                  authorized.resolve(
                    backendPid(
                      await tx.select(backendPidColumns).from(sessionRow),
                    ),
                  );
                  await release.promise;
                },
              },
            }),
        );
        try {
          await db.insert(organization).values({
            id: organizationId,
            name: "Translation publication",
            slug: organizationId,
            createdAt: new Date(),
          });
          await recordNewOrganizationAccessState(db, {
            organizationId,
            now: new Date(),
          });
          await db.insert(user).values({
            id: userId,
            name: "Translation requester",
            email: `${userId}@example.test`,
          });
          await db.insert(member).values({
            id: memberId,
            organizationId,
            userId,
            role: "member",
            createdAt: new Date(),
          });
          await db.insert(workspaces).values({
            id: workspaceId,
            organizationId,
            name: "Translation matter",
            reference: workspaceId,
          });
          await db.insert(workspaceMembers).values({ workspaceId, userId });
          await db.insert(entities).values({
            id: entityId,
            workspaceId,
            name: "Agreement",
            kind: "document",
          });
          await db.insert(entityVersions).values({
            id: entityVersionId,
            entityId,
            workspaceId,
            versionNumber: 1,
          });
          await db
            .update(entities)
            .set({ currentVersionId: entityVersionId })
            .where(eq(entities.id, entityId));
          await db.insert(properties).values({
            id: propertyId,
            workspaceId,
            name: "File",
            content: { type: "file", version: 1 },
            tool: { type: "manual-input", version: 1 },
            status: "fresh",
          });
          await db.insert(fields).values({
            id: fieldId,
            workspaceId,
            propertyId,
            entityVersionId,
            content: {
              version: 1,
              type: "file",
              id: sourceFileId,
              fileName: "agreement.docx",
              mimeType: DOCX_MIME_TYPE,
              sizeBytes: 1024,
              encrypted: false,
              sha256Hex: "a".repeat(64),
              pdfFileId: null,
            },
          });
          fakeS3.put(
            BUCKET,
            createFileKey({
              organizationId,
              workspaceId,
              fileId: sourceFileId,
              mimeType: DOCX_MIME_TYPE,
            }),
            new Uint8Array(await sourceDocument.loadBuffer()),
            DOCX_MIME_TYPE,
          );
          await db.insert(documentTranslationRuns).values({
            id: runId,
            organizationId,
            workspaceId,
            entityId,
            fileFieldId: fieldId,
            entityVersionId,
            sourceFileId: toSafeId<"userFile">(sourceFileId),
            sourceFileName: "agreement.docx",
            sourceMimeType: DOCX_MIME_TYPE,
            output: "translated",
            engine: "ai",
            sourceLang: "en",
            targetLang: "cs",
            status: "queued",
            requestedBy: userId,
          });
          const actor = createRootRunActor(
            { organizationId, workspaceId, userId, runId },
            brandPersistedDocumentTranslationRunId,
            asTestRaw<RlsDatabase<Transaction>>(markRlsDatabase(db)),
          );

          const publication = processDocumentTranslationRun(
            actor,
            testModelAdmission(actor.organizationId),
          );
          const holdingPid = await Promise.race([
            authorized.promise,
            publication.then(() => null),
          ]);
          if (holdingPid === null) {
            panic("The run finished without publishing its output");
          }
          const waitingPid = backendPid(
            await revokingDb.select(backendPidColumns).from(sessionRow),
          );
          // The role-change write: a downgrade that removes translation access.
          const revocation = (async () =>
            await revokingDb
              .update(member)
              .set({ role: "external" })
              .where(eq(member.id, memberId)))();
          try {
            await waitForBlockedPid(observer, { holdingPid, waitingPid });
          } finally {
            release.resolve(undefined);
          }
          await publication;
          await revocation;

          const run = (
            await db
              .select()
              .from(documentTranslationRuns)
              .where(eq(documentTranslationRuns.id, runId))
          ).at(0);
          expect(run?.status).toBe("completed");
          expect(run?.outputEntityId).not.toBeNull();
          expect(
            (
              await db
                .select({ role: member.role })
                .from(member)
                .where(eq(member.id, memberId))
            ).at(0)?.role,
          ).toBe("external");
          expect(writeSpy).toHaveBeenCalledTimes(1);
        } finally {
          release.resolve(undefined);
          settingsSpy.mockRestore();
          translateSpy.mockRestore();
          writeSpy.mockRestore();
          fakeS3.stop();
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db.delete(user).where(eq(user.id, userId));
        }
      },
    );
  });
});
