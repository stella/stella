import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray, TransactionRollbackError } from "drizzle-orm";

import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SIGNAL_KIND_ORIGIN,
  SIGNAL_SEVERITY,
} from "@stll/api-contract/signals";
import { rejectionOf } from "@stll/property-testing/rejection";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  flowDefinitions,
  scoutRuns,
  SIGNAL_EVENT_TYPE,
  SCOUT_RUN_STATUS,
  signalEvents,
  signals,
  systemAuditRuns,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { cleanupFlowDefinitions } from "@/api/lib/flows/reset-cleanup";
import { FLOW_RESET_AUDITED_TABLES } from "@/api/lib/flows/reset-cleanup-owner";
import { REVIEW_RESET_SWEEP } from "@/api/lib/review-organization/reset-census";
import { sweepReviewOrganization } from "@/api/lib/review-organization/reset-scope";
import {
  cleanupScoutRuns,
  cleanupSignalEvents,
  cleanupSignals,
} from "@/api/lib/signals/reset-cleanup";
import { SIGNAL_RESET_AUDITED_TABLES } from "@/api/lib/signals/reset-cleanup-owner";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
const organizationIds: SafeId<"organization">[] = [];
const subjects: SafeId<"schedulerJobRun">[] = [];
const FEATURE_TABLES = [
  ...FLOW_RESET_AUDITED_TABLES,
  ...SIGNAL_RESET_AUDITED_TABLES,
];
const SEEDED_COUNTS = {
  flow_definitions: 2,
  scout_runs: 3,
  signal_events: 2,
  signals: 1,
};
const EMPTY_COUNTS = {
  flow_definitions: 0,
  scout_runs: 0,
  signal_events: 0,
  signals: 0,
};
const EXPECTED_AUDITS = [
  {
    actor: "system:review-reset-flows-cleanup",
    counts: { flowDefinitions: 2 },
  },
  {
    actor: "system:review-reset-signal-cleanup",
    counts: { scoutRuns: 3, signalEvents: 0, signalsRemoved: 0 },
  },
  {
    actor: "system:review-reset-signal-cleanup",
    counts: { scoutRuns: 0, signalEvents: 2, signalsRemoved: 0 },
  },
  {
    actor: "system:review-reset-signal-cleanup",
    counts: { scoutRuns: 0, signalEvents: 0, signalsRemoved: 1 },
  },
];

beforeAll(async () => {
  testDb = await getTestDb();
});

afterAll(async () => {
  try {
    if (subjects.length > 0) {
      await testDb
        .delete(systemAuditRuns)
        .where(inArray(systemAuditRuns.subject, subjects));
    }
    if (organizationIds.length > 0) {
      await testDb
        .delete(organization)
        .where(inArray(organization.id, organizationIds));
    }
  } finally {
    await releaseTestDb();
  }
});

const newSubject = () => {
  const subject = createSafeId<"schedulerJobRun">();
  subjects.push(subject);
  return subject;
};

const seedOrganization = async () => {
  const organizationId = mintAuthProviderId<"organization">();
  organizationIds.push(organizationId);
  await testDb.insert(organization).values({
    id: organizationId,
    name: "Reset cleanup fixture",
    slug: `reset-cleanup-${organizationId}`,
    createdAt: new Date(),
  });
  await testDb.insert(flowDefinitions).values(
    Array.from({ length: SEEDED_COUNTS.flow_definitions }, () => ({
      id: createSafeId<"flowDefinition">(),
      organizationId,
      name: "Reset flow",
      steps: [],
      trigger: { type: "manual" as const },
    })),
  );
  await testDb.insert(scoutRuns).values(
    Array.from({ length: SEEDED_COUNTS.scout_runs }, () => ({
      id: createSafeId<"scoutRun">(),
      organizationId,
      scoutKey: SCOUT_KEY.MANUAL_REQUEST,
      status: SCOUT_RUN_STATUS.SUCCEEDED,
    })),
  );
  const signalId = createSafeId<"signal">();
  await testDb.insert(signals).values({
    id: signalId,
    organizationId,
    kind: SIGNAL_KIND.REQUEST_SUBMITTED,
    origin: SIGNAL_KIND_ORIGIN[SIGNAL_KIND.REQUEST_SUBMITTED],
    scoutKey: SCOUT_KEY.MANUAL_REQUEST,
    severity: SIGNAL_SEVERITY.NOTICE,
    title: "Reset signal",
    summary: "Reset signal",
    subject: { type: "none" },
    evidence: {
      kind: SIGNAL_KIND.REQUEST_SUBMITTED,
      description: "Fixture",
      attachments: [],
    },
    suggestions: [],
    dedupeKey: `reset-cleanup:${signalId}`,
  });
  await testDb.insert(signalEvents).values(
    Array.from({ length: SEEDED_COUNTS.signal_events }, () => ({
      id: createSafeId<"signalEvent">(),
      organizationId,
      signalId,
      type: SIGNAL_EVENT_TYPE.CREATED,
    })),
  );
  return organizationId;
};

const featureCounts = async (organizationId: SafeId<"organization">) => ({
  flow_definitions: await testDb.$count(
    flowDefinitions,
    eq(flowDefinitions.organizationId, organizationId),
  ),
  scout_runs: await testDb.$count(
    scoutRuns,
    eq(scoutRuns.organizationId, organizationId),
  ),
  signal_events: await testDb.$count(
    signalEvents,
    eq(signalEvents.organizationId, organizationId),
  ),
  signals: await testDb.$count(
    signals,
    eq(signals.organizationId, organizationId),
  ),
});

const auditRows = async (subject: SafeId<"schedulerJobRun">) =>
  await testDb
    .select({ actor: systemAuditRuns.actor, counts: systemAuditRuns.counts })
    .from(systemAuditRuns)
    .where(eq(systemAuditRuns.subject, subject));

type CleanupOptions = Parameters<typeof cleanupFlowDefinitions>[0];

const cleanupAllFeatures = async (options: CleanupOptions) => {
  expect(await cleanupFlowDefinitions(options)).toBeUndefined();
  expect(await cleanupScoutRuns(options)).toBeUndefined();
  expect(await cleanupSignalEvents(options)).toBeUndefined();
  expect(await cleanupSignals(options)).toBeUndefined();
};

describe("feature reset cleanup audit transactions", () => {
  test("void facades commit exact owner counts", async () => {
    const organizationId = await seedOrganization();
    const subject = newSubject();
    await testDb.transaction(async (tx) => {
      await cleanupAllFeatures({
        tx: asTestRaw<Transaction>(tx),
        organizationId,
        subject,
      });
      const recorded = await tx
        .select({
          actor: systemAuditRuns.actor,
          counts: systemAuditRuns.counts,
        })
        .from(systemAuditRuns)
        .where(eq(systemAuditRuns.subject, subject));
      expect(recorded).toHaveLength(EXPECTED_AUDITS.length);
      expect(recorded).toEqual(expect.arrayContaining(EXPECTED_AUDITS));
    });
    expect(await featureCounts(organizationId)).toEqual(EMPTY_COUNTS);
    expect(await auditRows(subject)).toEqual(
      expect.arrayContaining(EXPECTED_AUDITS),
    );
    await testDb.transaction(
      async (tx) =>
        await cleanupAllFeatures({
          tx: asTestRaw<Transaction>(tx),
          organizationId,
          subject,
        }),
    );
    expect(await auditRows(subject)).toHaveLength(EXPECTED_AUDITS.length);
  });

  test("rollback restores feature rows and removes the deletion counts recorded with them", async () => {
    const organizationId = await seedOrganization();
    const subject = newSubject();
    expect(
      await rejectionOf(
        testDb.transaction(async (tx) => {
          await cleanupAllFeatures({
            tx: asTestRaw<Transaction>(tx),
            organizationId,
            subject,
          });
          expect(
            await tx.$count(
              flowDefinitions,
              eq(flowDefinitions.organizationId, organizationId),
            ),
          ).toBe(0);
          expect(
            await tx.$count(
              signals,
              eq(signals.organizationId, organizationId),
            ),
          ).toBe(0);
          const recorded = await tx
            .select({
              actor: systemAuditRuns.actor,
              counts: systemAuditRuns.counts,
            })
            .from(systemAuditRuns)
            .where(eq(systemAuditRuns.subject, subject));
          expect(recorded).toHaveLength(EXPECTED_AUDITS.length);
          expect(recorded).toEqual(expect.arrayContaining(EXPECTED_AUDITS));
          tx.rollback();
        }),
      ),
    ).toBeInstanceOf(TransactionRollbackError);
    expect(await featureCounts(organizationId)).toEqual(SEEDED_COUNTS);
    expect(await auditRows(subject)).toEqual([]);
  });

  test("the generic sweep omits feature counts while its transaction preserves the owner audit rows", async () => {
    const organizationId = await seedOrganization();
    const subject = newSubject();
    const removed = await testDb.transaction(
      async (tx) =>
        await sweepReviewOrganization({
          tx: asTestRaw<Transaction>(tx),
          organizationId,
          subject,
        }),
    );
    expect(new Set(removed.keys())).toEqual(
      new Set([
        "user_files",
        ...REVIEW_RESET_SWEEP.filter(
          ([, auditor]) => auditor === "generic",
        ).map(([table]) => table),
      ]),
    );
    for (const table of FEATURE_TABLES) {
      expect(removed.has(table)).toBe(false);
    }
    expect(await featureCounts(organizationId)).toEqual(EMPTY_COUNTS);
    const recorded = await auditRows(subject);
    expect(recorded).toHaveLength(EXPECTED_AUDITS.length);
    expect(recorded).toEqual(expect.arrayContaining(EXPECTED_AUDITS));
  });
});
