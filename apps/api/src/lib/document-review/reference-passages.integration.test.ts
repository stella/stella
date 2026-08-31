/**
 * The isolation a reference passage's words depend on: `document_review_
 * reference_passages` is owned by the matter the reference document belongs
 * to, and every surface that answers a passage's text — a direct read, the
 * passages endpoint, and the pin-time check a run or playbook goes through —
 * must answer it only when the caller's own transaction can open that matter.
 * Only PostgreSQL enforces this (row security), so it is exercised against a
 * real schema rather than asserted about the query builder.
 */

import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { documentReviewReferencePassages } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import readDocumentReviewPassages from "@/api/handlers/document-reviews/read-passages";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  readableReferencePassageIds,
  readReferencePassageTexts,
} from "@/api/lib/document-review/reference-passages";
import type { PlaybookPositions } from "@/api/lib/workflow/playbook-positions";
import { assertPositionsValid } from "@/api/lib/workflow/playbook-positions-validation";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;

const PASSAGE_A_ID = toSafeId<"documentReviewReferencePassage">(
  "88888888-8888-4888-8888-888888888888",
);
const PASSAGE_B_ID = toSafeId<"documentReviewReferencePassage">(
  "99999999-9999-4999-8999-999999999999",
);
const PASSAGE_A_TEXT = "This Agreement is governed by English law.";
const PASSAGE_B_TEXT = "This Agreement is governed by Delaware law.";

const noopAuditRecorder: AuditRecorder = async () => undefined;

const rootHandlerContext = (safeDb: ReturnType<typeof createSafeDb>) => ({
  createAuditRecorder: () => noopAuditRecorder,
  getWorkspaceAccess: async () => null,
  memberRole: { role: "owner" as const },
  orgAIConfig: null,
  promptCachingEnabled: false,
  recordAuditEvent: noopAuditRecorder,
  request: new Request("https://example.test/document-reviews/passages"),
  route: "/document-reviews/passages",
  safeDb,
  session: { activeOrganizationId: ids.orgA },
  user: { id: ids.userA1 },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const statusOf = (result: unknown): number | null => {
  if (!isRecord(result)) {
    return null;
  }
  for (const field of ["status", "statusCode", "code"] as const) {
    const value = result[field];
    if (typeof value === "number") {
      return value;
    }
  }
  return null;
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;

  // Two passages, each owned by a different matter (and, per the fixture,
  // a different organization): the row the wsA1-scoped connection may read,
  // and the row it must not.
  await testDb.insert(documentReviewReferencePassages).values([
    {
      id: PASSAGE_A_ID,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      entityId: ids.entityA1,
      fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
      entityVersionId: ids.entityVersionA1,
      blockId: "para-1",
      text: PASSAGE_A_TEXT,
    },
    {
      id: PASSAGE_B_ID,
      organizationId: ids.orgB,
      workspaceId: ids.wsB1,
      entityId: ids.entityB1,
      fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
      entityVersionId: ids.entityVersionB1,
      blockId: "para-1",
      text: PASSAGE_B_TEXT,
    },
  ]);
});

afterAll(async () => {
  try {
    await testDb
      .delete(documentReviewReferencePassages)
      .where(
        inArray(documentReviewReferencePassages.id, [
          PASSAGE_A_ID,
          PASSAGE_B_ID,
        ]),
      );
  } finally {
    await releaseRlsFixture();
  }
});

describe("reference passage isolation", () => {
  test("readReferencePassageTexts answers only the readable matter through a scoped transaction", async () => {
    const scopedSafeDb = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);

    const scopedResult = await scopedSafeDb(
      async (tx) =>
        await readReferencePassageTexts(tx, [PASSAGE_A_ID, PASSAGE_B_ID]),
    );
    if (Result.isError(scopedResult)) {
      throw new TypeError("expected a successful scoped read");
    }
    expect([...scopedResult.value]).toEqual([[PASSAGE_A_ID, PASSAGE_A_TEXT]]);

    // Through the root connection (service access) both rows exist.
    const rootTexts = await readReferencePassageTexts(testDb, [
      PASSAGE_A_ID,
      PASSAGE_B_ID,
    ]);
    expect(Object.fromEntries(rootTexts)).toEqual({
      [PASSAGE_A_ID]: PASSAGE_A_TEXT,
      [PASSAGE_B_ID]: PASSAGE_B_TEXT,
    });
  });

  test("readableReferencePassageIds reports only what the scoped transaction can open", async () => {
    const scopedSafeDb = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);

    const scopedResult = await scopedSafeDb(
      async (tx) =>
        await readableReferencePassageIds(tx, [PASSAGE_A_ID, PASSAGE_B_ID]),
    );
    if (Result.isError(scopedResult)) {
      throw new TypeError("expected a successful scoped read");
    }
    expect([...scopedResult.value]).toEqual([PASSAGE_A_ID]);

    const rootReadable = await readableReferencePassageIds(testDb, [
      PASSAGE_A_ID,
      PASSAGE_B_ID,
    ]);
    expect([...rootReadable].toSorted()).toEqual(
      [PASSAGE_A_ID, PASSAGE_B_ID].toSorted(),
    );
  });

  test("the passages endpoint answers only the caller's own matter", async () => {
    const scopedSafeDb = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);

    const result = await readDocumentReviewPassages.handler(
      asTestRaw<Parameters<typeof readDocumentReviewPassages.handler>[0]>({
        ...rootHandlerContext(scopedSafeDb),
        body: { ids: [PASSAGE_A_ID, PASSAGE_B_ID] },
      }),
    );

    expect(statusOf(result)).toBeNull();
    expect(isRecord(result) ? result.passages : null).toEqual([
      { id: PASSAGE_A_ID, text: PASSAGE_A_TEXT },
    ]);
  });

  describe("assertPositionsValid", () => {
    const positionsPinning = (
      passageId: SafeId<"documentReviewReferencePassage">,
    ): PlaybookPositions => ({
      version: 3,
      items: [
        {
          mode: "graded",
          sourceId: "77777777-7777-4777-8777-777777777771",
          issue: "Governing law",
          severity: "high",
          standard: {
            source: "reference",
            termKind: "language",
            passages: [
              {
                id: passageId,
                workspaceId: ids.wsA1,
                entityId: ids.entityA1,
                fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
                entityVersionId: ids.entityVersionA1,
                blockId: "para-1",
              },
            ],
          },
          ask: { mode: "auto" },
          enabled: true,
        },
      ],
    });

    test("accepts a position pinning a passage the caller's matter owns", async () => {
      const scopedSafeDb = createSafeDb(
        testDb,
        [ids.wsA1],
        ids.orgA,
        ids.userA1,
      );

      const result = await assertPositionsValid(
        asTestRaw<Parameters<typeof assertPositionsValid>[0]>({
          safeDb: scopedSafeDb,
          organizationId: ids.orgA,
          positions: positionsPinning(PASSAGE_A_ID),
        }),
      );

      expect(Result.isOk(result)).toBe(true);
    });

    // The grader later reads a pinned passage with service access on the
    // author's behalf; a position must not be persisted with a passage the
    // author's own transaction cannot open, or the grader would describe a
    // matter's own words back through someone else's checklist.
    test("refuses a position pinning a passage from a matter the caller cannot open", async () => {
      const scopedSafeDb = createSafeDb(
        testDb,
        [ids.wsA1],
        ids.orgA,
        ids.userA1,
      );

      const result = await assertPositionsValid(
        asTestRaw<Parameters<typeof assertPositionsValid>[0]>({
          safeDb: scopedSafeDb,
          organizationId: ids.orgA,
          positions: positionsPinning(PASSAGE_B_ID),
        }),
      );

      expect(Result.isError(result)).toBe(true);
      expect(Result.isError(result) ? result.error : null).toMatchObject({
        status: 403,
      });
    });
  });
});
