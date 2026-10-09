// The STELLA_RUN_POSTGRES_TESTS runner also executes this verification suite.
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { user } from "@/api/db/auth-schema";
import { createSafeDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { AI_CONFIG_UNREADABLE_ERROR_CODE } from "@/api/lib/ai-config-response";
import { createSafeId } from "@/api/lib/branded-types";
import {
  NO_AUDIT,
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import createVerification from "./create";

setDefaultTimeout(120_000);
let testDb: TestDatabase;
let ids: TestIds;
beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  await testDb
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, ids.userA1));
});
afterAll(async () => await releaseRlsFixture());

describe("verification creation requires complete AI admission", () => {
  test.each([
    {
      status: ORG_AI_CONFIG_STATUS.ownKeyRequired,
      expectedStatus: 403,
      expectedCode: undefined,
    },
    {
      status: ORG_AI_CONFIG_STATUS.unreadable,
      expectedStatus: 503,
      expectedCode: AI_CONFIG_UNREADABLE_ERROR_CODE,
    },
    {
      status: ORG_AI_CONFIG_STATUS.memberAssignmentRequired,
      expectedStatus: 403,
      expectedCode: "ai_member_assignment_required",
    },
  ])(
    "returns the typed $status error before document lookup",
    async ({ status, expectedStatus, expectedCode }) => {
      const previous = env.API_FEATURE_ACCESS_GRANTS;
      const previousDeployment = env.FEATURE_LEGAL_LISTS;
      env.FEATURE_LEGAL_LISTS = true;
      env.API_FEATURE_ACCESS_GRANTS = {
        "legal-lists": [{ type: "organization", organizationId: ids.orgA }],
        "list-verification": [
          { type: "organization", organizationId: ids.orgA },
        ],
      };
      const scoped = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
      let transactions = 0;
      const safeDb: typeof scoped = async (operation) => {
        transactions++;
        return await scoped(operation);
      };
      try {
        const result = await createVerification.handler(
          createTestHandlerContext<
            Parameters<typeof createVerification.handler>[0]
          >({
            audit: NO_AUDIT,
            scopedDb: NO_DB,
            workspaceId: ids.wsA1,
            session: { activeOrganizationId: ids.orgA },
            user: { id: ids.userA1 },
            safeDb,
            orgAIConfig: null,
            orgAIConfigStatus: status,
            body: {
              listId: createSafeId<"legalList">(),
              entityId: ids.entityA1,
              fileFieldId: ids.fileFieldA1,
            },
          }),
        );
        expect(result).toBeInstanceOf(ElysiaCustomStatusResponse);
        if (result instanceof ElysiaCustomStatusResponse) {
          expect(result.code).toBe(expectedStatus);
          if (expectedCode !== undefined) {
            expect(result.response).toHaveProperty("code", expectedCode);
          }
        }
        // Identity and resource preflight settle before document, run or queue work.
        expect(transactions).toBe(2);
      } finally {
        env.API_FEATURE_ACCESS_GRANTS = previous;
        env.FEATURE_LEGAL_LISTS = previousDeployment;
      }
    },
  );
});
