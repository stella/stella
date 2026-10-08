import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { rootDb, Transaction } from "@/api/db/root";
import {
  documentProcessingRuns,
  entities,
  entityVersions,
  featureEnrolments,
  fields,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { DOCUMENT_OCR_PROCESSOR_VERSION } from "@/api/lib/document-processing-contract";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  pauseDocumentDeadlineScoutAfterGrantLoss,
  recoverDocumentDeadlineScoutDispatches,
  resumeDocumentDeadlineScoutsAfterGrant,
} from "./document-deadline-recovery";
import { runDocumentDeadlineScout } from "./document-deadlines";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = process.env["DATABASE_URL"];
const OLD = new Date("2020-01-01T00:00:00Z");

const fixture = async (db: GatedTestDb) =>
  await db.transaction(async (tx) => {
    const organizationId = mintAuthProviderId<"organization">();
    const admittedUserId = mintAuthProviderId<"user">();
    const pausedUserId = mintAuthProviderId<"user">();
    const admittedWorkspaceId = createSafeId<"workspace">();
    const pausedWorkspaceId = createSafeId<"workspace">();
    const admittedPropertyId = createSafeId<"property">();
    const pausedPropertyId = createSafeId<"property">();
    await tx.insert(organization).values({
      id: organizationId,
      name: "Deadline recovery",
      slug: organizationId,
      createdAt: OLD,
    });
    await tx.insert(user).values(
      [admittedUserId, pausedUserId].map((id) => ({
        id,
        name: "Scout recipient",
        email: `${id}@example.test`,
        emailVerified: true,
      })),
    );
    await tx.insert(member).values(
      [admittedUserId, pausedUserId].map((userId) => ({
        id: Bun.randomUUIDv7(),
        organizationId,
        userId,
        role: "member",
        createdAt: OLD,
      })),
    );
    await tx.insert(workspaces).values(
      [admittedWorkspaceId, pausedWorkspaceId].map((id) => ({
        id,
        organizationId,
        name: "Private matter",
        reference: id,
      })),
    );
    await tx.insert(workspaceMembers).values([
      { workspaceId: admittedWorkspaceId, userId: admittedUserId },
      { workspaceId: pausedWorkspaceId, userId: pausedUserId },
    ]);
    await tx
      .insert(featureEnrolments)
      .values({ organizationId, userId: admittedUserId, featureId: "signals" });
    await tx.insert(properties).values(
      [
        { id: admittedPropertyId, workspaceId: admittedWorkspaceId },
        { id: pausedPropertyId, workspaceId: pausedWorkspaceId },
      ].map(
        (scope) =>
          ({
            ...scope,
            name: "File",
            status: "fresh",
            content: { version: 1, type: "file" },
            tool: { version: 1, type: "manual-input" },
          }) as const satisfies typeof properties.$inferInsert,
      ),
    );
    const sources = Array.from({ length: 101 }, (_, index) => ({
      runId: createSafeId<"documentProcessingRun">(),
      entityId: createSafeId<"entity">(),
      entityVersionId: createSafeId<"entityVersion">(),
      fieldId: createSafeId<"field">(),
      sourceFileId: createSafeId<"userFile">(),
      workspaceId: index < 100 ? pausedWorkspaceId : admittedWorkspaceId,
      propertyId: index < 100 ? pausedPropertyId : admittedPropertyId,
      updatedAt: new Date(OLD.getTime() + index),
    }));
    await tx.insert(entities).values(
      sources.map(
        (source) =>
          ({
            id: source.entityId,
            workspaceId: source.workspaceId,
            kind: "document",
            name: "Deadline document",
          }) as const satisfies typeof entities.$inferInsert,
      ),
    );
    await tx.insert(entityVersions).values(
      sources.map((source) => ({
        id: source.entityVersionId,
        entityId: source.entityId,
        workspaceId: source.workspaceId,
      })),
    );
    await tx.insert(fields).values(
      sources.map(
        (source) =>
          ({
            id: source.fieldId,
            workspaceId: source.workspaceId,
            propertyId: source.propertyId,
            entityVersionId: source.entityVersionId,
            content: {
              version: 1,
              type: "file",
              id: source.sourceFileId,
              fileName: "deadline.pdf",
              mimeType: "application/pdf",
              sizeBytes: 1024,
              encrypted: false,
              sha256Hex: "a".repeat(64),
              pdfFileId: null,
            },
          }) as const satisfies typeof fields.$inferInsert,
      ),
    );
    await tx.insert(documentProcessingRuns).values(
      sources.map(
        (source) =>
          ({
            id: source.runId,
            organizationId,
            workspaceId: source.workspaceId,
            entityId: source.entityId,
            entityVersionId: source.entityVersionId,
            fieldId: source.fieldId,
            sourceFileId: source.sourceFileId,
            sourceSha256Hex: "a".repeat(64),
            kind: "ocr",
            processorVersion: DOCUMENT_OCR_PROCESSOR_VERSION,
            requestSource: "upload",
            status: "succeeded",
            finishedAt: OLD,
            deadlineScoutStatus: "pending",
            updatedAt: source.updatedAt,
          }) as const satisfies typeof documentProcessingRuns.$inferInsert,
      ),
    );
    return {
      organizationId,
      admittedUserId,
      pausedUserId,
      pausedWorkspaceId,
      sources,
    };
  });

describe.skipIf(!enabled)("deadline admission recovery (postgres)", () => {
  for (const grantDelivery of ["immediate", "postcommit-crash"] as const) {
    test(`a hundred paused sources do not block admitted source 101; ${grantDelivery} regrant resumes`, async () => {
      const previousFlag = env.FEATURE_SIGNALS;
      env.FEATURE_SIGNALS = true;
      try {
        await withGatedTestClients(
          databaseUrl ?? panic("Missing PostgreSQL test URL"),
          async ({ openClient }) => {
            const client = openClient();
            const f = await fixture(client.db);
            const database = asTestRaw<typeof rootDb>(client.db);
            const dispatched: string[] = [];
            const sweep = async () =>
              await recoverDocumentDeadlineScoutDispatches({
                database,
                enqueueDocumentDeadlineScout: async ({ sourceRunId }) => {
                  dispatched.push(sourceRunId);
                },
              });
            try {
              await sweep();
              expect(dispatched).toEqual([f.sources.at(100)?.runId]);
              const paused = await client.db
                .select({
                  status: documentProcessingRuns.deadlineScoutStatus,
                  error: documentProcessingRuns.deadlineScoutErrorCode,
                  claimedAt: documentProcessingRuns.deadlineScoutClaimedAt,
                })
                .from(documentProcessingRuns)
                .where(
                  eq(documentProcessingRuns.workspaceId, f.pausedWorkspaceId),
                );
              expect(paused).toHaveLength(100);
              expect(
                paused.every(
                  (row) =>
                    row.status === "awaiting_grant" &&
                    row.error === "feature_not_granted" &&
                    row.claimedAt === null,
                ),
              ).toBe(true);
              const resumedRunId =
                f.sources.at(0)?.runId ?? panic("Missing resumed fixture");
              // A job queued before revocation reaches the worker independently of the sweep.
              await client.db
                .update(documentProcessingRuns)
                .set({
                  deadlineScoutStatus: "pending",
                  deadlineScoutErrorCode: null,
                })
                .where(eq(documentProcessingRuns.id, resumedRunId));
              await runDocumentDeadlineScout({
                db: database,
                sourceRunId: resumedRunId,
              });
              expect(
                (
                  await client.db
                    .select({
                      status: documentProcessingRuns.deadlineScoutStatus,
                      attempts:
                        documentProcessingRuns.deadlineScoutAttemptCount,
                    })
                    .from(documentProcessingRuns)
                    .where(eq(documentProcessingRuns.id, resumedRunId))
                ).at(0),
              ).toEqual({ status: "awaiting_grant", attempts: 0 });
              await client.db.transaction(async (tx) => {
                await lockFeatureRecoveryAdmission({
                  tx,
                  organizationId: f.organizationId,
                  featureId: "signals",
                });
                await tx.insert(featureEnrolments).values({
                  organizationId: f.organizationId,
                  userId: f.pausedUserId,
                  featureId: "signals",
                });
                if (grantDelivery === "immediate") {
                  await resumeDocumentDeadlineScoutsAfterGrant({
                    tx: asTestRaw<Transaction>(tx),
                    organizationId: f.organizationId,
                    userId: f.pausedUserId,
                  });
                }
              });
              if (grantDelivery === "postcommit-crash") {
                await sweep();
              }
              expect(
                await client.db.$count(
                  documentProcessingRuns,
                  and(
                    eq(documentProcessingRuns.workspaceId, f.pausedWorkspaceId),
                    eq(documentProcessingRuns.deadlineScoutStatus, "pending"),
                  ),
                ),
              ).toBe(100);
              // A stale worker that observed opt-out before this grant cannot park the now-admitted source.
              await pauseDocumentDeadlineScoutAfterGrantLoss({
                database,
                sourceRunId: resumedRunId,
                from: "pending",
              });
              expect(
                (
                  await client.db
                    .select({
                      status: documentProcessingRuns.deadlineScoutStatus,
                    })
                    .from(documentProcessingRuns)
                    .where(eq(documentProcessingRuns.id, resumedRunId))
                ).at(0)?.status,
              ).toBe("pending");
            } finally {
              await client.db
                .delete(organization)
                .where(eq(organization.id, f.organizationId));
              await client.db.delete(user).where(eq(user.id, f.admittedUserId));
              await client.db.delete(user).where(eq(user.id, f.pausedUserId));
            }
          },
        );
      } finally {
        env.FEATURE_SIGNALS = previousFlag;
      }
    });
  }
});
