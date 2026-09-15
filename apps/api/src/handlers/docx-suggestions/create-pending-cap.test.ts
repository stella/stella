import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";

import {
  DOCX_SUGGESTIONS_PENDING_LIMIT_ERROR_CODE,
  DOCX_SUGGESTIONS_PENDING_MAX,
} from "@stll/api-contract";
import type { FolioAIEditOperation } from "@stll/folio-core/ai-edits";

import { docxSuggestions, entities } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import createDocxSuggestions from "@/api/handlers/docx-suggestions/create";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
// A document of its own, so the rows seeded here fill only its pending cap.
const cappedEntityId = createSafeId<"entity">();

const operation = (id: string) =>
  ({
    id,
    type: "replaceInBlock",
    blockId: "block-1",
    find: "before",
    replace: "after",
  }) satisfies FolioAIEditOperation;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  await testDb.insert(entities).values({
    id: cappedEntityId,
    workspaceId: ids.wsA1,
    kind: "document",
    name: "cappedEntity",
  });
  const seeded = (status: "pending" | "rejected", total: number) =>
    Array.from({ length: total }, (_, index) => ({
      id: createSafeId<"docxSuggestion">(),
      workspaceId: ids.wsA1,
      entityId: cappedEntityId,
      opPayload: operation(`seed-${status}-${index}`),
      severity: "medium" as const,
      area: "body",
      status,
    }));
  await testDb
    .insert(docxSuggestions)
    .values([
      ...seeded("pending", DOCX_SUGGESTIONS_PENDING_MAX - 1),
      ...seeded("rejected", 5),
    ]);
});

afterAll(async () => {
  await releaseTestDb();
});

const createInCappedEntity = async (refs: readonly string[]) => {
  const activeWorkspaceIds = [ids.wsA1];
  const context = {
    memberRole: { role: "owner" },
    request: new Request(`https://example.test/docx-suggestions/${ids.wsA1}`),
    route: "/docx-suggestions/pending-cap",
    params: { workspaceId: ids.wsA1, entityId: cappedEntityId },
    body: {
      suggestions: refs.map((ref) => ({
        ref,
        opPayload: operation(ref),
        severity: "medium",
        area: "body",
      })),
    },
    safeDb: createSafeDb(testDb, activeWorkspaceIds, ids.orgA, ids.userA1),
    scopedDb: createScopedDb(testDb, activeWorkspaceIds, ids.orgA, ids.userA1),
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
    workspaceId: ids.wsA1,
  };
  const result: unknown = await createDocxSuggestions
    .handler(
      asTestRaw<Parameters<typeof createDocxSuggestions.handler>[0]>(context),
    )
    .catch((error: unknown) => error);
  return result;
};

const countPending = async (entityId: SafeId<"entity">) => {
  const rows = await testDb
    .select({ id: docxSuggestions.id })
    .from(docxSuggestions)
    .where(
      and(
        eq(docxSuggestions.entityId, entityId),
        eq(docxSuggestions.status, "pending"),
      ),
    );
  return rows.length;
};

describe("the per-document pending suggestion cap", () => {
  test("refuses a batch past the cap, inserts nothing, and accepts one that fits", async () => {
    const refused = await createInCappedEntity(["over-1", "over-2"]);
    expect(refused).toMatchObject({
      code: 409,
      response: { code: DOCX_SUGGESTIONS_PENDING_LIMIT_ERROR_CODE },
    });
    expect(await countPending(cappedEntityId)).toBe(
      DOCX_SUGGESTIONS_PENDING_MAX - 1,
    );

    const accepted = await createInCappedEntity(["fits-1"]);
    expect(accepted).toEqual({
      items: [{ ref: "fits-1", id: expect.any(String) }],
    });
    expect(await countPending(cappedEntityId)).toBe(
      DOCX_SUGGESTIONS_PENDING_MAX,
    );

    const full = await createInCappedEntity(["full-1"]);
    expect(full).toMatchObject({
      code: 409,
      response: { code: DOCX_SUGGESTIONS_PENDING_LIMIT_ERROR_CODE },
    });
  });
});
