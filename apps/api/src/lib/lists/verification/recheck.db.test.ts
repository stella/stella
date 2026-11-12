// The STELLA_RUN_POSTGRES_TESTS runner also executes this verification suite.
/**
 * Re-checking one claim: the grade lands as a reviewer event beside the
 * run's own grade, which stays as written; a repeated request key grades
 * nothing twice; a budget at its limit refuses before any model call.
 */

import { Result } from "better-result";
import { afterAll, expect, test } from "bun:test";
import { and, asc, eq, sql } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";
import { RUNTIME_MODE } from "@stll/runtime-mode";
import { createTestState } from "@stll/test-state";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  entities,
  legalListClaimReviewEvents,
  legalListClaims,
  legalListFactDetails,
  legalListItems,
  legalLists,
  legalListVerificationBlocks,
  legalListVerificationBudgets,
  legalListVerificationRuns,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import {
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import type { VerificationEvidenceFact } from "@/api/lib/lists/verification/contract";
import {
  readVerifiedClaim,
  rejectLinkedFact,
} from "@/api/lib/lists/verification/read-run";
import {
  recheckClaim,
  recheckClaims,
} from "@/api/lib/lists/verification/recheck";
import type {
  RecheckClaimArgs,
  RecheckRequest,
} from "@/api/lib/lists/verification/recheck";
import type { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getTestDb,
  releaseTestDb,
  withQueryLogger,
} from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
const testState = createTestState({ file: import.meta.path, config: env });
const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
const userId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
const workspaceId = createSafeId<"workspace">();
const listId = createSafeId<"legalList">();
const runId = createSafeId<"legalListVerificationRun">();
const statementId = createSafeId<"entity">();
/** On the list when the run started. */
const boardMinute = createSafeId<"entity">();
/** Added to the list after the run, from the bank statement. */
const bankTransfer = createSafeId<"entity">();
const gapClaim = createSafeId<"legalListClaim">();
const opinionClaim = createSafeId<"legalListClaim">();
/** A second claim without coverage, for re-checking several at once. */
const secondGapClaim = createSafeId<"legalListClaim">();

const CLAIM_TEXT = "The invoice was paid on 5 April 2021";
const SECOND_CLAIM_TEXT = "The board approved the invoice paid on 5 April 2021";
const grants = {
  [LEGAL_LISTS_FEATURE_ID]: [{ type: "organization", organizationId }],
  [LIST_VERIFICATION_FEATURE_ID]: [{ type: "organization", organizationId }],
} satisfies FeatureAccessGrants;

const pinned = (
  factEntityId: SafeId<"entity">,
  text: string,
): VerificationEvidenceFact => ({
  factEntityId,
  text,
  occurredOn: null,
  occurredOnPrecision: null,
  evidenceKind: null,
  medium: null,
  confidence: null,
  interpretationNote: null,
  sources: [],
});

testState.beforeAll(async () => {
  testState.setConfig("FEATURE_LEGAL_LISTS", true);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", grants);
  testDb = await getTestDb();
  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx.insert(organization).values({
      id: organizationId,
      name: "Re-check firm",
      slug: `recheck-${Bun.randomUUIDv7()}`,
      createdAt: new Date("2026-11-01T09:00:00Z"),
    });
    await tx.insert(user).values({
      id: userId,
      name: "Re-check Reviewer",
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    await tx.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId,
      role: "member",
      createdAt: new Date("2026-11-01T09:00:00Z"),
    });
    await tx.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Re-check matter",
      reference: Bun.randomUUIDv7().slice(0, 8),
    });
    await tx.insert(workspaceMembers).values({
      id: createSafeId<"workspaceMember">(),
      workspaceId,
      userId,
    });
    await tx.insert(legalLists).values({
      id: listId,
      workspaceId,
      name: "Chronology",
      status: "active",
      createdBy: userId,
    });
    const facts = [
      { id: boardMinute, name: "Board approved the invoice", position: "a" },
      { id: bankTransfer, name: "Invoice paid 5 April 2021", position: "b" },
    ];
    await tx.insert(entities).values([
      ...facts.map((fact) => ({
        id: fact.id,
        workspaceId,
        kind: "task" as const,
        listItemType: LIST_ITEM_TYPE.FACT,
        name: fact.name,
        createdBy: userId,
        agendaKind: "task" as const,
        status: "open" as const,
        priority: "none" as const,
        agendaSource: "manual" as const,
      })),
      {
        id: statementId,
        workspaceId,
        kind: "document" as const,
        name: "Witness statement.docx",
        createdBy: userId,
      },
    ]);
    await tx.insert(legalListItems).values(
      facts.map((fact) => ({
        entityId: fact.id,
        workspaceId,
        listId,
        position: fact.position,
        addedBy: userId,
      })),
    );
    await tx.insert(legalListVerificationRuns).values({
      id: runId,
      organizationId,
      workspaceId,
      requestedBy: userId,
      entityId: statementId,
      fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
      entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
      contentSha256: "d".repeat(64),
      // The run pinned only the board minute; the transfer came later.
      evidence: {
        listId,
        facts: [pinned(boardMinute, "Board approved the invoice")],
      },
      status: "completed",
    });
    await tx.insert(legalListVerificationBlocks).values([
      {
        runId,
        workspaceId,
        ordinal: 0,
        blockId: "p1",
        kind: "docx-block",
        pageNumber: null,
        text: `${CLAIM_TEXT}. I believe it was proper.`,
      },
      {
        runId,
        workspaceId,
        ordinal: 1,
        blockId: "p2",
        kind: "docx-block",
        pageNumber: null,
        text: `${SECOND_CLAIM_TEXT}.`,
      },
    ]);
    await tx.insert(legalListClaims).values([
      {
        id: gapClaim,
        workspaceId,
        runId,
        position: 0,
        type: "fact",
        state: "nocover",
        score: null,
        text: CLAIM_TEXT,
        anchor: {
          type: "docx-block",
          blockId: "p1",
          start: 0,
          end: CLAIM_TEXT.length,
        },
      },
      {
        id: opinionClaim,
        workspaceId,
        runId,
        position: 1,
        type: "opinion",
        state: "notverifiable",
        score: null,
        text: "I believe it was proper",
        anchor: {
          type: "docx-block",
          blockId: "p1",
          start: CLAIM_TEXT.length + 2,
          end: CLAIM_TEXT.length + 25,
        },
      },
      {
        id: secondGapClaim,
        workspaceId,
        runId,
        position: 2,
        type: "fact",
        state: "nocover",
        score: null,
        text: SECOND_CLAIM_TEXT,
        anchor: {
          type: "docx-block",
          blockId: "p2",
          start: 0,
          end: SECOND_CLAIM_TEXT.length,
        },
      },
    ]);
    await tx
      .insert(legalListVerificationBudgets)
      .values({ organizationId })
      .onConflictDoNothing();
  });
});

afterAll(async () => {
  await deleteOrganizationsForTest(testDb, [organizationId]);
  await testDb.delete(user).where(eq(user.id, userId));
  await releaseTestDb();
});

/** A `SafeDb` over the test database, wrapping anything thrown. */
const testSafeDb: SafeDb = async (fn) =>
  await Result.tryPromise({
    try: async () =>
      await testDb.transaction(async (tx: TestDatabaseTransaction) => {
        await tx.execute(sql.raw("RESET ROLE"));
        return await fn(asTestRaw<Transaction>(tx));
      }),
    catch: (cause) =>
      new DatabaseError({ message: "test transaction failed", cause }),
  });

/** A `SafeDb` that counts every statement it runs. */
const countingSafeDb = () => {
  const counted = { statements: 0 };
  const database = withQueryLogger(testDb, {
    logQuery: () => {
      counted.statements += 1;
    },
  });
  const safeDb: SafeDb = async (fn) =>
    await Result.tryPromise({
      try: async () =>
        await database.transaction(async (tx: TestDatabaseTransaction) => {
          await tx.execute(sql.raw("RESET ROLE"));
          return await fn(asTestRaw<Transaction>(tx));
        }),
      catch: (cause) =>
        new DatabaseError({ message: "test transaction failed", cause }),
    });
  return { counted, safeDb };
};

/** The grader's answer: the claim rests on the second fact it was shown. */
const fakeGrader = () => {
  const requests: string[] = [];
  const generate = asTestRaw<typeof generateTanStackObjectForTask>(
    async (request: unknown) => {
      requests.push(JSON.stringify(request));
      return {
        grades: [
          {
            claimId: "C1",
            verdict: "supported",
            score: 84,
            refs: [{ factId: "F2", rel: "supports" }],
            conflict: null,
            qualifiers: [],
          },
        ],
      };
    },
  );
  return { requests, generate };
};

const TEST_AI_CONFIG = {
  providers: [{ provider: "openai", apiKey: "fixture-key" }],
  overrideModels: null,
  decision: null,
} satisfies OrgAIConfig;

const recheckContext = () => ({
  safeDb: testSafeDb,
  workspaceId,
  runId,
  organizationId,
  userId,
  admission: testModelAdmission(organizationId, "list-verification.recheck"),
  // The organization's own key: the model resolves without a deployment
  // key, and the grader itself is the injected fake.
  orgAIConfig: TEST_AI_CONFIG,
  managedAIResidency: "eu" as const,
  promptCachingEnabled: false,
  recordAuditEvent: async () => undefined,
  signal: new AbortController().signal,
  caps: { active: 100, startsPerDay: 1000 },
});

const recheck = async (
  args: Pick<RecheckClaimArgs, "claimId" | "requestKey"> &
    Pick<RecheckClaimArgs, "generateObjectForTask">,
) => {
  const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
  try {
    const outcome = await recheckClaim({ ...args, ...recheckContext() });
    return outcome.unwrap("The re-check could not reach the database");
  } finally {
    restoreMode();
  }
};

/** Re-check several claims in one request; each claim's outcome by id. */
const recheckMany = async (
  requests: readonly RecheckRequest[],
  generateObjectForTask: RecheckClaimArgs["generateObjectForTask"],
  safeDb: SafeDb = testSafeDb,
) => {
  const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
  try {
    const outcomes = await recheckClaims({
      ...recheckContext(),
      safeDb,
      requests,
      generateObjectForTask,
    });
    return Object.fromEntries(
      outcomes.unwrap("The re-checks could not reach the database"),
    );
  } finally {
    restoreMode();
  }
};

/** A grader that answers only the claims it is told to, each supported by
 *  the second fact it was shown. */
const graderAnswering = (promptIds: readonly string[]) => {
  const requests: string[] = [];
  const generate = asTestRaw<typeof generateTanStackObjectForTask>(
    async (request: unknown) => {
      requests.push(JSON.stringify(request));
      return {
        grades: promptIds.map((claimId) => ({
          claimId,
          verdict: "supported",
          score: 80,
          refs: [{ factId: "F2", rel: "supports" }],
          conflict: null,
          qualifiers: [],
        })),
      };
    },
  );
  return { requests, generate };
};

const claimRow = async (claimId: SafeId<"legalListClaim">) =>
  await testDb
    .select()
    .from(legalListClaims)
    .where(eq(legalListClaims.id, claimId));

const recheckEvents = async (claimId: SafeId<"legalListClaim">) =>
  await testDb
    .select({
      payload: legalListClaimReviewEvents.payload,
      actorId: legalListClaimReviewEvents.actorId,
    })
    .from(legalListClaimReviewEvents)
    .where(
      and(
        eq(legalListClaimReviewEvents.claimId, claimId),
        eq(legalListClaimReviewEvents.kind, "recheck"),
      ),
    )
    .orderBy(asc(legalListClaimReviewEvents.createdAt));

const readClaim = async (claimId: SafeId<"legalListClaim">) =>
  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    return await readVerifiedClaim({
      tx: asTestRaw<Transaction>(tx),
      workspaceId,
      runId,
      claimId,
    });
  });

test("a re-check appends its grade and never rewrites the claim", async () => {
  const before = await claimRow(gapClaim);
  const grader = fakeGrader();
  expect(
    await recheck({
      claimId: gapClaim,
      requestKey: "first",
      generateObjectForTask: grader.generate,
    }),
  ).toEqual({ type: "rechecked", replayed: false });

  expect(await claimRow(gapClaim)).toEqual(before);
  const events = await recheckEvents(gapClaim);
  expect(events).toHaveLength(1);
  expect(events.at(0)).toMatchObject({
    actorId: userId,
    payload: {
      kind: "recheck",
      requestKey: "first",
      grade: {
        state: "supported",
        score: 84,
        refs: [{ factEntityId: bankTransfer, rel: "supports" }],
      },
      // The board minute reads as the run pinned it; only the transfer is new.
      facts: { removed: [] },
    },
  });
  const payload = events.at(0)?.payload;
  expect(
    payload?.kind === "recheck"
      ? payload.facts.changed.map((fact) => fact.factEntityId)
      : null,
  ).toEqual([bankTransfer]);

  const claim = await readClaim(gapClaim);
  expect(claim).toMatchObject({
    verdict: { state: "supported", score: 84 },
    refs: [{ factEntityId: bankTransfer, rel: "supports" }],
    recheck: {
      checkedBy: userId,
      factCount: 2,
      original: { verdict: { state: "nocover" }, refs: [] },
    },
  });
  // A fact the run never pinned is shown as the re-check read it.
  expect(claim?.recheck?.facts.map((fact) => fact.text)).toEqual([
    "Invoice paid 5 April 2021",
  ]);
  // The new grade read the list as it stands, so nothing on it is new to
  // the claim any more.
  expect(claim?.staleness).toEqual([]);
});

test("a fact added after the run marks the claim it bears on, and an edit to a cited fact marks its grade", async () => {
  // The second claim was graded by the run alone, which never read the
  // transfer; the transfer's words are on its point.
  expect((await readClaim(secondGapClaim))?.staleness).toEqual([
    {
      kind: "new-fact-related",
      factEntityId: bankTransfer,
      text: "Invoice paid 5 April 2021",
    },
  ]);
  const grader = graderAnswering(["C1"]);
  expect(
    await recheck({
      claimId: secondGapClaim,
      requestKey: "second-first",
      generateObjectForTask: grader.generate,
    }),
  ).toEqual({ type: "rechecked", replayed: false });
  expect((await readClaim(secondGapClaim))?.staleness).toEqual([]);

  // Its grade cites the transfer; editing the transfer outdates it.
  await testDb
    .update(entities)
    .set({ name: "Invoice paid 6 April 2021" })
    .where(eq(entities.id, bankTransfer));
  try {
    expect((await readClaim(secondGapClaim))?.staleness).toEqual([
      {
        kind: "fact-changed",
        factEntityId: bankTransfer,
        text: "Invoice paid 6 April 2021",
      },
    ]);
  } finally {
    await testDb
      .update(entities)
      .set({ name: "Invoice paid 5 April 2021" })
      .where(eq(entities.id, bankTransfer));
  }
  expect((await readClaim(secondGapClaim))?.staleness).toEqual([]);
});

test("the same request key grades the claim once", async () => {
  const grader = fakeGrader();
  const sent = {
    claimId: gapClaim,
    requestKey: "repeat",
    generateObjectForTask: grader.generate,
  };
  expect(await recheck(sent)).toEqual({ type: "rechecked", replayed: false });
  const count = (await recheckEvents(gapClaim)).length;
  expect(await recheck(sent)).toEqual({ type: "rechecked", replayed: true });
  expect(grader.requests).toHaveLength(1);
  expect(await recheckEvents(gapClaim)).toHaveLength(count);
});

test("a fact a reviewer linked is pointed out to the grader", async () => {
  await testDb.insert(legalListClaimReviewEvents).values({
    id: createSafeId<"legalListClaimReviewEvent">(),
    workspaceId,
    runId,
    claimId: gapClaim,
    kind: "fact-link",
    payload: { kind: "fact-link", factEntityId: bankTransfer, change: "link" },
    actorId: userId,
  });
  const grader = fakeGrader();
  await recheck({
    claimId: gapClaim,
    requestKey: "linked",
    generateObjectForTask: grader.generate,
  });
  expect(grader.requests.at(0)).toContain("reviewer points to: F2");
});

test("a grade overtaken by a newer re-check is not recorded over it", async () => {
  const later = fakeGrader();
  // While the first grading is out, another re-check of the claim lands.
  const overtaken = asTestRaw<typeof generateTanStackObjectForTask>(
    async (request: unknown) => {
      expect(
        await recheck({
          claimId: gapClaim,
          requestKey: "newer",
          generateObjectForTask: later.generate,
        }),
      ).toEqual({ type: "rechecked", replayed: false });
      return await fakeGrader().generate(asTestRaw(request));
    },
  );
  const count = (await recheckEvents(gapClaim)).length;
  expect(
    await recheck({
      claimId: gapClaim,
      requestKey: "older",
      generateObjectForTask: overtaken,
    }),
  ).toEqual({ type: "superseded" });
  const events = await recheckEvents(gapClaim);
  expect(events).toHaveLength(count + 1);
  expect(events.at(-1)?.payload).toMatchObject({ requestKey: "newer" });
});

test("a grade whose access was withdrawn while grading records nothing", async () => {
  const count = (await recheckEvents(gapClaim)).length;
  const withdrawn = asTestRaw<typeof generateTanStackObjectForTask>(
    async (request: unknown) => {
      testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
        [LEGAL_LISTS_FEATURE_ID]: grants[LEGAL_LISTS_FEATURE_ID],
      } satisfies FeatureAccessGrants);
      return await fakeGrader().generate(asTestRaw(request));
    },
  );
  try {
    expect(
      await recheck({
        claimId: gapClaim,
        requestKey: "withdrawn",
        generateObjectForTask: withdrawn,
      }),
    ).toEqual({ type: "access-revoked" });
  } finally {
    testState.setConfig("API_FEATURE_ACCESS_GRANTS", grants);
  }
  expect(await recheckEvents(gapClaim)).toHaveLength(count);
});

test("an organization at its daily limit is refused before any model call", async () => {
  await testDb
    .update(legalListVerificationBudgets)
    .set({ startsToday: sql`${legalListVerificationBudgets.dailyLimit}` })
    .where(eq(legalListVerificationBudgets.organizationId, organizationId));
  const grader = fakeGrader();
  const count = (await recheckEvents(gapClaim)).length;
  try {
    const outcome = await recheck({
      claimId: gapClaim,
      requestKey: "over-budget",
      generateObjectForTask: grader.generate,
    });
    expect(outcome.type).toBe("run-limit");
    expect(grader.requests).toHaveLength(0);
    expect(await recheckEvents(gapClaim)).toHaveLength(count);
  } finally {
    await testDb
      .update(legalListVerificationBudgets)
      .set({ startsToday: 0 })
      .where(eq(legalListVerificationBudgets.organizationId, organizationId));
  }
});

test("a claim set aside as not verifiable is reopened before a re-check", async () => {
  const grader = fakeGrader();
  expect(
    await recheck({
      claimId: opinionClaim,
      requestKey: "set-aside",
      generateObjectForTask: grader.generate,
    }),
  ).toEqual({ type: "recheck-set-aside-claim" });
  expect(grader.requests).toHaveLength(0);
});

test("several claims are graded in one call, each under its own key, and a repeat grades none again", async () => {
  const requests = [
    { claimId: gapClaim, requestKey: "bulk-gap" },
    { claimId: secondGapClaim, requestKey: "bulk-second" },
  ];
  const before = {
    gap: (await recheckEvents(gapClaim)).length,
    second: (await recheckEvents(secondGapClaim)).length,
  };
  const grader = graderAnswering(["C1", "C2"]);
  expect(await recheckMany(requests, grader.generate)).toEqual({
    [gapClaim]: { type: "rechecked", replayed: false },
    [secondGapClaim]: { type: "rechecked", replayed: false },
  });
  expect(grader.requests).toHaveLength(1);
  expect(await recheckEvents(gapClaim)).toHaveLength(before.gap + 1);
  expect(await recheckEvents(secondGapClaim)).toHaveLength(before.second + 1);

  const repeat = graderAnswering(["C1", "C2"]);
  expect(await recheckMany(requests, repeat.generate)).toEqual({
    [gapClaim]: { type: "rechecked", replayed: true },
    [secondGapClaim]: { type: "rechecked", replayed: true },
  });
  expect(repeat.requests).toHaveLength(0);
  expect(await recheckEvents(gapClaim)).toHaveLength(before.gap + 1);
  expect(await recheckEvents(secondGapClaim)).toHaveLength(before.second + 1);
});

test("re-checking more claims runs no more statements", async () => {
  const measure = async (requests: readonly RecheckRequest[]) => {
    const { counted, safeDb } = countingSafeDb();
    const outcomes = await recheckMany(
      requests,
      graderAnswering(["C1", "C2"]).generate,
      safeDb,
    );
    expect(
      Object.values(outcomes).every((outcome) => outcome.type === "rechecked"),
    ).toBe(true);
    return counted.statements;
  };
  const one = await measure([{ claimId: gapClaim, requestKey: "measure-one" }]);
  const two = await measure([
    { claimId: gapClaim, requestKey: "measure-two-gap" },
    { claimId: secondGapClaim, requestKey: "measure-two-second" },
  ]);
  expect(one).toBeGreaterThan(0);
  expect(two).toBe(one);
});

test("each claim reports its own refusal and the rest are still graded", async () => {
  const missing = createSafeId<"legalListClaim">();
  const before = (await recheckEvents(gapClaim)).length;
  // The grader answers the first claim only, before and after its repair
  // round; the second claim is left unanswered.
  const grader = graderAnswering(["C1"]);
  const outcomes = await recheckMany(
    [
      { claimId: gapClaim, requestKey: "partial-gap" },
      { claimId: opinionClaim, requestKey: "partial-opinion" },
      { claimId: missing, requestKey: "partial-missing" },
      { claimId: secondGapClaim, requestKey: "partial-second" },
    ],
    grader.generate,
  );
  expect(outcomes).toMatchObject({
    [gapClaim]: { type: "rechecked", replayed: false },
    [opinionClaim]: { type: "recheck-set-aside-claim" },
    [missing]: { type: "not-found" },
    [secondGapClaim]: { type: "grading-failed" },
  });
  expect(await recheckEvents(gapClaim)).toHaveLength(before + 1);
  expect(
    (await recheckEvents(secondGapClaim)).some(
      ({ payload }) =>
        payload.kind === "recheck" && payload.requestKey === "partial-second",
    ),
  ).toBe(false);
});

test("an organization at its daily limit is refused before any of several claims is graded", async () => {
  await testDb
    .update(legalListVerificationBudgets)
    .set({ startsToday: sql`${legalListVerificationBudgets.dailyLimit}` })
    .where(eq(legalListVerificationBudgets.organizationId, organizationId));
  const grader = graderAnswering(["C1", "C2"]);
  try {
    const outcomes = await recheckMany(
      [
        { claimId: gapClaim, requestKey: "bulk-over-budget-gap" },
        { claimId: secondGapClaim, requestKey: "bulk-over-budget-second" },
      ],
      grader.generate,
    );
    expect(Object.values(outcomes).map((outcome) => outcome.type)).toEqual([
      "run-limit",
      "run-limit",
    ]);
    expect(grader.requests).toHaveLength(0);
  } finally {
    await testDb
      .update(legalListVerificationBudgets)
      .set({ startsToday: 0 })
      .where(eq(legalListVerificationBudgets.organizationId, organizationId));
  }
});

test("only a fact of the verified list that is checked against can be linked", async () => {
  const rejection = async (factEntityId: SafeId<"entity">) =>
    await testDb.transaction(async (tx: TestDatabaseTransaction) => {
      await tx.execute(sql.raw("RESET ROLE"));
      return await rejectLinkedFact({
        tx: asTestRaw<Transaction>(tx),
        workspaceId,
        runId,
        factEntityId,
      });
    });
  // Added after the run, so only the list itself knows it.
  expect(await rejection(bankTransfer)).toBeNull();
  expect(await rejection(statementId)).toBe("fact-not-on-list");
  await testDb.insert(legalListFactDetails).values({
    itemEntityId: boardMinute,
    workspaceId,
    listId,
    confidence: "low",
    scoring: "held",
  });
  expect(await rejection(boardMinute)).toBe("fact-held");
});
