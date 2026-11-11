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
import { recheckClaim } from "@/api/lib/lists/verification/recheck";
import type { RecheckClaimArgs } from "@/api/lib/lists/verification/recheck";
import type { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
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

const CLAIM_TEXT = "The invoice was paid on 5 April 2021";
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
    await tx.insert(legalListVerificationBlocks).values({
      runId,
      workspaceId,
      ordinal: 0,
      blockId: "p1",
      kind: "docx-block",
      pageNumber: null,
      text: `${CLAIM_TEXT}. I believe it was proper.`,
    });
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

const recheck = async (
  args: Pick<RecheckClaimArgs, "claimId" | "requestKey"> &
    Pick<RecheckClaimArgs, "generateObjectForTask">,
) => {
  const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
  try {
    const outcome = await recheckClaim({
      ...args,
      safeDb: testSafeDb,
      workspaceId,
      runId,
      organizationId,
      userId,
      admission: testModelAdmission(
        organizationId,
        "list-verification.recheck",
      ),
      // The organization's own key: the model resolves without a deployment
      // key, and the grader itself is the injected fake.
      orgAIConfig: TEST_AI_CONFIG,
      managedAIResidency: "eu",
      promptCachingEnabled: false,
      recordAuditEvent: async () => undefined,
      signal: new AbortController().signal,
      caps: { active: 100, startsPerDay: 1000 },
    });
    return outcome.unwrap("The re-check could not reach the database");
  } finally {
    restoreMode();
  }
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
