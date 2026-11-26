import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  recordingTranscriptionRuns,
  workspaces,
} from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createScopedDb,
  markRlsDatabase,
} from "@/api/db/scoped";
import readRecordingTranscriptionRun from "@/api/handlers/recording-transcriptions/runs/get";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";

type RecordingTranscriptionsTenant = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"recordingTranscriptionRun">;
  featureAccessSnapshot: FeatureAccessSnapshot;
};

export type RecordingTranscriptionsScalingFixture = {
  db: GatedTestDb;
  tenant: RecordingTranscriptionsTenant;
  cleanup: () => Promise<void>;
};

const seedRun = async (
  db: GatedTestDb,
  tenant: Pick<
    RecordingTranscriptionsTenant,
    "organizationId" | "userId" | "workspaceId"
  >,
  docSequence: number,
): Promise<SafeId<"recordingTranscriptionRun">> => {
  const entityId = createSafeId<"entity">();
  const entityVersionId = createSafeId<"entityVersion">();
  const runId = createSafeId<"recordingTranscriptionRun">();
  await db.insert(entities).values({
    id: entityId,
    workspaceId: tenant.workspaceId,
    name: `Recording ${docSequence}`,
    docSequence,
  });
  await db.insert(entityVersions).values({
    id: entityVersionId,
    entityId,
    workspaceId: tenant.workspaceId,
  });
  await db.insert(recordingTranscriptionRuns).values({
    id: runId,
    organizationId: tenant.organizationId,
    workspaceId: tenant.workspaceId,
    entityId,
    fileFieldId: createSafeId<"field">(),
    entityVersionId,
    sourceFileId: createSafeId<"userFile">(),
    sourceFileName: `call-${docSequence}.m4a`,
    sourceMimeType: "audio/mp4",
    status: "queued",
    requestedBy: tenant.userId,
  });
  return runId;
};

/** One matter holding `size` transcription runs; the read names one of them. */
export const seedRecordingTranscriptionsScaling = async ({
  db,
  size,
}: {
  db: GatedTestDb;
  size: number;
}): Promise<RecordingTranscriptionsScalingFixture> => {
  const ids = {
    organizationId: toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`),
    userId: toSafeId<"user">(`usr_${Bun.randomUUIDv7()}`),
    workspaceId: createSafeId<"workspace">(),
  };
  await db.insert(organization).values({
    id: ids.organizationId,
    name: "Recording transcriptions scaling firm",
    slug: ids.organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: ids.userId,
    name: "Associate",
    email: `${ids.userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: Bun.randomUUIDv7(),
    userId: ids.userId,
    organizationId: ids.organizationId,
    role: "owner",
    createdAt: new Date(),
  });
  await db.insert(workspaces).values({
    id: ids.workspaceId,
    organizationId: ids.organizationId,
    name: "Recording transcriptions scaling matter",
    reference: ids.workspaceId,
  });
  const runId = await seedRun(db, ids, 1);
  for (let index = 0; index < size; index += 1) {
    await seedRun(db, ids, index + 2);
  }
  const featureAccessSnapshot = await createScopedDb(
    markRlsDatabase(db),
    [ids.workspaceId],
    ids.organizationId,
    ids.userId,
  )(
    async (tx) =>
      await resolveFeatureAccessSnapshot({
        tx,
        organizationId: ids.organizationId,
        userId: ids.userId,
      }),
  );
  return {
    db,
    tenant: { ...ids, runId, featureAccessSnapshot },
    cleanup: async () => {
      await deleteOrganizationsForTest(db, [ids.organizationId]);
      await db.delete(user).where(eq(user.id, ids.userId));
    },
  };
};

/** Reading one run is one indexed lookup, however many runs the matter holds. */
export const recordingTranscriptionsScalingScenarios = [
  {
    name: "recording transcription run read",
    expectedRows: 1,
    definition: readRecordingTranscriptionRun,
    measure: async ({ db, tenant }: RecordingTranscriptionsScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await readRecordingTranscriptionRun.handler(
          createTestHandlerContext<
            Parameters<typeof readRecordingTranscriptionRun.handler>[0]
          >({
            scopedDb: NO_DB,
            workspaceId: tenant.workspaceId,
            session: { activeOrganizationId: tenant.organizationId },
            user: { id: tenant.userId },
            featureAccessSnapshot: tenant.featureAccessSnapshot,
            safeDb: createMembershipSafeDb(markRlsDatabase(db), {
              organizationId: tenant.organizationId,
              serverValidatedWorkspaceIds: [tenant.workspaceId],
              userId: tenant.userId,
              featureAccessSnapshot: tenant.featureAccessSnapshot,
            }),
            audit: createAuditRecorder({
              organizationId: tenant.organizationId,
              workspaceId: tenant.workspaceId,
              userId: tenant.userId,
              request: new Request("https://example.test/recording-run"),
              server: null,
            }),
            params: { workspaceId: tenant.workspaceId, runId: tenant.runId },
          }),
        );
        if (!("run" in response)) {
          return panic("Run read scaling requires a run");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      }),
  },
];
