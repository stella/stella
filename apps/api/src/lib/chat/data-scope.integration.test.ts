import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  expandThreadDataScope,
  replaceThreadDataScopeOnTx,
} from "@/api/lib/chat/data-scope";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
}, 120_000);

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
}, 120_000);

const unwrap = <T>(result: Result<T, unknown>): T => {
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

describe("chat data scope widening", () => {
  test("records successive widenings as a truthful audit transition chain", async () => {
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);
    await testDb.insert(chatThreads).values({
      id: threadId,
      organizationId: ids.orgA,
      title: "Scope transition chain",
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    });

    const auditEvents: AuditEvent[] = [];
    const recordAuditEvent: AuditRecorder = async (_tx, event) => {
      if (Array.isArray(event)) {
        auditEvents.push(...event);
        return;
      }
      auditEvents.push(event);
    };

    const first = unwrap(
      await expandThreadDataScope({
        newWorkspaceIds: [ids.wsA1],
        recordAuditEvent,
        safeDb,
        threadId,
        threadWorkspaceId: ids.wsA1,
      }),
    );
    const second = unwrap(
      await expandThreadDataScope({
        newWorkspaceIds: [ids.wsA2],
        recordAuditEvent,
        safeDb,
        threadId,
        threadWorkspaceId: ids.wsA1,
      }),
    );

    const persisted = (
      await testDb
        .select({ dataWorkspaceIds: chatThreads.dataWorkspaceIds })
        .from(chatThreads)
        .where(eq(chatThreads.id, threadId))
    ).at(0);

    expect(first).toEqual([ids.wsA1]);
    expect(second).toEqual([ids.wsA1, ids.wsA2]);
    expect(persisted?.dataWorkspaceIds).toEqual(second);
    expect(auditEvents.map((event) => event.changes)).toEqual([
      { dataWorkspaceIds: { old: [], new: [ids.wsA1] } },
      {
        dataWorkspaceIds: {
          old: [ids.wsA1],
          new: [ids.wsA1, ids.wsA2],
        },
      },
    ]);
  });

  test("replay replacement preserves a widening committed after its snapshot", async () => {
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);
    await testDb.insert(chatThreads).values({
      dataWorkspaceIds: [ids.wsA1],
      id: threadId,
      organizationId: ids.orgA,
      title: "Replay scope transition",
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    });

    const auditEvents: AuditEvent[] = [];
    const replacement = unwrap(
      await safeDb(
        async (tx) =>
          await replaceThreadDataScopeOnTx({
            newDataWorkspaceIds: [ids.wsA2],
            observedDataWorkspaceIds: [],
            recordAuditEvent: async (_tx, event) => {
              if (Array.isArray(event)) {
                auditEvents.push(...event);
                return;
              }
              auditEvents.push(event);
            },
            threadId,
            threadWorkspaceId: ids.wsA1,
            tx,
          }),
      ),
    );

    expect(replacement).toEqual([ids.wsA2, ids.wsA1]);
    expect(auditEvents.map((event) => event.changes)).toEqual([
      {
        dataWorkspaceIds: {
          old: [ids.wsA1],
          new: [ids.wsA2, ids.wsA1],
        },
      },
    ]);
  });
});
