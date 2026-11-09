/**
 * Starting a fact extraction: the AI admission settles before any document
 * is read, every document must be a readable one in the matter, and the run
 * counts against the organization's list AI run budget it shares with
 * verifications, so a full budget refuses the start without queuing a run.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { createTestState } from "@stll/test-state";

import { user } from "@/api/db/auth-schema";
import {
  legalListGenerationRuns,
  legalLists,
  legalListVerificationBudgets,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { HttpStatusResponse } from "@/api/http/status";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import createFactExtraction from "./create";

let testDb: TestDatabase;
let ids: TestIds;
const listId = createSafeId<"legalList">();
const testState = createTestState({ file: import.meta.path, config: env });

testState.beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  await testDb
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, ids.userA1));
  await testDb.insert(legalLists).values({
    id: listId,
    workspaceId: ids.wsA1,
    name: "Chronology",
    createdBy: ids.userA1,
  });
});
afterAll(async () => {
  await testDb.delete(legalLists).where(eq(legalLists.id, listId));
  await releaseRlsFixture();
});

/** Restored after each test by the test state. */
const withListVerification = async (run: () => Promise<void>) => {
  testState.setConfig("FEATURE_LEGAL_LISTS", true);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "legal-lists": [{ type: "organization", organizationId: ids.orgA }],
    "list-verification": [{ type: "organization", organizationId: ids.orgA }],
  });
  await run();
};

const start = async ({
  entityIds,
  orgAIConfigStatus = ORG_AI_CONFIG_STATUS.ok,
  onTransaction = () => {},
}: {
  entityIds: SafeId<"entity">[];
  orgAIConfigStatus?: (typeof ORG_AI_CONFIG_STATUS)[keyof typeof ORG_AI_CONFIG_STATUS];
  onTransaction?: () => void;
}) => {
  const scoped = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  const safeDb: typeof scoped = async (operation) => {
    onTransaction();
    return await scoped(operation);
  };
  return await createFactExtraction.handler(
    createTestHandlerContext<
      Parameters<typeof createFactExtraction.handler>[0]
    >({
      audit: NO_AUDIT,
      scopedDb: NO_DB,
      workspaceId: ids.wsA1,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      safeDb,
      orgAIConfig: null,
      orgAIConfigStatus,
      modelAdmission: testModelAdmission(ids.orgA),
      body: { listId, entityIds },
    }),
  );
};

const statusOf = (result: unknown) =>
  result instanceof HttpStatusResponse ? result.code : null;

const activeRuns = async () =>
  (
    await testDb
      .select({ active: legalListVerificationBudgets.activeRuns })
      .from(legalListVerificationBudgets)
      .where(eq(legalListVerificationBudgets.organizationId, ids.orgA))
  ).at(0)?.active ?? 0;

const runsOfList = async () =>
  await testDb.$count(
    legalListGenerationRuns,
    eq(legalListGenerationRuns.listId, listId),
  );

describe("starting a fact extraction", () => {
  test("an organization that must bring its own key is refused before any document is read", async () =>
    await withListVerification(async () => {
      let transactions = 0;
      const result = await start({
        entityIds: [ids.entityA1],
        orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ownKeyRequired,
        onTransaction: () => {
          transactions += 1;
        },
      });

      expect(statusOf(result)).toBe(403);
      // Only the identity and resource preflight ran; no document lookup.
      expect(transactions).toBe(2);
      expect(await runsOfList()).toBe(0);
    }));

  test("a document from another matter is not found and nothing is queued", async () =>
    await withListVerification(async () => {
      const result = await start({ entityIds: [ids.entityA1, ids.entityA2] });

      expect(statusOf(result)).toBe(404);
      expect(await runsOfList()).toBe(0);
    }));

  test("a full list AI run budget refuses the start without leaving a run", async () =>
    await withListVerification(async () => {
      // One run already holds a slot, and the cap is set to what is held.
      const holder = createSafeId<"legalListGenerationRun">();
      await testDb.insert(legalListGenerationRuns).values({
        id: holder,
        workspaceId: ids.wsA1,
        listId,
        organizationId: ids.orgA,
        producer: "stella",
        itemType: "fact",
        status: "queued",
        instruction: "Hold a slot.",
        requestedBy: ids.userA1,
      });
      const held = await activeRuns();
      try {
        expect(held).toBeGreaterThan(0);
        testState.setConfig("LIST_VERIFICATION_ACTIVE_RUNS_MAX", held);
        testState.setConfig("LIST_VERIFICATION_DAILY_STARTS_MAX", 1000);

        const result = await start({ entityIds: [ids.entityA1] });

        expect(statusOf(result)).toBe(429);
        expect(
          result instanceof HttpStatusResponse ? result.response : null,
        ).toHaveProperty("code", "verification_active_limit_reached");
        expect(await runsOfList()).toBe(1);
        expect(await activeRuns()).toBe(held);
      } finally {
        await testDb
          .delete(legalListGenerationRuns)
          .where(eq(legalListGenerationRuns.id, holder));
      }
      // A stella run's slot is released with it.
      expect(await activeRuns()).toBe(held - 1);
    }));
});
