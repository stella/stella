/**
 * The access state decides whether an organization without its own AI config
 * may fall through to the instance provider. The loaders read it under the
 * request scope (role `stella`), so each probe runs under the
 * membership-scoped factory request authentication builds.
 */

import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import { member, organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  organizationSettings,
  usagePolicies,
} from "@/api/db/schema";
import { createMembershipScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { encryptAIConfig } from "@/api/lib/ai-config-crypto";
import {
  loadOrgAIConfig,
  loadOrgAISettings,
  loadOrgSettingsForAuth,
} from "@/api/lib/ai-config-loader";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { admitModelDispatch } from "@/api/lib/rate-limit/model-dispatch-admission";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";
import {
  FREE_TIER_OFF,
  resolveOrganizationAccess,
} from "@/api/lib/usage/organization-access";
import {
  allowsInstanceModels,
  endOrganizationEvaluation,
  readManagedModelTier,
  recordMissingOrganizationAccessStatesWhileUnenforced,
  recordNewOrganizationAccessState,
} from "@/api/lib/usage/organization-access-state";
import { readOrganizationActionState } from "@/api/lib/usage/organization-action-budget";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Arbitrary fixture value; the length is deployment configuration.
const PERIOD_DAYS = 3;
const testState = createTestState({ file: import.meta.path, config: env });

let testDb: TestDatabase;
let ids: TestIds;
const selfManagedOrgId = mintAuthProviderId<"organization">();
const evaluatingOrgId = mintAuthProviderId<"organization">();
const expiredOrgId = mintAuthProviderId<"organization">();
const unrecordedOrgId = mintAuthProviderId<"organization">();
const createdOrgId = mintAuthProviderId<"organization">();
const fixtureOrgIds = [
  selfManagedOrgId,
  evaluatingOrgId,
  expiredOrgId,
  unrecordedOrgId,
  createdOrgId,
];

const requestScope = (organizationId: SafeId<"organization">): ScopedDb =>
  asTestRaw<ScopedDb>(
    createMembershipScopedDb(testDb, {
      organizationId,
      serverValidatedWorkspaceIds: [],
      userId: ids.userA1,
    }),
  );

const envBefore = {
  enforced: env.FEATURE_ORG_ACCESS_STATE,
  periodDays: env.ORG_EVALUATION_PERIOD_DAYS,
};

const withAccessStateEnforced = async (run: () => Promise<void>) => {
  env.FEATURE_ORG_ACCESS_STATE = true;
  env.ORG_EVALUATION_PERIOD_DAYS = PERIOD_DAYS;
  await run();
};

const authStatus = async (organizationId: SafeId<"organization">) =>
  (
    await requestScope(organizationId)(
      async (tx) =>
        await loadOrgSettingsForAuth(tx, {
          organizationId,
          userId: ids.userA1,
        }),
    )
  ).orgAIConfigStatus;

const strictLoads = async (
  organizationId: SafeId<"organization">,
): Promise<Result<unknown, HandlerError<403>>[]> => {
  const scope = requestScope(organizationId);
  return [
    await scope(
      async (tx) =>
        await loadOrgAIConfig(tx, {
          organizationId,
          userId: ids.userA1,
        }),
    ),
    await scope(
      async (tx) =>
        await loadOrgAISettings(tx, {
          organizationId,
          userId: ids.userA1,
        }),
    ),
  ];
};

/** The owner connection the creation hook and the operator script write through. */
const ownerDb = () => asTestRaw<Transaction>(testDb);

const readState = async (organizationId: SafeId<"organization">) =>
  await testDb
    .select()
    .from(organizationAccessStates)
    .where(eq(organizationAccessStates.organizationId, organizationId))
    .then((rows) => rows.at(0));

test("action admission reads access state only through its authorized organization scope", async () => {
  expect(
    (await readOrganizationActionState(requestScope(ids.orgA), ids.orgA))
      .snapshot,
  ).toEqual({
    state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
    evaluationEndsAt: null,
  });
  expect(
    (
      await readOrganizationActionState(
        requestScope(evaluatingOrgId),
        evaluatingOrgId,
      )
    ).snapshot,
  ).toMatchObject({
    state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
  });
  // This user belongs to both organizations; the supplied request scope still
  // prevents either organization's admission reader from selecting the other.
  expect(
    (await readOrganizationActionState(requestScope(ids.orgA), evaluatingOrgId))
      .snapshot,
  ).toBeUndefined();
  expect(
    (await readOrganizationActionState(requestScope(evaluatingOrgId), ids.orgA))
      .snapshot,
  ).toBeUndefined();
});

testState.beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);

  await testDb.insert(organization).values(
    fixtureOrgIds.map((id) => ({
      id,
      name: "Access state fixture",
      slug: `access-state-${id}`,
      createdAt: new Date(),
    })),
  );
  await testDb.insert(member).values(
    fixtureOrgIds.map((organizationId) => ({
      id: mintAuthProviderIdValue(),
      organizationId,
      userId: ids.userA1,
      role: "member",
      createdAt: new Date(),
    })),
  );
  const ownConfig = await encryptAIConfig(ids.orgA, {
    providers: [{ provider: "google", apiKey: "own-key" }],
    overrideModels: {
      chat: { provider: "google", modelId: "model-a" },
      fast: { provider: "google", modelId: "model-a" },
      pdf: { provider: "google", modelId: "model-a" },
      reasoning: { provider: "google", modelId: "model-a" },
    },
    decision: null,
  });
  await testDb
    .update(organizationSettings)
    .set({ aiConfigEncrypted: ownConfig.ciphertext, aiConfigIv: ownConfig.iv })
    .where(eq(organizationSettings.organizationId, ids.orgA));

  const now = Date.now();
  await testDb.insert(organizationAccessStates).values([
    // orgA has its own stored AI config.
    {
      organizationId: ids.orgA,
      state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
    },
    {
      organizationId: selfManagedOrgId,
      state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
    },
    {
      organizationId: evaluatingOrgId,
      state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
      evaluationStartedAt: new Date(now - DAY_IN_MS),
      evaluationEndsAt: new Date(now + DAY_IN_MS),
    },
    {
      organizationId: expiredOrgId,
      state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
      evaluationStartedAt: new Date(now - 2 * DAY_IN_MS),
      evaluationEndsAt: new Date(now - DAY_IN_MS),
    },
  ]);
});

afterEach(() => {
  env.FEATURE_ORG_ACCESS_STATE = envBefore.enforced;
  env.ORG_EVALUATION_PERIOD_DAYS = envBefore.periodDays;
});

afterAll(async () => {
  await testDb
    .delete(organizationAccessStates)
    .where(inArray(organizationAccessStates.organizationId, [ids.orgA]));
  await testDb
    .delete(member)
    .where(inArray(member.organizationId, fixtureOrgIds));
  await testDb
    .delete(organization)
    .where(inArray(organization.id, fixtureOrgIds));
  await releaseTestDb();
});

describe("with FEATURE_ORG_ACCESS_STATE off", () => {
  beforeEach(() => {
    env.FEATURE_ORG_ACCESS_STATE = false;
  });

  test("every organization without its own config resolves as today", async () => {
    for (const organizationId of [
      selfManagedOrgId,
      expiredOrgId,
      unrecordedOrgId,
    ]) {
      expect(await authStatus(organizationId)).toBe(ORG_AI_CONFIG_STATUS.ok);
      for (const load of await strictLoads(organizationId)) {
        expect(Result.isOk(load)).toBe(true);
      }
    }
  });

  test("a new organization keeps the self-managed-keys path", async () => {
    await recordNewOrganizationAccessState(ownerDb(), {
      organizationId: createdOrgId,
      now: new Date(),
    });

    expect((await readState(createdOrgId))?.state).toBe(
      ORGANIZATION_ACCESS_STATE.selfManagedKeys,
    );

    // Recording again, even once enforcement is on, starts no evaluation.
    await withAccessStateEnforced(async () => {
      await recordNewOrganizationAccessState(ownerDb(), {
        organizationId: createdOrgId,
        now: new Date(),
      });
    });
    expect((await readState(createdOrgId))?.state).toBe(
      ORGANIZATION_ACCESS_STATE.selfManagedKeys,
    );
    await testDb
      .delete(organizationAccessStates)
      .where(eq(organizationAccessStates.organizationId, createdOrgId));
  });
});

describe("with FEATURE_ORG_ACCESS_STATE on", () => {
  test("a self-managed-keys organization keeps its own key", async () => {
    await withAccessStateEnforced(async () => {
      expect(await authStatus(ids.orgA)).toBe(ORG_AI_CONFIG_STATUS.ok);
      const scope = requestScope(ids.orgA);
      expect(
        (
          await scope(
            async (tx) =>
              await loadOrgAIConfig(tx, {
                organizationId: ids.orgA,
                userId: ids.userA1,
              }),
          )
        ).unwrap(),
      ).not.toBeNull();
    });
  });

  test("without its own key, only a running evaluation reaches the instance provider", async () => {
    await withAccessStateEnforced(async () => {
      expect(await authStatus(evaluatingOrgId)).toBe(ORG_AI_CONFIG_STATUS.ok);
      for (const organizationId of [
        selfManagedOrgId,
        expiredOrgId,
        unrecordedOrgId,
      ]) {
        expect(await authStatus(organizationId)).toBe(
          ORG_AI_CONFIG_STATUS.ownKeyRequired,
        );
        for (const load of await strictLoads(organizationId)) {
          expect(Result.isError(load)).toBe(true);
          if (Result.isError(load)) {
            expect(load.error).toBeInstanceOf(HandlerError);
            expect(load.error).toMatchObject({ status: 403 });
          }
        }
      }
    });
  });

  test("a new organization starts one evaluation of the configured length", async () => {
    await withAccessStateEnforced(async () => {
      const now = new Date();
      await recordNewOrganizationAccessState(ownerDb(), {
        organizationId: createdOrgId,
        now,
      });
      const started = await readState(createdOrgId);
      expect(started?.state).toBe(ORGANIZATION_ACCESS_STATE.evaluationPeriod);
      expect(started?.evaluationEndsAt?.getTime()).toBe(
        now.getTime() + PERIOD_DAYS * DAY_IN_MS,
      );

      // A replay does not restart it.
      await recordNewOrganizationAccessState(ownerDb(), {
        organizationId: createdOrgId,
        now: new Date(now.getTime() + DAY_IN_MS),
      });
      expect(await readState(createdOrgId)).toEqual(started);

      // Ending is once; nothing brings the evaluation back.
      const end = { organizationId: createdOrgId, now };
      expect(await endOrganizationEvaluation(ownerDb(), end)).toBe(true);
      expect(await endOrganizationEvaluation(ownerDb(), end)).toBe(false);
      await recordNewOrganizationAccessState(ownerDb(), end);
      expect((await readState(createdOrgId))?.state).toBe(
        ORGANIZATION_ACCESS_STATE.evaluationEnded,
      );
      expect(await authStatus(createdOrgId)).toBe(
        ORG_AI_CONFIG_STATUS.ownKeyRequired,
      );
    });
  });

  test("ending applies only to a running evaluation", async () => {
    expect(
      await endOrganizationEvaluation(ownerDb(), {
        organizationId: selfManagedOrgId,
        now: new Date(),
      }),
    ).toBe(false);
    expect((await readState(selfManagedOrgId))?.state).toBe(
      ORGANIZATION_ACCESS_STATE.selfManagedKeys,
    );
  });
});

describe("the stored shape", () => {
  test("an evaluation row without its bounds is refused", async () => {
    const inserted = await Result.tryPromise(
      async () =>
        await testDb.insert(organizationAccessStates).values({
          organizationId: unrecordedOrgId,
          state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        }),
    );

    expect(Result.isError(inserted)).toBe(true);
  });

  test("an evaluation is open strictly before its end", () => {
    const evaluationEndsAt = new Date();
    const row = {
      state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
      evaluationEndsAt,
    };

    const allowsAt = (now: Date) =>
      allowsInstanceModels(
        resolveOrganizationAccess({
          snapshot: row,
          now,
          freeTier: FREE_TIER_OFF,
        }),
      );
    expect(allowsAt(new Date(evaluationEndsAt.getTime() - 1))).toBe(true);
    expect(allowsAt(evaluationEndsAt)).toBe(false);
  });

  test("a member reads only its own organization's state", async () => {
    const rows = await requestScope(selfManagedOrgId)(
      async (tx) =>
        await tx
          .select({ organizationId: organizationAccessStates.organizationId })
          .from(organizationAccessStates),
    );

    expect(rows).toEqual([{ organizationId: selfManagedOrgId }]);
  });
});

describe("managed model tier", () => {
  const freePolicyKey = `free_${Bun.randomUUIDv7()}`;

  testState.beforeAll(async () => {
    await testDb.insert(usagePolicies).values({
      id: createSafeId<"usagePolicy">(),
      policyKey: freePolicyKey,
      displayName: "Free fixture",
      kind: "free",
      monthlyUsageUnits: 0,
      maxMembers: 1,
      storageBytesPerAssignment: 1_073_741_824n,
      serviceActionsPerPeriod: 3,
    });
  });

  afterAll(async () => {
    await testDb
      .delete(usagePolicies)
      .where(eq(usagePolicies.policyKey, freePolicyKey));
  });

  const tierOf = async (organizationId: SafeId<"organization">) =>
    await readManagedModelTier(requestScope(organizationId), organizationId);

  test("the free floor resolves the fast tier through the organization's own scope", async () => {
    testState.setConfig("FEATURE_FREE_TIER", true);
    await withAccessStateEnforced(async () => {
      // The lapsed evaluation stands on the free floor.
      expect(await tierOf(expiredOrgId)).toBe(MANAGED_MODEL_TIER.fast);
      expect(await tierOf(evaluatingOrgId)).toBe(MANAGED_MODEL_TIER.standard);
      expect(await tierOf(selfManagedOrgId)).toBe(MANAGED_MODEL_TIER.standard);
      // A minted proof carries the tier admission read for its organization.
      const modelTier = await admitModelDispatch({
        organizationId: expiredOrgId,
        actionKind: "chat.send",
        organizationStateDb: requestScope(expiredOrgId),
        signal: new AbortController().signal,
        run: async (admission) => await Promise.resolve(admission.modelTier),
      });
      expect(modelTier).toBe(MANAGED_MODEL_TIER.fast);
    });
  });

  test("without the free tier every organization is standard", async () => {
    testState.setConfig("FEATURE_FREE_TIER", false);
    await withAccessStateEnforced(async () => {
      for (const organizationId of [
        expiredOrgId,
        evaluatingOrgId,
        selfManagedOrgId,
      ]) {
        expect(await tierOf(organizationId)).toBe(MANAGED_MODEL_TIER.standard);
      }
    });
  });
});

// Last: it records a state for every organization still without one.
describe("recording missing states", () => {
  test("fills only missing rows, and only while the state is not enforced", async () => {
    const evaluating = await readState(evaluatingOrgId);

    await withAccessStateEnforced(async () => {
      await recordMissingOrganizationAccessStatesWhileUnenforced(ownerDb());
    });
    expect(await readState(unrecordedOrgId)).toBeUndefined();

    env.FEATURE_ORG_ACCESS_STATE = false;
    await recordMissingOrganizationAccessStatesWhileUnenforced(ownerDb());
    await recordMissingOrganizationAccessStatesWhileUnenforced(ownerDb());

    expect((await readState(unrecordedOrgId))?.state).toBe(
      ORGANIZATION_ACCESS_STATE.selfManagedKeys,
    );
    expect(await readState(evaluatingOrgId)).toEqual(evaluating);
  });
});
