/**
 * The launcher's first-screen call: a document version that already has a
 * cached party detection answers from that row alone, with no model call and
 * no write; a version that does not reaches the model, and a provider failure
 * there answers with the status that names it rather than an opaque 500.
 */

import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";
import type { detectReviewParties } from "@/api/lib/document-review/parties";
import type { fetchAndPrepareReviewFiles } from "@/api/lib/document-review/prepare-review-files";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import {
  modelStepFailure,
  PROVIDER_FAILURE_CASES,
} from "@/api/tests/helpers/provider-failure-cases";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import reviewParties, { createReviewParties } from "./parties";

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

/** A BYOK org whose `pdf` role resolves, so the availability guard passes. */
const orgAIConfig = {
  providers: [{ provider: "openai", apiKey: "test-api-key" }],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-5.4-mini" },
    fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    pdf: { provider: "openai", modelId: "gpt-5.4" },
    reasoning: { provider: "openai", modelId: "gpt-5.4" },
  },
} satisfies OrgAIConfig;

const createHarness = ({
  cachedRows = [{ parties: cachedParties }],
}: { cachedRows?: { parties: unknown }[] } = {}) => {
  let insertCalled = false;
  const { safeDb, scopedDb } = createScopedDbMock({
    query: {
      entities: { findMany: async () => [entityRow] },
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => cachedRows,
        }),
      }),
    }),
    insert: () => {
      insertCalled = true;
      throw new Error("cache hit must not write");
    },
  });

  const context = createTestHandlerContext<ReviewPartiesCtx>({
    body: { target: { entityId: ENTITY_ID, fileFieldId: FIELD_ID } },
    workspaceId: WORKSPACE_ID,
    safeDb,
    scopedDb,
    session: {
      activeOrganizationId: toSafeId<"organization">("org_test_parties"),
    },
    user: { id: USER_ID },
    orgAIConfig,
    promptCachingEnabled: false,
  });

  return { context, insertCalled: () => insertCalled };
};

/** A prepared DOCX target: the detection fake never reads it. */
const prepareReviewFilesFake = asTestRaw<typeof fetchAndPrepareReviewFiles>(
  async () => await Promise.resolve([{ kind: "docx" }]),
);

const partiesFailingWith = (cause: unknown): typeof detectReviewParties =>
  asTestRaw<typeof detectReviewParties>(
    async () => await Promise.resolve(Result.err(modelStepFailure(cause))),
  );

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

  for (const { cause, message, name, status } of PROVIDER_FAILURE_CASES) {
    test(`answers ${name} with the status that names it`, async () => {
      const { context, insertCalled } = createHarness({ cachedRows: [] });
      const handler = createReviewParties({
        detectParties: partiesFailingWith(cause),
        prepareReviewFiles: prepareReviewFilesFake,
      });

      const result = await handler.handler(context);

      if (!("code" in result)) {
        throw new Error("Expected the provider failure to return a status");
      }
      expect(result.code).toBe(status);
      expect(result.response).toMatchObject({ message });
      // A failed detection has nothing to cache: the row would answer every
      // later call for this version with a result no model produced.
      expect(insertCalled()).toBe(false);
    });
  }
});
