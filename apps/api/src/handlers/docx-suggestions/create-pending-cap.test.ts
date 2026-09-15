import { panic } from "better-result";
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
import revertDocxSuggestion from "@/api/handlers/docx-suggestions/revert";
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

const operation = (id: string) =>
  ({
    id,
    type: "replaceInBlock",
    blockId: "block-1",
    find: "before",
    replace: "after",
  }) satisfies FolioAIEditOperation;

const PENDING_LIMIT_REFUSAL = {
  code: 409,
  response: { code: DOCX_SUGGESTIONS_PENDING_LIMIT_ERROR_CODE },
};

type SeededDocument = {
  entityId: SafeId<"entity">;
  pendingIds: SafeId<"docxSuggestion">[];
  rejectedIds: SafeId<"docxSuggestion">[];
};

// A document of its own per case, so the rows seeded here fill only its cap.
const seedDocument = async ({
  pending,
  rejected,
}: {
  pending: number;
  rejected: number;
}): Promise<SeededDocument> => {
  const entityId = createSafeId<"entity">();
  await testDb.insert(entities).values({
    id: entityId,
    workspaceId: ids.wsA1,
    kind: "document",
    name: `capped-${entityId}`,
  });
  const seeded = (status: "pending" | "rejected", total: number) =>
    Array.from({ length: total }, (_, index) => ({
      id: createSafeId<"docxSuggestion">(),
      workspaceId: ids.wsA1,
      entityId,
      opPayload: operation(`seed-${status}-${index}`),
      severity: "medium" as const,
      area: "body",
      status,
    }));
  const pendingRows = seeded("pending", pending);
  const rejectedRows = seeded("rejected", rejected);
  await testDb
    .insert(docxSuggestions)
    .values([...pendingRows, ...rejectedRows]);
  return {
    entityId,
    pendingIds: pendingRows.map((row) => row.id),
    rejectedIds: rejectedRows.map((row) => row.id),
  };
};

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
});

afterAll(async () => {
  await releaseTestDb();
});

const handlerContext = () => {
  const activeWorkspaceIds = [ids.wsA1];
  return {
    memberRole: { role: "owner" },
    request: new Request(`https://example.test/docx-suggestions/${ids.wsA1}`),
    route: "/docx-suggestions/pending-cap",
    recordAuditEvent: async () => {},
    safeDb: createSafeDb(testDb, activeWorkspaceIds, ids.orgA, ids.userA1),
    scopedDb: createScopedDb(testDb, activeWorkspaceIds, ids.orgA, ids.userA1),
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
    workspaceId: ids.wsA1,
  };
};

const createIn = async (
  entityId: SafeId<"entity">,
  refs: readonly string[],
) => {
  const context = {
    ...handlerContext(),
    params: { workspaceId: ids.wsA1, entityId },
    body: {
      suggestions: refs.map((ref) => ({
        ref,
        opPayload: operation(ref),
        severity: "medium",
        area: "body",
      })),
    },
  };
  const result: unknown = await createDocxSuggestions
    .handler(
      asTestRaw<Parameters<typeof createDocxSuggestions.handler>[0]>(context),
    )
    .catch((error: unknown) => error);
  return result;
};

const revertIn = async (
  entityId: SafeId<"entity">,
  suggestionId: SafeId<"docxSuggestion">,
) => {
  const context = {
    ...handlerContext(),
    params: { workspaceId: ids.wsA1, entityId, suggestionId },
  };
  const result: unknown = await revertDocxSuggestion
    .handler(
      asTestRaw<Parameters<typeof revertDocxSuggestion.handler>[0]>(context),
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

const statusOf = async (suggestionId: SafeId<"docxSuggestion">) => {
  const rows = await testDb
    .select({ status: docxSuggestions.status })
    .from(docxSuggestions)
    .where(eq(docxSuggestions.id, suggestionId));
  return rows.at(0)?.status;
};

describe("the per-document pending suggestion cap", () => {
  test("create refuses a batch past the cap, inserts nothing, and accepts one that fits", async () => {
    const { entityId } = await seedDocument({
      pending: DOCX_SUGGESTIONS_PENDING_MAX - 1,
      rejected: 5,
    });

    expect(await createIn(entityId, ["over-1", "over-2"])).toMatchObject(
      PENDING_LIMIT_REFUSAL,
    );
    expect(await countPending(entityId)).toBe(DOCX_SUGGESTIONS_PENDING_MAX - 1);

    expect(await createIn(entityId, ["fits-1"])).toEqual({
      createdAt: expect.any(Date),
      items: [{ ref: "fits-1", id: expect.any(String) }],
    });
    expect(await countPending(entityId)).toBe(DOCX_SUGGESTIONS_PENDING_MAX);

    expect(await createIn(entityId, ["full-1"])).toMatchObject(
      PENDING_LIMIT_REFUSAL,
    );
  });

  test("revert refuses to reopen a resolved suggestion at the cap, and reopens it once there is room", async () => {
    const { entityId, pendingIds, rejectedIds } = await seedDocument({
      pending: DOCX_SUGGESTIONS_PENDING_MAX,
      rejected: 1,
    });
    const rejectedId =
      rejectedIds.at(0) ?? panic("The seeded rejected row is missing");
    const pendingId =
      pendingIds.at(0) ?? panic("The seeded pending row is missing");

    expect(await revertIn(entityId, rejectedId)).toMatchObject(
      PENDING_LIMIT_REFUSAL,
    );
    expect(await statusOf(rejectedId)).toBe("rejected");
    expect(await countPending(entityId)).toBe(DOCX_SUGGESTIONS_PENDING_MAX);

    // Reverting a row that is already pending adds nothing, so it stays the
    // usual no-op rather than a refusal.
    expect(await revertIn(entityId, pendingId)).toEqual({ updated: false });

    await testDb
      .update(docxSuggestions)
      .set({ status: "rejected" })
      .where(eq(docxSuggestions.id, pendingId));
    expect(await revertIn(entityId, rejectedId)).toEqual({ updated: true });
    expect(await statusOf(rejectedId)).toBe("pending");
  });
});
