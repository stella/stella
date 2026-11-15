import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { isHttpStatusResponse } from "@/api/http/status";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { readFileHandler } from "@/api/lib/files/read-file";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
const seededEntityIds: SafeId<"entity">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  if (seededEntityIds.length > 0) {
    await testDb
      .delete(fields)
      .where(
        inArray(
          fields.entityVersionId,
          testDb
            .select({ id: entityVersions.id })
            .from(entityVersions)
            .where(inArray(entityVersions.entityId, seededEntityIds)),
        ),
      );
    await testDb
      .delete(entityVersions)
      .where(inArray(entityVersions.entityId, seededEntityIds));
    await testDb.delete(entities).where(inArray(entities.id, seededEntityIds));
  }
  await releaseRlsFixture();
});

const seedFile = async (mimeType: string) => {
  const entityId = createSafeId<"entity">();
  const entityVersionId = createSafeId<"entityVersion">();
  const fieldId = createSafeId<"field">();
  seededEntityIds.push(entityId);
  await testDb.insert(entities).values({
    id: entityId,
    workspaceId: ids.wsA1,
    kind: "document",
    name: "drawing",
  });
  await testDb
    .insert(entityVersions)
    .values({ id: entityVersionId, workspaceId: ids.wsA1, entityId });
  await testDb.insert(fields).values({
    id: fieldId,
    workspaceId: ids.wsA1,
    propertyId: ids.filePropertyA1,
    entityVersionId,
    content: {
      version: 1,
      type: "file",
      id: Bun.randomUUIDv7(),
      fileName: "drawing",
      mimeType,
      sizeBytes: 1,
      encrypted: false,
      sha256Hex: "c".repeat(64),
      pdfFileId: null,
    },
  });
  return { entityVersionId, fieldId };
};

const recordingAudit = () => {
  const events: AuditEvent[] = [];
  const transactions: unknown[] = [];
  const recordAuditEvent: AuditRecorder = async (tx, event) => {
    transactions.push(tx);
    events.push(...(Array.isArray(event) ? event : [event]));
  };
  return { events, recordAuditEvent, transactions };
};

type ReadOptions = {
  fieldId: SafeId<"field">;
  purpose: "download" | "display" | "native-display";
  recordAuditEvent?: AuditRecorder;
  scopedDb?: ScopedDb;
};

const read = async ({
  fieldId,
  purpose,
  recordAuditEvent = recordingAudit().recordAuditEvent,
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  ),
}: ReadOptions) =>
  await readFileHandler({
    fieldId,
    organizationId: ids.orgA,
    purpose,
    readSessionAuthority: async () => null,
    recordAuditEvent,
    scopedDb,
    source: { kind: "request", sessionId: "fixture-session" },
    userId: ids.userA1,
    workspaceId: ids.wsA1,
  });

describe("a file with nothing to show", () => {
  test.each(["display", "native-display"] as const)(
    "answers %s with the typed code clients act on",
    async (purpose) => {
      const { fieldId } = await seedFile("image/svg+xml");

      const answer = await read({ fieldId, purpose });

      expect(isHttpStatusResponse(answer)).toBe(true);
      expect(answer).toMatchObject({
        code: 400,
        response: { code: PREVIEW_UNAVAILABLE_ERROR_CODE },
      });
    },
  );
});

describe("a file link and its version", () => {
  test("is looked up, audited and signed in one transaction", async () => {
    const { fieldId } = await seedFile("application/pdf");
    const scopedDb = asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    );
    const opened: unknown[] = [];
    const counting = asTestRaw<ScopedDb>(
      async (fn: Parameters<ScopedDb>[0]) =>
        await scopedDb(async (tx) => {
          opened.push(tx);
          return await fn(tx);
        }),
    );
    const { events, recordAuditEvent, transactions } = recordingAudit();

    const answer = await read({
      fieldId,
      purpose: "download",
      recordAuditEvent,
      scopedDb: counting,
    });

    expect(answer).toHaveProperty("presignedUrl");
    expect(events).toHaveLength(1);
    // A second transaction would sign after the one that found the version
    // live had released it, leaving room for a tombstone in between.
    expect(opened).toHaveLength(1);
    expect(transactions).toEqual(opened);
  });

  test.each(["download", "display", "native-display"] as const)(
    "a %s of a tombstoned version answers 404 and records nothing",
    async (purpose) => {
      const { entityVersionId, fieldId } = await seedFile("application/pdf");
      await testDb
        .update(entityVersions)
        .set({ deletedAt: new Date("2026-02-01T00:00:00.000Z") })
        .where(eq(entityVersions.id, entityVersionId));
      const { events, recordAuditEvent } = recordingAudit();

      const answer = await read({ fieldId, purpose, recordAuditEvent });

      expect(answer).toMatchObject({ code: 404 });
      expect(events).toEqual([]);
    },
  );
});
