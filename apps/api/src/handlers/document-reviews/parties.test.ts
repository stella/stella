/**
 * The launcher's first-screen call: a document version that already has a
 * cached party detection answers from that row alone, with no model call and
 * no write.
 */

import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import reviewParties from "./parties";

type ReviewPartiesCtx = Parameters<typeof reviewParties.handler>[0];

const WORKSPACE_ID = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000001",
);
const ENTITY_ID = toSafeId<"entity">("00000000-0000-0000-0000-000000000002");
const ENTITY_VERSION_ID = toSafeId<"entityVersion">(
  "00000000-0000-0000-0000-000000000003",
);
const FIELD_ID = toSafeId<"field">("00000000-0000-0000-0000-000000000004");
const USER_ID = toSafeId<"user">("user_01JQ8Z3W6R5K2N4P7T9V1X3Y5A");

const fileContent = {
  version: 1 as const,
  type: "file" as const,
  id: "00000000-0000-0000-0000-000000000005",
  fileName: "agreement.docx",
  mimeType: DOCX_MIME_TYPE,
  sizeBytes: 1024,
  encrypted: false,
  sha256Hex: "a".repeat(64),
  pdfFileId: null,
};

const entityRow = {
  id: ENTITY_ID,
  workspaceId: WORKSPACE_ID,
  currentVersion: {
    id: ENTITY_VERSION_ID,
    fields: [{ id: FIELD_ID, content: fileContent }],
  },
};

const cachedParties = [
  { role: "Purchaser", name: "Example Holdings a.s." },
  { role: "Seller", name: null },
];

const createHarness = () => {
  let insertCalled = false;
  const { safeDb, scopedDb } = createScopedDbMock({
    query: {
      entities: { findMany: async () => [entityRow] },
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ parties: cachedParties }],
        }),
      }),
    }),
    insert: () => {
      insertCalled = true;
      throw new Error("cache hit must not write");
    },
  });

  const context = asTestRaw<ReviewPartiesCtx>({
    body: { target: { entityId: ENTITY_ID, fileFieldId: FIELD_ID } },
    memberRole: { role: "owner" },
    workspaceId: WORKSPACE_ID,
    safeDb,
    scopedDb,
    session: {
      activeOrganizationId: toSafeId<"organization">("org_test_parties"),
    },
    user: { id: USER_ID },
    orgAIConfig: null,
    promptCachingEnabled: false,
  });

  return { context, insertCalled: () => insertCalled };
};

describe("reviewParties", () => {
  test("answers from the cached row without a model call or a write", async () => {
    const { context, insertCalled } = createHarness();

    const result = await reviewParties.handler(context);

    expect(result).toEqual({
      entityVersionId: ENTITY_VERSION_ID,
      parties: cachedParties,
    });
    expect(insertCalled()).toBe(false);
  });
});
