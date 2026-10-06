import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  clauses,
  contacts,
  entities,
  chatThreads,
  entityDeletionCleanupRequests,
  featureEnrolments,
  fileComparisonUploads,
  organizationSettings,
  playbookDefinitions,
  rateEntries,
  rateTables,
  savedSearches,
  systemAuditRuns,
  templates,
  timeEntries,
  workspaces,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { createContactHandler } from "@/api/handlers/contacts/create";
import { createWorkspaceHandler } from "@/api/handlers/workspaces/create";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import type { CreateEntityFromBufferDependencies } from "@/api/lib/entities/create-from-buffer";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { ReviewOrganizationConfig } from "@/api/lib/review-organization/config";
import { reviewOrganizationConfigFrom } from "@/api/lib/review-organization/config";
import {
  REVIEW_RESET_REFUSAL,
  resetReviewOrganization,
} from "@/api/lib/review-organization/reset";
import type {
  ReviewResetDependencies,
  ReviewResetRefusalReason,
} from "@/api/lib/review-organization/reset";
import { SAMPLE_COUNTS } from "@/api/lib/review-organization/sample-data";
import { seedReviewOrganization } from "@/api/lib/review-organization/seed";
import type { ReviewSeedActor } from "@/api/lib/review-organization/seed-common";
import {
  createRootMembershipSafeDb,
  createRootMembershipScopedDb,
} from "@/api/lib/root-scoped-db";
import { createSchedulerTaskRegistry } from "@/api/lib/scheduler/registry";
import {
  createResetReviewOrganizationTask,
  RESET_REVIEW_ORGANIZATION_TASK,
  resetReviewOrganizationTask,
} from "@/api/lib/scheduler/tasks/review-organization-reset";
import type {
  SchedulerDb,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

type SampleKind = keyof typeof SAMPLE_COUNTS;

// Stored documents skip extraction and derivative queues: the test proves
// what lands in the database and the object store, not the workers after it.
const documentDependencies: CreateEntityFromBufferDependencies = {
  broadcastWorkspaceResourceUpdated: () => {},
  enqueueImageThumbnailOrMarkFailed: async () => {},
  enqueuePdfDerivativeOrMarkFailed: async () => {},
  processExtraction: async () => {},
  requestNativeExtractionRun: async () => null,
};

const resetDependencies: ReviewResetDependencies = {
  seed: { documents: documentDependencies },
  workspaceDeletion: { enqueueCleanup: async () => {} },
};

let testDb: TestDatabase;
let fakeS3: FakeS3;

const REVIEW_EMAIL = `review-${Bun.randomUUIDv7()}@example.test`;
const OTHER_EMAIL = `colleague-${Bun.randomUUIDv7()}@example.test`;
const DEMO_EMAIL = `demo-${Bun.randomUUIDv7()}@example.test`;

type Fixture = {
  reviewUserId: SafeId<"user">;
  otherUserId: SafeId<"user">;
  reviewOrgId: SafeId<"organization">;
  sharedOrgId: SafeId<"organization">;
  foreignOrgId: SafeId<"organization">;
  demoOrgId: SafeId<"organization">;
  foreignWorkspaceId: SafeId<"workspace">;
  foreignContactId: SafeId<"contact">;
};
let fixture: Fixture;

const insertUser = async (email: string) => {
  const id = mintAuthProviderId<"user">();
  await testDb.insert(user).values({
    id,
    name: email,
    email,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
};

const insertOrganization = async (
  name: string,
  members: readonly SafeId<"user">[],
) => {
  const id = mintAuthProviderId<"organization">();
  await testDb.insert(organization).values({
    id,
    name,
    slug: `review-test-${id}`,
    createdAt: new Date(),
  });
  if (members.length > 0) {
    await testDb.insert(member).values(
      members.map((userId) => ({
        id: Bun.randomUUIDv7(),
        organizationId: id,
        userId,
        role: "owner",
        createdAt: new Date(),
      })),
    );
  }
  return id;
};

const config = (
  organizationId: string,
  overrides: Record<string, string> = {},
): ReviewOrganizationConfig =>
  reviewOrganizationConfigFrom({
    APP_REVIEW_ACCOUNT_EMAIL: REVIEW_EMAIL,
    APP_REVIEW_ORGANIZATION_ID: organizationId,
    DEMO_ACCOUNT_EMAIL: DEMO_EMAIL,
    DEMO_ACCOUNT_ORGANIZATION_ID: fixture.demoOrgId,
    ...overrides,
  }) ?? panic("Expected a complete review configuration");

const rlsDatabase = () => asTestRaw<RlsDatabase<Transaction>>(testDb);
const ownerDb = () => asTestRaw<SchedulerDb>(testDb);

const actorFor = (
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
): ReviewSeedActor => ({
  organizationId,
  userId,
  userEmail: REVIEW_EMAIL,
  memberAuthority: sessionMemberRole("owner"),
  safeDb: createRootMembershipSafeDb({ organizationId, userId }, rlsDatabase()),
  scopedDb: createRootMembershipScopedDb(
    { organizationId, userId },
    rlsDatabase(),
  ),
  recorderFor: (workspaceId) =>
    createBackgroundAuditRecorder({
      organizationId,
      workspaceId,
      userId,
      execution: {
        performer: { type: "service", id: "review-test", name: null },
        trigger: { type: "direct" },
      },
    }),
});

/** Rows of each seeded kind the organization holds now. */
const countRows = async (
  organizationId: SafeId<"organization">,
): Promise<Record<SampleKind, number>> => {
  const matterIds = testDb
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.organizationId, organizationId));
  const [
    contactCount,
    matterCount,
    documentCount,
    taskCount,
    timeEntryCount,
    clauseCount,
    templateCount,
    playbookCount,
    rateTableCount,
    rateEntryCount,
  ] = await Promise.all([
    testDb.$count(contacts, eq(contacts.organizationId, organizationId)),
    testDb.$count(workspaces, eq(workspaces.organizationId, organizationId)),
    testDb.$count(
      entities,
      and(
        eq(entities.kind, "document"),
        // The seeded matters are the organization's only matters.
        inArray(entities.workspaceId, matterIds),
      ),
    ),
    testDb.$count(
      entities,
      and(eq(entities.kind, "task"), inArray(entities.workspaceId, matterIds)),
    ),
    testDb.$count(timeEntries, eq(timeEntries.organizationId, organizationId)),
    testDb.$count(clauses, eq(clauses.organizationId, organizationId)),
    testDb.$count(templates, eq(templates.organizationId, organizationId)),
    testDb.$count(
      playbookDefinitions,
      eq(playbookDefinitions.organizationId, organizationId),
    ),
    testDb.$count(
      rateTables,
      and(
        eq(rateTables.organizationId, organizationId),
        eq(rateTables.isDefault, true),
      ),
    ),
    testDb.$count(
      rateEntries,
      and(
        inArray(rateEntries.workspaceId, matterIds),
        isNull(rateEntries.userId),
        isNull(rateEntries.role),
      ),
    ),
  ]);
  return {
    rateTables: rateTableCount,
    rateEntries: rateEntryCount,
    contacts: contactCount,
    matters: matterCount,
    documents: documentCount,
    tasks: taskCount,
    timeEntries: timeEntryCount,
    clauses: clauseCount,
    templates: templateCount,
    playbooks: playbookCount,
  };
};

beforeAll(async () => {
  testDb = await getTestDb();
  fakeS3 = startFakeS3();
  const reviewUserId = await insertUser(REVIEW_EMAIL);
  const otherUserId = await insertUser(OTHER_EMAIL);
  const demoUserId = await insertUser(DEMO_EMAIL);
  const reviewOrgId = await insertOrganization("Review", [reviewUserId]);
  const sharedOrgId = await insertOrganization("Shared", [
    reviewUserId,
    otherUserId,
  ]);
  const foreignOrgId = await insertOrganization("Foreign", [otherUserId]);
  const demoOrgId = await insertOrganization("Demo", [
    reviewUserId,
    demoUserId,
  ]);
  fixture = {
    reviewUserId,
    otherUserId,
    reviewOrgId,
    sharedOrgId,
    foreignOrgId,
    demoOrgId,
    foreignWorkspaceId: createSafeId<"workspace">(),
    foreignContactId: createSafeId<"contact">(),
  };

  // A real member's data in another organization, which no reset may touch.
  const foreign = actorFor(foreignOrgId, otherUserId);
  const contact = await Result.gen(() =>
    createContactHandler({
      safeDb: foreign.safeDb,
      organizationId: foreignOrgId,
      userId: otherUserId,
      recordAuditEvent: foreign.recorderFor(null),
      body: {
        id: fixture.foreignContactId,
        type: "organization",
        displayName: "Foreign client",
        organizationName: "Foreign client",
      },
    }),
  );
  expect(Result.isOk(contact)).toBe(true);
  const matter = await Result.gen(() =>
    createWorkspaceHandler({
      userEmail: OTHER_EMAIL,
      safeDb: foreign.safeDb,
      organizationId: foreignOrgId,
      userId: otherUserId,
      recordAuditEvent: foreign.recorderFor(null),
      body: {
        id: fixture.foreignWorkspaceId,
        name: "Foreign matter",
        filePropertyName: "File",
        clientId: fixture.foreignContactId,
      },
    }),
  );
  expect(Result.isOk(matter)).toBe(true);
});

afterAll(async () => {
  fakeS3.stop();
  await releaseTestDb();
});

describe("review organization configuration", () => {
  test("is absent unless both the account and the organization are set", () => {
    expect(reviewOrganizationConfigFrom({})).toBeNull();
    expect(
      reviewOrganizationConfigFrom({ APP_REVIEW_ACCOUNT_EMAIL: REVIEW_EMAIL }),
    ).toBeNull();
    expect(
      reviewOrganizationConfigFrom({ APP_REVIEW_ORGANIZATION_ID: "org_1" }),
    ).toBeNull();
    expect(
      reviewOrganizationConfigFrom({
        APP_REVIEW_ACCOUNT_EMAIL: "not an email",
        APP_REVIEW_ORGANIZATION_ID: "org_1",
      }),
    ).toBeNull();
  });
});

describe("review organization reset refusals", () => {
  const expectRefusal = async (
    target: ReviewOrganizationConfig | null,
    reason: ReviewResetRefusalReason,
  ) => {
    const outcome = await resetReviewOrganization({
      config: target,
      db: ownerDb(),
      rlsDatabase: rlsDatabase(),
      runId: Bun.randomUUIDv7(),
      signal: new AbortController().signal,
      dependencies: resetDependencies,
    });
    expect(
      outcome.match({ ok: () => null, err: (error) => error.reason }),
    ).toBe(reason);
  };

  test("refuses when no review organization is configured", async () => {
    await expectRefusal(null, REVIEW_RESET_REFUSAL.unconfigured);
  });

  test("refuses the demo organization even when the account is its member", async () => {
    await expectRefusal(
      config(fixture.demoOrgId),
      REVIEW_RESET_REFUSAL.demoOrganization,
    );
  });

  test("refuses when the review account is the demo account", async () => {
    await expectRefusal(
      config(fixture.reviewOrgId, { DEMO_ACCOUNT_EMAIL: REVIEW_EMAIL }),
      REVIEW_RESET_REFUSAL.demoAccount,
    );
  });

  test("refuses an organization with any other member", async () => {
    await expectRefusal(
      config(fixture.sharedOrgId),
      REVIEW_RESET_REFUSAL.otherMembers,
    );
  });

  test("refuses an organization the review account does not belong to", async () => {
    await expectRefusal(
      config(fixture.foreignOrgId),
      REVIEW_RESET_REFUSAL.accountNotMember,
    );
    const foreignMatter = await testDb.$count(
      workspaces,
      eq(workspaces.id, fixture.foreignWorkspaceId),
    );
    expect(foreignMatter).toBe(1);
  });

  test("refuses an organization that does not exist", async () => {
    await expectRefusal(
      config(mintAuthProviderId<"organization">()),
      REVIEW_RESET_REFUSAL.organizationMissing,
    );
  });

  test("refuses when the review account does not exist", async () => {
    await expectRefusal(
      config(fixture.reviewOrgId, {
        APP_REVIEW_ACCOUNT_EMAIL: `missing-${Bun.randomUUIDv7()}@example.test`,
      }),
      REVIEW_RESET_REFUSAL.accountMissing,
    );
  });
});

describe("review organization seed and reset", () => {
  beforeEach(async () => {
    // Start each case from an empty review organization.
    const outcome = await resetReviewOrganization({
      config: config(fixture.reviewOrgId),
      db: ownerDb(),
      rlsDatabase: rlsDatabase(),
      runId: Bun.randomUUIDv7(),
      signal: new AbortController().signal,
      dependencies: resetDependencies,
    });
    expect(Result.isOk(outcome)).toBe(true);
  });

  test("a second seed writes nothing and the organization holds every sample kind once", async () => {
    const actor = actorFor(fixture.reviewOrgId, fixture.reviewUserId);
    const again = (
      await seedReviewOrganization(actor, { documents: documentDependencies })
    ).unwrap("Expected the second seed to succeed");
    const kinds: readonly SampleKind[] = [
      "contacts",
      "matters",
      "documents",
      "tasks",
      "timeEntries",
      "clauses",
      "templates",
      "playbooks",
      "rateTables",
      "rateEntries",
    ];
    for (const kind of kinds) {
      expect({ kind, ...again[kind] }).toEqual({
        kind,
        created: 0,
        existing: SAMPLE_COUNTS[kind],
      });
    }
    expect(await countRows(fixture.reviewOrgId)).toEqual({ ...SAMPLE_COUNTS });
    // Time billing is on for the account wherever the deployment offers it,
    // and every sample entry is billable at the sample rate.
    expect(again.enrolments.created).toBe(0);
    expect(
      await testDb.$count(
        featureEnrolments,
        and(
          eq(featureEnrolments.organizationId, fixture.reviewOrgId),
          eq(featureEnrolments.userId, fixture.reviewUserId),
          eq(featureEnrolments.featureId, "time-billing"),
        ),
      ),
    ).toBe(isDeploymentFeatureEnabled("FEATURE_TIME_BILLING") ? 1 : 0);
    expect(
      await testDb.$count(
        timeEntries,
        and(
          eq(timeEntries.organizationId, fixture.reviewOrgId),
          eq(timeEntries.billable, true),
        ),
      ),
    ).toBe(SAMPLE_COUNTS.timeEntries);
  });

  test("a seed resumes a default rate table that has no fallback rate", async () => {
    const matterIds = testDb
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.organizationId, fixture.reviewOrgId));
    await testDb
      .delete(rateEntries)
      .where(inArray(rateEntries.workspaceId, matterIds));
    const resumed = (
      await seedReviewOrganization(
        actorFor(fixture.reviewOrgId, fixture.reviewUserId),
        { documents: documentDependencies },
      )
    ).unwrap("Expected the resumed seed to succeed");
    expect(resumed.rateTables).toEqual({
      created: 0,
      existing: SAMPLE_COUNTS.rateTables,
    });
    expect(resumed.rateEntries).toEqual({
      created: SAMPLE_COUNTS.rateEntries,
      existing: 0,
    });
    expect(await countRows(fixture.reviewOrgId)).toEqual({ ...SAMPLE_COUNTS });
  });

  test("a matter created before the sweep takes its lock stops the sweep and keeps its storage", async () => {
    const lateMatterId = createSafeId<"workspace">();
    try {
      const outcome = await resetReviewOrganization({
        config: config(fixture.reviewOrgId),
        db: ownerDb(),
        rlsDatabase: rlsDatabase(),
        runId: Bun.randomUUIDv7(),
        signal: new AbortController().signal,
        dependencies: {
          ...resetDependencies,
          beforeSweep: async () => {
            await testDb.insert(workspaces).values({
              id: lateMatterId,
              organizationId: fixture.reviewOrgId,
              name: "Late matter",
              reference: "LATE-1",
            });
            await testDb.insert(savedSearches).values({
              organizationId: fixture.reviewOrgId,
              userId: fixture.reviewUserId,
              name: "Kept by the stopped sweep",
              criteria: asTestRaw<typeof savedSearches.$inferInsert.criteria>({
                version: 1,
              }),
            });
          },
        },
      });
      const report = outcome.unwrap("Expected the reset to report");
      expect(report.failures.map(({ kind }) => kind)).toContain("sweep");
      expect(report.swept.size).toBe(0);
      // The storage census never ran for it: the matter is not sealed.
      const late = await testDb
        .select({ status: workspaces.status })
        .from(workspaces)
        .where(eq(workspaces.id, lateMatterId));
      expect(late).toEqual([{ status: "active" }]);
      expect(
        await testDb.$count(
          savedSearches,
          eq(savedSearches.organizationId, fixture.reviewOrgId),
        ),
      ).toBe(1);
    } finally {
      await testDb.delete(workspaces).where(eq(workspaces.id, lateMatterId));
      await testDb
        .delete(savedSearches)
        .where(eq(savedSearches.organizationId, fixture.reviewOrgId));
    }
  });

  {
    test.each(["before the sweep", "under the sweep's lock"] as const)(
      "a cancellation %s keeps organization content and records no teardown",
      async (moment) => {
        const controller = new AbortController();
        let sweepStarted = false;
        let requestsBeforeSweep = 0;
        try {
          await resetReviewOrganization({
            config: config(fixture.reviewOrgId),
            db: ownerDb(),
            rlsDatabase: rlsDatabase(),
            runId: Bun.randomUUIDv7(),
            signal: controller.signal,
            dependencies: {
              ...resetDependencies,
              beforeSweep: async () => {
                // The matters are gone by now; leave organization-level content
                // for the sweep to (not) take.
                await testDb.insert(savedSearches).values({
                  organizationId: fixture.reviewOrgId,
                  userId: fixture.reviewUserId,
                  name: "Kept by the cancelled sweep",
                  criteria: asTestRaw<
                    typeof savedSearches.$inferInsert.criteria
                  >({ version: 1 }),
                });
                // Stored organization-level content the storage census would
                // record for erasure.
                await testDb.insert(fileComparisonUploads).values({
                  organizationId: fixture.reviewOrgId,
                  userId: fixture.reviewUserId,
                  kind: "redline",
                  declaredName: "Kept redline.docx",
                  declaredSize: 1,
                  expiresAt: new Date(Date.now() + 3_600_000),
                });
                requestsBeforeSweep = await testDb.$count(
                  entityDeletionCleanupRequests,
                  eq(
                    entityDeletionCleanupRequests.organizationId,
                    fixture.reviewOrgId,
                  ),
                );
                sweepStarted = true;
                if (moment === "before the sweep") {
                  controller.abort();
                }
              },
              afterFenceCheck: async () => {
                if (sweepStarted && moment === "under the sweep's lock") {
                  controller.abort();
                }
              },
            },
          });
          expect(sweepStarted).toBe(true);
          expect(
            await testDb.$count(
              savedSearches,
              eq(savedSearches.organizationId, fixture.reviewOrgId),
            ),
          ).toBe(1);
          expect(
            await testDb.$count(
              entityDeletionCleanupRequests,
              eq(
                entityDeletionCleanupRequests.organizationId,
                fixture.reviewOrgId,
              ),
            ),
          ).toBe(requestsBeforeSweep);
          expect(
            await testDb.$count(
              fileComparisonUploads,
              eq(fileComparisonUploads.organizationId, fixture.reviewOrgId),
            ),
          ).toBe(1);
        } finally {
          await testDb
            .delete(savedSearches)
            .where(eq(savedSearches.organizationId, fixture.reviewOrgId));
          await testDb
            .delete(fileComparisonUploads)
            .where(
              eq(fileComparisonUploads.organizationId, fixture.reviewOrgId),
            );
        }
      },
    );
  }

  test("a member who joins after the target is proved stops the reset before any delete", async () => {
    const before = await countRows(fixture.reviewOrgId);
    const joinedId = Bun.randomUUIDv7();
    try {
      const outcome = await resetReviewOrganization({
        config: config(fixture.reviewOrgId),
        db: ownerDb(),
        rlsDatabase: rlsDatabase(),
        runId: Bun.randomUUIDv7(),
        signal: new AbortController().signal,
        dependencies: {
          ...resetDependencies,
          // The auth layer's membership hooks refuse this join on every auth
          // path; the reset defends itself below them, so the row is written
          // directly, as only a data-layer write could.
          afterTargetResolved: async () => {
            await testDb.insert(member).values({
              id: joinedId,
              organizationId: fixture.reviewOrgId,
              userId: fixture.otherUserId,
              role: "member",
              createdAt: new Date(),
            });
          },
        },
      });
      expect(
        outcome.match({ ok: () => null, err: (error) => error.reason }),
      ).toBe(REVIEW_RESET_REFUSAL.otherMembers);
      expect(await countRows(fixture.reviewOrgId)).toEqual(before);
    } finally {
      await testDb.delete(member).where(eq(member.id, joinedId));
    }
  });

  test("reset removes what the reviewer added, reseeds, and leaves other organizations alone", async () => {
    const actor = actorFor(fixture.reviewOrgId, fixture.reviewUserId);
    const extraContactId = createSafeId<"contact">();
    const extraMatterId = createSafeId<"workspace">();
    const contact = await Result.gen(() =>
      createContactHandler({
        safeDb: actor.safeDb,
        organizationId: fixture.reviewOrgId,
        userId: fixture.reviewUserId,
        recordAuditEvent: actor.recorderFor(null),
        body: {
          id: extraContactId,
          type: "person",
          displayName: "Added by reviewer",
          firstName: "Added",
          lastName: "Reviewer",
        },
      }),
    );
    expect(Result.isOk(contact)).toBe(true);
    const matter = await Result.gen(() =>
      createWorkspaceHandler({
        userEmail: REVIEW_EMAIL,
        safeDb: actor.safeDb,
        organizationId: fixture.reviewOrgId,
        userId: fixture.reviewUserId,
        recordAuditEvent: actor.recorderFor(null),
        body: {
          id: extraMatterId,
          name: "Reviewer matter",
          filePropertyName: "File",
        },
      }),
    );
    expect(Result.isOk(matter)).toBe(true);
    await testDb
      .update(workspaces)
      .set({ status: "archived" })
      .where(eq(workspaces.id, extraMatterId));
    // Rows no per-kind delete names: the sweep must take them too, while the
    // kept organization settings stay.
    const extraThreadId = createSafeId<"chatThread">();
    await testDb.insert(chatThreads).values({
      id: extraThreadId,
      organizationId: fixture.reviewOrgId,
      userId: fixture.reviewUserId,
      title: "Reviewer chat",
    });
    await testDb.insert(savedSearches).values({
      organizationId: fixture.reviewOrgId,
      userId: fixture.reviewUserId,
      name: "Reviewer search",
      criteria: asTestRaw<typeof savedSearches.$inferInsert.criteria>({
        version: 1,
      }),
    });
    await testDb
      .insert(organizationSettings)
      .values({ organizationId: fixture.reviewOrgId })
      .onConflictDoNothing();

    const outcome = await resetReviewOrganization({
      config: config(fixture.reviewOrgId),
      db: ownerDb(),
      rlsDatabase: rlsDatabase(),
      runId: Bun.randomUUIDv7(),
      signal: new AbortController().signal,
      dependencies: resetDependencies,
    });
    const report = outcome.unwrap("Expected the reset to run");
    expect(report.failures).toEqual([]);
    expect(report.deleted).toEqual({
      matters: SAMPLE_COUNTS.matters + 1,
      contacts: SAMPLE_COUNTS.contacts + 1,
      clauses: SAMPLE_COUNTS.clauses,
      templates: SAMPLE_COUNTS.templates,
      playbooks: SAMPLE_COUNTS.playbooks,
    });
    expect(report.swept.get("chat_threads")).toBe(1);
    expect(report.swept.get("saved_searches")).toBe(1);
    expect(
      await testDb.$count(chatThreads, eq(chatThreads.id, extraThreadId)),
    ).toBe(0);
    expect(
      await testDb.$count(
        savedSearches,
        eq(savedSearches.organizationId, fixture.reviewOrgId),
      ),
    ).toBe(0);
    expect(
      await testDb.$count(
        organizationSettings,
        eq(organizationSettings.organizationId, fixture.reviewOrgId),
      ),
    ).toBe(1);
    report.seed.unwrap("Expected the reseed to succeed");
    expect(await countRows(fixture.reviewOrgId)).toEqual({ ...SAMPLE_COUNTS });
    expect(
      await testDb.$count(workspaces, eq(workspaces.id, extraMatterId)),
    ).toBe(0);
    expect(await testDb.$count(contacts, eq(contacts.id, extraContactId))).toBe(
      0,
    );

    // The other organizations keep their rows and members.
    expect(
      await testDb.$count(
        workspaces,
        eq(workspaces.id, fixture.foreignWorkspaceId),
      ),
    ).toBe(1);
    expect(
      await testDb.$count(contacts, eq(contacts.id, fixture.foreignContactId)),
    ).toBe(1);
    expect(
      await testDb.$count(
        member,
        eq(member.organizationId, fixture.sharedOrgId),
      ),
    ).toBe(2);
    expect(
      await testDb.$count(
        workspaces,
        eq(workspaces.organizationId, fixture.sharedOrgId),
      ),
    ).toBe(0);
    // The review account keeps its membership; only data is reset.
    expect(
      await testDb.$count(
        member,
        and(
          eq(member.organizationId, fixture.reviewOrgId),
          eq(member.userId, fixture.reviewUserId),
        ),
      ),
    ).toBe(1);
  });
});

describe("review organization reset task", () => {
  const silentLogger = asTestRaw<SchedulerTaskContext["logger"]>({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  });
  const contextFor = (runId: string) =>
    asTestRaw<SchedulerTaskContext>({
      db: ownerDb(),
      runId,
      signal: new AbortController().signal,
      logger: silentLogger,
    });

  test("does nothing when no review organization is configured", async () => {
    const task = createResetReviewOrganizationTask({ readConfig: () => null });
    const before = await countRows(fixture.reviewOrgId);
    expect(Result.isOk(await task(contextFor(Bun.randomUUIDv7())))).toBe(true);
    expect(await countRows(fixture.reviewOrgId)).toEqual(before);
  });

  test("fails the run when the configured organization is refused", async () => {
    const task = createResetReviewOrganizationTask({
      readConfig: () => config(fixture.sharedOrgId),
      dependencies: resetDependencies,
      rlsDatabase: rlsDatabase(),
    });
    const outcome = await task(contextFor(Bun.randomUUIDv7()));
    expect(Result.isError(outcome)).toBe(true);
  });

  test("records the run's totals in the system audit", async () => {
    const runId = Bun.randomUUIDv7();
    const task = createResetReviewOrganizationTask({
      readConfig: () => config(fixture.reviewOrgId),
      dependencies: resetDependencies,
      rlsDatabase: rlsDatabase(),
    });
    (await task(contextFor(runId))).unwrap("Expected the reset run to succeed");
    const rows = await testDb
      .select({ counts: systemAuditRuns.counts })
      .from(systemAuditRuns)
      .where(eq(systemAuditRuns.subject, runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.counts).toMatchObject({
      failedDeletes: 0,
      seedFailed: 0,
      seededMatters: SAMPLE_COUNTS.matters,
      seededDocuments: SAMPLE_COUNTS.documents,
    });
    expect(await countRows(fixture.reviewOrgId)).toEqual({ ...SAMPLE_COUNTS });
  });

  test("is registered ungated and, without time billing, seeds everything else", async () => {
    // The registry runs the task itself, with no feature gate in front of it.
    expect(
      createSchedulerTaskRegistry(async () => {}).get(
        RESET_REVIEW_ORGANIZATION_TASK,
      ),
    ).toBe(resetReviewOrganizationTask);

    // Enrolments survive resets (they are the account's preferences).
    await testDb
      .delete(featureEnrolments)
      .where(eq(featureEnrolments.organizationId, fixture.reviewOrgId));
    const task = createResetReviewOrganizationTask({
      readConfig: () => config(fixture.reviewOrgId),
      dependencies: {
        ...resetDependencies,
        seed: {
          documents: documentDependencies,
          timeBillingAdmitted: () => false,
        },
      },
      rlsDatabase: rlsDatabase(),
    });
    (await task(contextFor(Bun.randomUUIDv7()))).unwrap(
      "Expected the reset run to succeed without time billing",
    );
    expect(await countRows(fixture.reviewOrgId)).toEqual({
      ...SAMPLE_COUNTS,
      timeEntries: 0,
      rateTables: 0,
      rateEntries: 0,
    });
    expect(
      await testDb.$count(
        featureEnrolments,
        and(
          eq(featureEnrolments.organizationId, fixture.reviewOrgId),
          eq(featureEnrolments.featureId, "time-billing"),
        ),
      ),
    ).toBe(0);

    // With time billing back, the next run completes the sample data.
    const restored = createResetReviewOrganizationTask({
      readConfig: () => config(fixture.reviewOrgId),
      dependencies: resetDependencies,
      rlsDatabase: rlsDatabase(),
    });
    (await restored(contextFor(Bun.randomUUIDv7()))).unwrap(
      "Expected the reset run to succeed",
    );
    expect(await countRows(fixture.reviewOrgId)).toEqual({ ...SAMPLE_COUNTS });
  });
});
