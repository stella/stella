import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { user } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { reportExports } from "@/api/db/schema";
import type {
  ReportExportNotificationStatus,
  ReportExportStatus,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { notifyReportExportStatus } from "@/api/handlers/reports/report-export-notification";
import type { ReportExportNotificationEmail } from "@/api/handlers/reports/report-export-notification";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const SENSITIVE_MARKERS = [
  "privileged legal content",
  "secret prompt text",
  "untrusted-client-name.docx",
] as const;

let testDb: TestDatabase;
let ids: TestIds;
const createdExportIds: SafeId<"reportExport">[] = [];
const createdUserIds: SafeId<"user">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
    if (createdExportIds.length > 0) {
      await testDb
        .delete(reportExports)
        .where(inArray(reportExports.id, createdExportIds));
    }
    if (createdUserIds.length > 0) {
      await testDb.delete(user).where(inArray(user.id, createdUserIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("report export status notifications", () => {
  test("claims concurrent delivery once without exposing report inputs", async () => {
    const requester = await createTestUser();
    const exportId = await createTestExport({
      notificationStatus: "pending",
      requestedBy: requester.id,
      status: "failed",
    });
    const recording = createRecordingDelivery();
    const options = {
      delivery: recording.delivery,
      exportId,
      scopedDb: scopedDbFor({ userId: requester.id, workspaceId: ids.wsA1 }),
      userId: requester.id,
      workspaceId: ids.wsA1,
    };

    const results = await Promise.all([
      notifyReportExportStatus(options),
      notifyReportExportStatus(options),
    ]);

    expect(results.map(({ status }) => status).toSorted()).toEqual([
      "sent",
      "skipped",
    ]);
    expect(recording.deliveries).toEqual([
      {
        appUrl: "http://localhost:3000/workspaces",
        email: requester.email,
        lang: "cs",
        status: "failed",
      },
    ]);
    expectPrivacySafe(recording.deliveries);

    const row = await readNotificationState(exportId);
    expect(row?.notificationStatus).toBe("sent");
    expect(row?.notificationAttemptedAt).toBeInstanceOf(Date);
  });

  test("wrong requester and workspace cannot claim another export", async () => {
    const requester = await createTestUser();
    const otherUser = await createTestUser();
    const exportId = await createTestExport({
      notificationStatus: "pending",
      requestedBy: requester.id,
      status: "completed",
    });
    const recording = createRecordingDelivery();

    const wrongRequester = await notifyReportExportStatus({
      delivery: recording.delivery,
      exportId,
      scopedDb: scopedDbFor({ userId: otherUser.id, workspaceId: ids.wsA1 }),
      userId: otherUser.id,
      workspaceId: ids.wsA1,
    });
    const wrongWorkspace = await notifyReportExportStatus({
      delivery: recording.delivery,
      exportId,
      scopedDb: scopedDbFor({ userId: requester.id, workspaceId: ids.wsA2 }),
      userId: requester.id,
      workspaceId: ids.wsA2,
    });

    expect(wrongRequester).toEqual({ status: "skipped" });
    expect(wrongWorkspace).toEqual({ status: "skipped" });
    expect(recording.deliveries).toEqual([]);
    expect(await readNotificationState(exportId)).toEqual({
      notificationAttemptedAt: null,
      notificationStatus: "pending",
    });
  });

  test("does not claim a pending notification before the export is terminal", async () => {
    const requester = await createTestUser();
    const exportId = await createTestExport({
      notificationStatus: "pending",
      requestedBy: requester.id,
      status: "running",
    });
    const recording = createRecordingDelivery();

    const result = await notifyReportExportStatus({
      delivery: recording.delivery,
      exportId,
      scopedDb: scopedDbFor({ userId: requester.id, workspaceId: ids.wsA1 }),
      userId: requester.id,
      workspaceId: ids.wsA1,
    });

    expect(result).toEqual({ status: "skipped" });
    expect(recording.deliveries).toEqual([]);
    expect(await readNotificationState(exportId)).toEqual({
      notificationAttemptedAt: null,
      notificationStatus: "pending",
    });
  });

  test("does not redeliver a notification claimed before a worker crash", async () => {
    const requester = await createTestUser();
    const attemptedAt = new Date("2026-07-17T12:00:00.000Z");
    const exportId = await createTestExport({
      notificationAttemptedAt: attemptedAt,
      notificationStatus: "sending",
      requestedBy: requester.id,
      status: "completed",
    });
    const recording = createRecordingDelivery();

    const result = await notifyReportExportStatus({
      delivery: recording.delivery,
      exportId,
      scopedDb: scopedDbFor({ userId: requester.id, workspaceId: ids.wsA1 }),
      userId: requester.id,
      workspaceId: ids.wsA1,
    });

    expect(result).toEqual({ status: "skipped" });
    expect(recording.deliveries).toEqual([]);
    expect(await readNotificationState(exportId)).toEqual({
      notificationAttemptedAt: attemptedAt,
      notificationStatus: "sending",
    });
  });

  test("suppresses delivery when the requester email is unverified", async () => {
    const requester = await createTestUser({ emailVerified: false });
    const exportId = await createTestExport({
      notificationStatus: "pending",
      requestedBy: requester.id,
      status: "completed",
    });
    const recording = createRecordingDelivery();

    const result = await notifyReportExportStatus({
      delivery: recording.delivery,
      exportId,
      scopedDb: scopedDbFor({ userId: requester.id, workspaceId: ids.wsA1 }),
      userId: requester.id,
      workspaceId: ids.wsA1,
    });

    expect(result).toEqual({ status: "suppressed" });
    expect(recording.deliveries).toEqual([]);
    const row = await readNotificationState(exportId);
    expect(row?.notificationStatus).toBe("suppressed");
    expect(row?.notificationAttemptedAt).toBeInstanceOf(Date);
  });

  test("records an ambiguous delivery rejection without retrying", async () => {
    const requester = await createTestUser();
    const exportId = await createTestExport({
      notificationStatus: "pending",
      requestedBy: requester.id,
      status: "completed",
    });
    const recording = createRecordingDelivery({
      sendError: new Error("simulated transport rejection"),
    });

    const result = await notifyReportExportStatus({
      delivery: recording.delivery,
      exportId,
      scopedDb: scopedDbFor({ userId: requester.id, workspaceId: ids.wsA1 }),
      userId: requester.id,
      workspaceId: ids.wsA1,
    });
    const redelivery = await notifyReportExportStatus({
      delivery: recording.delivery,
      exportId,
      scopedDb: scopedDbFor({ userId: requester.id, workspaceId: ids.wsA1 }),
      userId: requester.id,
      workspaceId: ids.wsA1,
    });

    expect(result).toEqual({ status: "delivery_failed" });
    expect(redelivery).toEqual({ status: "skipped" });
    expect(recording.deliveries).toEqual([
      {
        appUrl: "http://localhost:3000/workspaces",
        email: requester.email,
        lang: "cs",
        status: "completed",
      },
    ]);
    expectPrivacySafe(recording.deliveries);
    const row = await readNotificationState(exportId);
    expect(row?.notificationStatus).toBe("delivery_failed");
    expect(row?.notificationAttemptedAt).toBeInstanceOf(Date);
  });
});

type CreateTestUserOptions = {
  emailVerified?: boolean;
};

const createTestUser = async ({
  emailVerified = true,
}: CreateTestUserOptions = {}) => {
  const id = toSafeId<"user">(Bun.randomUUIDv7());
  const email = `${id}@test.local`;
  await testDb.insert(user).values({
    email,
    emailVerified,
    id,
    name: "Report notification test user",
  });
  createdUserIds.push(id);
  return { email, id };
};

type CreateTestExportOptions = {
  notificationAttemptedAt?: Date;
  notificationStatus: ReportExportNotificationStatus;
  requestedBy: SafeId<"user"> | null;
  status: ReportExportStatus;
};

const createTestExport = async ({
  notificationAttemptedAt,
  notificationStatus,
  requestedBy,
  status,
}: CreateTestExportOptions): Promise<SafeId<"reportExport">> => {
  const id = toSafeId<"reportExport">(Bun.randomUUIDv7());
  await testDb.execute(sql`
    insert into report_exports (
      id,
      workspace_id,
      requested_by,
      template_ref,
      layout,
      status,
      mode,
      error,
      notification_status,
      notification_lang,
      notification_attempted_at
    ) values (
      ${id},
      ${ids.wsA1},
      ${requestedBy},
      ${JSON.stringify({ type: "builtin", key: SENSITIVE_MARKERS[1] })}::jsonb,
      ${JSON.stringify({ type: "table", version: 1, marker: SENSITIVE_MARKERS[0] })}::jsonb,
      ${status},
      'download',
      ${SENSITIVE_MARKERS[2]},
      ${notificationStatus},
      'cs',
      ${notificationAttemptedAt ?? null}
    )
  `);
  createdExportIds.push(id);
  return id;
};

const scopedDbFor = ({
  userId,
  workspaceId,
}: {
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
}): ScopedDb => createScopedDb(testDb, [workspaceId], ids.orgA, userId);

type CreateRecordingDeliveryOptions = {
  sendError?: Error;
};

const createRecordingDelivery = ({
  sendError,
}: CreateRecordingDeliveryOptions = {}) => {
  const deliveries: ReportExportNotificationEmail[] = [];
  return {
    deliveries,
    delivery: {
      isConfigured: () => true,
      send: async (delivery: ReportExportNotificationEmail) => {
        deliveries.push(delivery);
        if (sendError) {
          throw sendError;
        }
      },
    },
  };
};

const readNotificationState = async (id: SafeId<"reportExport">) =>
  await testDb.query.reportExports.findFirst({
    where: { id: { eq: id } },
    columns: {
      notificationAttemptedAt: true,
      notificationStatus: true,
    },
  });

const expectPrivacySafe = (
  deliveries: readonly ReportExportNotificationEmail[],
): void => {
  const serializedDelivery = JSON.stringify(deliveries);
  for (const marker of SENSITIVE_MARKERS) {
    expect(serializedDelivery).not.toContain(marker);
  }
};
