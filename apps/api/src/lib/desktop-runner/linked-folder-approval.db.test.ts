import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { DESKTOP_RUNNER_PROTOCOL } from "@stll/api-contract/desktop-runner";
import { rejectionOf } from "@stll/property-testing/rejection";
import { createTestClock } from "@stll/test-kit";

import { auditLogs, desktopRunners } from "@/api/db/schema";
import {
  AUDIT_RESOURCE_TYPE,
  type AuditRecorder,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import {
  approveLinkedFolder,
  type DesktopRunnerDb,
  type RunOwner,
} from "@/api/lib/desktop-runner/store";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const ids = createTestIds();
const clock = createTestClock();
let db: TestDatabase;

const owner: RunOwner = { userId: ids.userA1, organizationId: ids.orgA };

// SAFETY: the test database exposes the same Drizzle query and transaction
// APIs as the owner connection the gateway's store runs on.
const runnerDb = () => asTestRaw<DesktopRunnerDb>(db);

/** A connected computer of the member that reports one linked folder. */
const seedComputer = async () => {
  const desktopId = Bun.randomUUIDv7();
  const linkId = Bun.randomUUIDv7();
  const now = new Date(clock.now());
  await db.insert(desktopRunners).values({
    userId: owner.userId,
    organizationId: owner.organizationId,
    desktopId,
    deviceJkt: `jkt-${desktopId}`,
    keyId: `key-${desktopId}`,
    sessionId: Bun.randomUUIDv7(),
    instanceId: "api-test",
    connection: "connected",
    protocol: DESKTOP_RUNNER_PROTOCOL.current,
    appVersion: "1.4.0",
    sidecarVersion: "1.4.0",
    harnesses: [],
    linkedFolders: [{ id: linkId, name: "Matter files", state: "available" }],
    connectedAt: now,
    lastSeenAt: now,
  });
  return { desktopId, linkId };
};

const approvedFolderIds = async (desktopId: string) =>
  (
    await db
      .select({ approved: desktopRunners.approvedFolderIds })
      .from(desktopRunners)
      .where(eq(desktopRunners.desktopId, desktopId))
  ).flatMap(({ approved }) => approved);

const approvalAudits = async (linkId: string) =>
  await db
    .select({ resourceId: auditLogs.resourceId })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.resourceId, linkId),
        eq(
          auditLogs.resourceType,
          AUDIT_RESOURCE_TYPE.CHAT_LOCAL_FOLDER_APPROVAL,
        ),
      ),
    );

const memberRecorder = () =>
  createBackgroundAuditRecorder({
    organizationId: owner.organizationId,
    workspaceId: null,
    userId: owner.userId,
    execution: {
      performer: { type: "user", id: owner.userId },
      trigger: { type: "direct" },
    },
  });

// timeout: seeding the shared RLS fixtures runs many inserts on a cold database
beforeAll(async () => {
  db = await getTestDb();
  await setupRlsTestData(db, ids);
}, 30_000);
afterAll(releaseTestDb);

describe("the member's OK for a linked folder", () => {
  test("is kept with its audit event", async () => {
    const { desktopId, linkId } = await seedComputer();

    expect(
      await approveLinkedFolder(runnerDb(), {
        owner,
        desktopId,
        linkId,
        recordAuditEvent: memberRecorder(),
      }),
    ).toBe(true);

    expect(await approvedFolderIds(desktopId)).toEqual([linkId]);
    expect(await approvalAudits(linkId)).toEqual([{ resourceId: linkId }]);
  });

  test("is not kept when its audit event cannot be written", async () => {
    const { desktopId, linkId } = await seedComputer();
    const failingRecorder: AuditRecorder = async () => {
      await Promise.resolve();
      throw new Error("audit write failed");
    };

    const failure = await rejectionOf(
      approveLinkedFolder(runnerDb(), {
        owner,
        desktopId,
        linkId,
        recordAuditEvent: failingRecorder,
      }),
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : null).toBe(
      "audit write failed",
    );

    expect(await approvedFolderIds(desktopId)).toEqual([]);
    expect(await approvalAudits(linkId)).toEqual([]);
  });

  test("records nothing for a folder the computer does not report", async () => {
    const { desktopId } = await seedComputer();
    const unlisted = Bun.randomUUIDv7();

    expect(
      await approveLinkedFolder(runnerDb(), {
        owner,
        desktopId,
        linkId: unlisted,
        recordAuditEvent: memberRecorder(),
      }),
    ).toBe(false);

    expect(await approvedFolderIds(desktopId)).toEqual([]);
    expect(await approvalAudits(unlisted)).toEqual([]);
  });
});
