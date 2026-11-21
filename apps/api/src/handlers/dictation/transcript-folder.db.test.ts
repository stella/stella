import { Result } from "better-result";
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities, workspaces } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { createTranscriptFolder } from "./transcript-folder";

let testDb: TestDatabase;
let ids: TestIds;
let scopedDb: ScopedDb;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  );
});

afterAll(async () => {
  await releaseRlsFixture();
});

test("a matter archived after the save was authorized receives no folder", async () => {
  const recordAuditEvent = mock(async () => undefined);
  const before = await testDb.$count(
    entities,
    eq(entities.workspaceId, ids.wsA1),
  );
  // Archived after the handler read the matter, before the folder's
  // transaction: only the status read under the matter's lock sees it.
  await testDb
    .update(workspaces)
    .set({ status: "archived" })
    .where(eq(workspaces.id, ids.wsA1));
  try {
    const created = await createTranscriptFolder({
      scopedDb,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      title: "Memo to file",
      entityCount: 2,
      recordAuditEvent: asTestRaw<AuditRecorder>(recordAuditEvent),
    });
    expect(
      Result.isError(created) && HandlerError.is(created.error)
        ? created.error.status
        : null,
    ).toBe(409);
    expect(
      await testDb.$count(entities, eq(entities.workspaceId, ids.wsA1)),
    ).toBe(before);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  } finally {
    await testDb
      .update(workspaces)
      .set({ status: "active" })
      .where(eq(workspaces.id, ids.wsA1));
  }
});
