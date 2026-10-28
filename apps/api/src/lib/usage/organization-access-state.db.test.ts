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
import { and, eq, inArray, TransactionRollbackError } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";
import { DAY_IN_MS } from "@stll/time";

import { apikey, member, organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  auditLogs,
  ORGANIZATION_ACCESS_STATE,
  ORGANIZATION_ACCESS_STATE_ORIGIN,
  organizationAccessStates,
  organizationSettings,
  usageEntitlements,
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
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transitionScopedBatch } from "@/api/lib/db/transitions";
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
  moveKeylessOrganizationsToFree,
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
const reconciledOrgId = mintAuthProviderId<"organization">();
const unenforcedReconciledOrgId = mintAuthProviderId<"organization">();
const fixtureOrgIds = [
  selfManagedOrgId,
  evaluatingOrgId,
  expiredOrgId,
  unrecordedOrgId,
  createdOrgId,
  reconciledOrgId,
  unenforcedReconciledOrgId,
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

/**
 * Records a creation inside a transaction, as the production creation callers
 * do. ownerDb() is the shared test pool typed as a transaction, which the
 * aggregate lock history already tracks, so it cannot open one itself.
 */
const recordCreation = async (
  change: Parameters<typeof recordNewOrganizationAccessState>[1],
) =>
  await testDb.transaction(
    async (tx) => await recordNewOrganizationAccessState(tx, change),
  );

const readState = async (organizationId: SafeId<"organization">) =>
  await testDb
    .select()
    .from(organizationAccessStates)
    .where(eq(organizationAccessStates.organizationId, organizationId))
    .then((rows) => rows.at(0));

const readCreationAudits = async (organizationId: SafeId<"organization">) =>
  await testDb
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, organizationId),
        eq(
          auditLogs.resourceType,
          AUDIT_RESOURCE_TYPE.ORGANIZATION_ACCESS_STATE,
        ),
        eq(auditLogs.triggerSource, "organization-creation"),
      ),
    );

describe("moving keyless organizations to the free floor", () => {
  test("moves exactly keyless self-managed organizations once", async () => {
    const now = new Date("2026-10-25T12:00:00.000Z");
    const accessIds = {
      keyless: mintAuthProviderId<"organization">(),
      ownKey: mintAuthProviderId<"organization">(),
      personalKey: mintAuthProviderId<"organization">(),
      evaluating: mintAuthProviderId<"organization">(),
      ended: mintAuthProviderId<"organization">(),
      entitled: mintAuthProviderId<"organization">(),
    };
    const organizationIds = Object.values(accessIds);
    const policyId = createSafeId<"usagePolicy">();
    const entitlementId = createSafeId<"usageEntitlement">();
    const personalKeyId = `personal-${Bun.randomUUIDv7()}`;

    await testDb.insert(organization).values(
      organizationIds.map((id) => ({
        id,
        name: "Free-floor move fixture",
        slug: `free-floor-${id}`,
        createdAt: now,
      })),
    );
    await testDb.insert(organizationSettings).values({
      id: createSafeId<"organizationSettings">(),
      organizationId: accessIds.ownKey,
      aiConfigEncrypted: Buffer.from("encrypted-org-ai-config"),
    });
    await testDb.insert(apikey).values({
      id: personalKeyId,
      key: `digest-${Bun.randomUUIDv7()}`,
      referenceId: ids.userA1,
      metadata: JSON.stringify({
        kind: "personal",
        organizationId: accessIds.personalKey,
      }),
    });
    await testDb.insert(usagePolicies).values({
      id: policyId,
      policyKey: `move_test_${Bun.randomUUIDv7()}`,
      displayName: "Move test paid policy",
      monthlyUsageUnits: 1,
    });
    await testDb.insert(usageEntitlements).values({
      id: entitlementId,
      organizationId: accessIds.entitled,
      usagePolicyId: policyId,
      status: "active",
      seats: 1,
      currentPeriodStart: new Date(now.getTime() - DAY_IN_MS),
      currentPeriodEnd: new Date(now.getTime() + DAY_IN_MS),
      source: "manual",
    });
    await testDb.insert(organizationAccessStates).values([
      ...[
        accessIds.keyless,
        accessIds.ownKey,
        accessIds.personalKey,
        accessIds.entitled,
      ].map((organizationId) => ({
        organizationId,
        state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
      })),
      {
        organizationId: accessIds.evaluating,
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        evaluationStartedAt: new Date(now.getTime() - DAY_IN_MS),
        evaluationEndsAt: new Date(now.getTime() + DAY_IN_MS),
      },
      {
        organizationId: accessIds.ended,
        state: ORGANIZATION_ACCESS_STATE.evaluationEnded,
        evaluationStartedAt: new Date(now.getTime() - 2 * DAY_IN_MS),
        evaluationEndsAt: new Date(now.getTime() - DAY_IN_MS),
        evaluationEndedAt: new Date(now.getTime() - DAY_IN_MS),
      },
    ]);

    const expectedMoved = [
      accessIds.keyless,
      accessIds.personalKey,
      accessIds.entitled,
    ];
    let moved: SafeId<"organization">[] = [];
    try {
      const beforeEvaluating = await readState(accessIds.evaluating);
      const beforeEnded = await readState(accessIds.ended);
      moved = await moveKeylessOrganizationsToFree(ownerDb(), {
        now,
        actor: "operator:test",
      });

      expect(new Set(moved.filter((id) => expectedMoved.includes(id)))).toEqual(
        new Set(expectedMoved),
      );
      expect(await readState(accessIds.ownKey)).toMatchObject({
        state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
        evaluationEndedAt: null,
      });
      for (const organizationId of expectedMoved) {
        expect(await readState(organizationId)).toMatchObject({
          state: ORGANIZATION_ACCESS_STATE.evaluationEnded,
          evaluationStartedAt: null,
          evaluationEndsAt: null,
          evaluationEndedAt: now,
        });
      }
      expect(await readState(accessIds.evaluating)).toEqual(beforeEvaluating);
      expect(await readState(accessIds.ended)).toEqual(beforeEnded);
      expect(
        await testDb
          .select({ id: usageEntitlements.id })
          .from(usageEntitlements)
          .where(eq(usageEntitlements.id, entitlementId)),
      ).toEqual([{ id: entitlementId }]);
      const movedAgain = await moveKeylessOrganizationsToFree(ownerDb(), {
        now: new Date(now.getTime() + DAY_IN_MS),
        actor: "operator:test",
      });
      expect(movedAgain).toEqual([]);
      // One audit event per moved organization, none for a re-run or a kept one.
      for (const organizationId of [...expectedMoved, accessIds.ownKey]) {
        const audits = await testDb
          .select({ resourceId: auditLogs.resourceId })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.organizationId, organizationId),
              eq(
                auditLogs.resourceType,
                AUDIT_RESOURCE_TYPE.ORGANIZATION_ACCESS_STATE,
              ),
            ),
          );
        expect(audits).toHaveLength(
          organizationId === accessIds.ownKey ? 0 : 1,
        );
      }
    } finally {
      // Runs even when an assertion fails: the suite shares one database.
      const unrelatedMoved = moved.filter(
        (organizationId) => !expectedMoved.includes(organizationId),
      );
      if (unrelatedMoved.length > 0) {
        await testDb
          .update(organizationAccessStates)
          .set({
            state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
            evaluationEndedAt: null,
          })
          .where(
            inArray(organizationAccessStates.organizationId, unrelatedMoved),
          );
      }

      await testDb.delete(apikey).where(eq(apikey.id, personalKeyId));
      await testDb
        .delete(organization)
        .where(inArray(organization.id, organizationIds));
      await testDb.delete(usagePolicies).where(eq(usagePolicies.id, policyId));
    }
  });

  test("the declared graph refuses ended and evaluation-period stale moves", async () => {
    const endedId = mintAuthProviderId<"organization">();
    const evaluationId = mintAuthProviderId<"organization">();
    let auditEvents = 0;
    try {
      await testDb.insert(organization).values([
        {
          id: endedId,
          name: "Ended transition fixture",
          slug: `ended-transition-${endedId}`,
          createdAt: new Date(),
        },
        {
          id: evaluationId,
          name: "Evaluation transition fixture",
          slug: `evaluation-transition-${evaluationId}`,
          createdAt: new Date(),
        },
      ]);
      await testDb.insert(organizationAccessStates).values([
        {
          organizationId: endedId,
          state: ORGANIZATION_ACCESS_STATE.evaluationEnded,
          evaluationEndedAt: new Date(),
        },
        {
          organizationId: evaluationId,
          state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
          evaluationStartedAt: new Date(Date.now() - DAY_IN_MS),
          evaluationEndsAt: new Date(Date.now() + DAY_IN_MS),
        },
      ]);

      expect(
        await endOrganizationEvaluation(ownerDb(), {
          organizationId: endedId,
          now: new Date(),
          actor: "operator:test",
        }),
      ).toBe(false);
      const moved = await transitionScopedBatch({
        tx: ownerDb(),
        spec: TRANSITIONS.organizationAccessStates,
        identities: [{ organizationId: evaluationId }],
        options: {
          from: [ORGANIZATION_ACCESS_STATE.selfManagedKeys],
          to: ORGANIZATION_ACCESS_STATE.evaluationEnded,
          set: { evaluationEndedAt: new Date() },
        },
        recordTransitionAuditEvent: (_tx, rows) => {
          auditEvents += rows.length;
        },
      });

      expect(moved).toEqual([]);
      expect(auditEvents).toBe(0);
      expect((await readState(evaluationId))?.state).toBe(
        ORGANIZATION_ACCESS_STATE.evaluationPeriod,
      );
    } finally {
      await testDb
        .delete(organization)
        .where(inArray(organization.id, [endedId, evaluationId]));
    }
  });
});

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
  // setupRlsTestData records orgA as self-managed; it has its own stored AI
  // config.
  await testDb.insert(organizationAccessStates).values([
    {
      organizationId: selfManagedOrgId,
      state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
      origin: ORGANIZATION_ACCESS_STATE_ORIGIN.creation,
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
    await recordCreation({
      organizationId: createdOrgId,
      now: new Date(),
    });

    expect((await readState(createdOrgId))?.state).toBe(
      ORGANIZATION_ACCESS_STATE.selfManagedKeys,
    );
    expect(await readCreationAudits(createdOrgId)).toHaveLength(0);

    // Recording again, even once enforcement is on, starts no evaluation.
    await withAccessStateEnforced(async () => {
      await recordCreation({
        organizationId: createdOrgId,
        now: new Date(),
      });
    });
    expect((await readState(createdOrgId))?.state).toBe(
      ORGANIZATION_ACCESS_STATE.selfManagedKeys,
    );
    expect(await readCreationAudits(createdOrgId)).toHaveLength(0);

    await ownerDb().insert(organizationAccessStates).values({
      organizationId: unenforcedReconciledOrgId,
      state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
      origin: ORGANIZATION_ACCESS_STATE_ORIGIN.legacyReconcile,
    });
    await recordCreation({
      organizationId: unenforcedReconciledOrgId,
      now: new Date(),
    });
    expect(await readState(unenforcedReconciledOrgId)).toMatchObject({
      state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
      origin: ORGANIZATION_ACCESS_STATE_ORIGIN.legacyReconcile,
    });
    expect(await readCreationAudits(unenforcedReconciledOrgId)).toHaveLength(0);
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
      // A member of an organization with no recorded state is refused before
      // the key check: the missing state grants no seat.
      expect(await authStatus(unrecordedOrgId)).toBe(
        ORG_AI_CONFIG_STATUS.memberAssignmentRequired,
      );
      for (const organizationId of [
        selfManagedOrgId,
        expiredOrgId,
        unrecordedOrgId,
      ]) {
        if (organizationId !== unrecordedOrgId) {
          expect(await authStatus(organizationId)).toBe(
            ORG_AI_CONFIG_STATUS.ownKeyRequired,
          );
        }
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
      await recordCreation({
        organizationId: createdOrgId,
        now,
      });
      const started = await readState(createdOrgId);
      expect(started?.state).toBe(ORGANIZATION_ACCESS_STATE.evaluationPeriod);
      expect(started?.evaluationEndsAt?.getTime()).toBe(
        now.getTime() + PERIOD_DAYS * DAY_IN_MS,
      );
      expect(await readCreationAudits(createdOrgId)).toHaveLength(0);

      // A replay does not restart it.
      await recordCreation({
        organizationId: createdOrgId,
        now: new Date(now.getTime() + DAY_IN_MS),
      });
      expect(await readState(createdOrgId)).toEqual(started);

      // Ending is once; nothing brings the evaluation back.
      const end = { organizationId: createdOrgId, now, actor: "operator:test" };
      expect(await endOrganizationEvaluation(ownerDb(), end)).toBe(true);
      expect(await endOrganizationEvaluation(ownerDb(), end)).toBe(false);
      // The ending is audited once; the refused repeat records nothing.
      expect(
        await testDb
          .select({ id: auditLogs.id })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.organizationId, createdOrgId),
              eq(
                auditLogs.resourceType,
                AUDIT_RESOURCE_TYPE.ORGANIZATION_ACCESS_STATE,
              ),
            ),
          ),
      ).toHaveLength(1);
      await recordCreation(end);
      expect((await readState(createdOrgId))?.state).toBe(
        ORGANIZATION_ACCESS_STATE.evaluationEnded,
      );
      expect(await authStatus(createdOrgId)).toBe(
        ORG_AI_CONFIG_STATUS.ownKeyRequired,
      );
    });
  });

  test("enabled creation supersedes only a legacy reconciler row", async () => {
    const reconciledAt = new Date(Date.now() - DAY_IN_MS);
    await ownerDb().insert(organizationAccessStates).values({
      organizationId: reconciledOrgId,
      state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
      origin: ORGANIZATION_ACCESS_STATE_ORIGIN.legacyReconcile,
      createdAt: reconciledAt,
      updatedAt: reconciledAt,
    });

    await withAccessStateEnforced(async () => {
      const before = await readState(reconciledOrgId);
      // testDb already carries aggregate lock history from the owner-pool
      // fixtures, so the rollback runs in a plain transaction like the
      // production creation callers.
      const rejection = await rejectionOf(
        testDb.transaction(async (tx) => {
          await recordNewOrganizationAccessState(tx, {
            organizationId: reconciledOrgId,
            now: new Date(),
          });
          tx.rollback();
        }),
      );
      expect(rejection).toBeInstanceOf(TransactionRollbackError);
      expect(await readState(reconciledOrgId)).toEqual(before);
      expect(await readCreationAudits(reconciledOrgId)).toHaveLength(0);

      const now = new Date();
      await recordCreation({
        organizationId: reconciledOrgId,
        now,
      });
      expect(await readState(reconciledOrgId)).toMatchObject({
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        origin: ORGANIZATION_ACCESS_STATE_ORIGIN.creation,
        evaluationStartedAt: now,
      });

      const started = await readState(reconciledOrgId);
      await recordCreation({
        organizationId: reconciledOrgId,
        now: new Date(now.getTime() + DAY_IN_MS),
      });
      expect(await readState(reconciledOrgId)).toEqual(started);
      expect(await readCreationAudits(reconciledOrgId)).toHaveLength(1);
    });
  });

  test("an existing non-legacy self-managed state is left unchanged", async () => {
    await withAccessStateEnforced(async () => {
      const before = await readState(selfManagedOrgId);
      await recordCreation({
        organizationId: selfManagedOrgId,
        now: new Date(),
      });
      expect(await readState(selfManagedOrgId)).toEqual(before);
      expect(await readCreationAudits(selfManagedOrgId)).toHaveLength(0);
    });
  });

  test("ending applies only to a running evaluation", async () => {
    expect(
      await endOrganizationEvaluation(ownerDb(), {
        organizationId: selfManagedOrgId,
        now: new Date(),
        actor: "operator:test",
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
        userId: null,
        actionKind: "chat.send",
        organizationStateDb: requestScope(expiredOrgId),
        signal: new AbortController().signal,
        run: async (admission) => await Promise.resolve(admission.modelTier),
      });
      expect(modelTier.unwrap()).toBe(MANAGED_MODEL_TIER.fast);
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
