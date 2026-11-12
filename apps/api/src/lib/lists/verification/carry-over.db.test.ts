// The STELLA_RUN_POSTGRES_TESTS runner also executes this verification suite.
/**
 * Review decisions survive a re-run: completing the next run of a document
 * carries every reviewer action on the previous run to the matching claim,
 * as the carry map allows, records what came across and what did not, and
 * never changes the previous run. A replayed completion carries nothing
 * twice.
 */

import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  entities,
  legalListClaimCarryOutcomes,
  legalListClaimReviewEvents,
  legalListClaims,
  legalListVerificationRuns,
  workspaces,
} from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { carryReviewsToRun } from "@/api/lib/lists/verification/carry-over";
import type {
  ClaimAnchor,
  StoredClaimReviewEventPayload,
} from "@/api/lib/lists/verification/contract";
import { readVerificationRun } from "@/api/lib/lists/verification/read-run";
import { foldClaimReview } from "@/api/lib/lists/verification/review-fold";
import { readReviewHistory } from "@/api/lib/lists/verification/review-history";
import { completeVerificationRun } from "@/api/lib/lists/verification/run-persistence";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createScopedQuery,
  getTestDb,
  releaseTestDb,
} from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
const reviewerId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
const workspaceId = createSafeId<"workspace">();
const documentId = createSafeId<"entity">();
const fileFieldId = toSafeId<"field">(Bun.randomUUIDv7());
const listId = createSafeId<"legalList">();
const bankRecord = createSafeId<"entity">();
const minutes = createSafeId<"entity">();

/** The reviewed run, the run of another list after it, and the new run. */
const previousRunId = createSafeId<"legalListVerificationRun">();
const otherListRunId = createSafeId<"legalListVerificationRun">();
const newRunId = createSafeId<"legalListVerificationRun">();
const PREVIOUS_RUN_AT = new Date("2026-11-09T10:00:00Z");

const anchor = (block: string): ClaimAnchor => ({
  type: "docx-block",
  blockId: block,
  start: 0,
  end: 10,
});

const supported = {
  state: "supported",
  score: 90,
  recordConflict: null,
} as const;
const contradicted = {
  state: "contradicted",
  score: 10,
  recordConflict: null,
} as const;
const conflictBetween = (first: SafeId<"entity">, second: SafeId<"entity">) =>
  ({
    state: "recordconflict",
    score: null,
    recordConflict: {
      subject: "Approval date",
      factEntityIds: [first, second],
      values: ["9 March", "3 May"],
      governingStates: ["contradicted", "supported"],
    },
  }) as const;

type Verdict =
  typeof supported | typeof contradicted | ReturnType<typeof conflictBetween>;

type SeedClaim = {
  key: string;
  text: string;
  block: string;
  verdict: Verdict;
  events: StoredClaimReviewEventPayload[];
};

/** The previous run's claims and what reviewers did on each. */
const PREVIOUS: readonly SeedClaim[] = [
  {
    key: "same",
    text: "The payment was made on 9 March.",
    block: "p1",
    verdict: supported,
    events: [
      { kind: "status", status: "reviewed", origin: "single" },
      { kind: "note", note: "Matches the bank statement." },
    ],
  },
  {
    key: "conflict",
    text: "The board approved the transfer.",
    block: "p2",
    verdict: conflictBetween(bankRecord, minutes),
    events: [
      {
        kind: "record-conflict",
        resolution: { kind: "governed", factEntityId: minutes },
        reason: "The signed minutes govern.",
      },
    ],
  },
  {
    // Recorded before reasons were required: seeded as such below.
    key: "legacy",
    text: "The witness left the meeting early.",
    block: "p3",
    verdict: supported,
    events: [{ kind: "override", state: "tension" }],
  },
  {
    key: "edited",
    text: "The contract was signed in Prague on Monday.",
    block: "p4",
    verdict: supported,
    events: [
      { kind: "status", status: "reviewed", origin: "single" },
      { kind: "note", note: "Signed at the Prague office." },
    ],
  },
  {
    key: "regraded",
    text: "The fee was paid late.",
    block: "p5",
    verdict: supported,
    events: [
      { kind: "status", status: "reviewed", origin: "single" },
      { kind: "note", note: "Late by two days." },
    ],
  },
  {
    key: "gone",
    text: "The parties met twice in May.",
    block: "p6",
    verdict: supported,
    events: [
      {
        kind: "status",
        status: "disputed",
        origin: "single",
        reason: "Only one meeting is recorded.",
      },
    ],
  },
  {
    key: "doubled",
    text: "Interest accrued daily.",
    block: "p7",
    verdict: supported,
    events: [{ kind: "note", note: "Check the loan terms." }],
  },
  {
    key: "rechecked-only",
    text: "The account was closed in June.",
    block: "p8",
    verdict: supported,
    events: [
      {
        kind: "recheck",
        requestKey: "only-a-recheck",
        grade: {
          state: "supported",
          score: 80,
          recordConflict: null,
          refs: [],
          qualifiers: [],
        },
        facts: { changed: [], removed: [] },
        modelRef: null,
      },
    ],
  },
  {
    key: "untouched",
    text: "The office moved in July.",
    block: "p9",
    verdict: supported,
    events: [],
  },
];

/** The new run's claims: what the engine found on the re-run. */
const NEXT: readonly {
  key: string;
  text: string;
  block: string;
  verdict: Verdict;
}[] = [
  // Moved to another paragraph and respaced: still the same words.
  {
    key: "same",
    text: "The payment  was made on 9 March.",
    block: "p20",
    verdict: supported,
  },
  {
    key: "conflict",
    text: "The board approved the transfer.",
    block: "p2",
    verdict: conflictBetween(minutes, bankRecord),
  },
  {
    key: "legacy",
    text: "The witness left the meeting early.",
    block: "p3",
    verdict: supported,
  },
  {
    key: "edited",
    text: "The contract was signed in Brno on Monday.",
    block: "p4",
    verdict: supported,
  },
  {
    key: "regraded",
    text: "The fee was paid late.",
    block: "p5",
    verdict: contradicted,
  },
  {
    key: "doubled-a",
    text: "Interest accrued daily.",
    block: "p7",
    verdict: supported,
  },
  {
    key: "doubled-b",
    text: "Interest accrued daily.",
    block: "p10",
    verdict: supported,
  },
  {
    key: "rechecked-only",
    text: "The account was closed in June.",
    block: "p8",
    verdict: supported,
  },
];

const previousClaimIds = new Map(
  PREVIOUS.map(({ key }) => [key, createSafeId<"legalListClaim">()]),
);
const nextClaimIds = new Map(
  NEXT.map(({ key }) => [key, createSafeId<"legalListClaim">()]),
);
const idOf = (
  ids: ReadonlyMap<string, SafeId<"legalListClaim">>,
  key: string,
): SafeId<"legalListClaim"> => ids.get(key) ?? panic(`No claim ${key}`);

type SeededEvent = {
  id: SafeId<"legalListClaimReviewEvent">;
  claimKey: string;
  payload: StoredClaimReviewEventPayload;
  createdAt: Date;
};
const seededEvents: SeededEvent[] = PREVIOUS.flatMap((claim, claimIndex) =>
  claim.events.map((payload, index) => ({
    id: createSafeId<"legalListClaimReviewEvent">(),
    claimKey: claim.key,
    payload,
    createdAt: new Date(Date.UTC(2026, 10, 9, 11, claimIndex, index)),
  })),
);

const pinned = (factEntityId: SafeId<"entity">) => ({
  factEntityId,
  text: "A fact on the list.",
  occurredOn: null,
  occurredOnPrecision: null,
  evidenceKind: null,
  medium: null,
  confidence: null,
  interpretationNote: null,
  sources: [],
});

const runRow = (
  id: SafeId<"legalListVerificationRun">,
  list: SafeId<"legalList">,
  status: "completed" | "running",
  createdAt: Date,
) => ({
  id,
  organizationId,
  workspaceId,
  entityId: documentId,
  fileFieldId,
  entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
  contentSha256: "c".repeat(64),
  evidence: { listId: list, facts: [pinned(bankRecord), pinned(minutes)] },
  status,
  createdAt,
});

const claimRow = (
  runId: SafeId<"legalListVerificationRun">,
  id: SafeId<"legalListClaim">,
  position: number,
  claim: { text: string; block: string; verdict: Verdict },
) => ({
  id,
  workspaceId,
  runId,
  position,
  type: "fact" as const,
  text: claim.text,
  anchor: anchor(claim.block),
  refs: [],
  ...claim.verdict,
});

const raw = async <T>(fn: (tx: TestDatabaseTransaction) => Promise<T>) =>
  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    return await fn(tx);
  });

const REASON_CHECK = "legal_list_claim_review_events_reason_check";

beforeAll(async () => {
  testDb = await getTestDb();
  await raw(async (tx) => {
    await tx.insert(organization).values({
      id: organizationId,
      name: "Carry firm",
      slug: `carry-${Bun.randomUUIDv7()}`,
      createdAt: new Date("2026-11-01T09:00:00Z"),
    });
    await tx.insert(user).values({
      id: reviewerId,
      name: "Dana Reviewer",
      email: `${reviewerId}@example.test`,
    });
    await tx.insert(member).values({
      id: `member_${Bun.randomUUIDv7()}`,
      organizationId,
      userId: reviewerId,
      role: "member",
      createdAt: new Date("2026-11-01T09:00:00Z"),
    });
    await tx.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Carry matter",
      reference: Bun.randomUUIDv7().slice(0, 8),
    });
    await tx
      .insert(entities)
      .values({ id: documentId, workspaceId, name: "Witness statement" });
    await tx
      .insert(legalListVerificationRuns)
      .values([
        runRow(previousRunId, listId, "completed", PREVIOUS_RUN_AT),
        runRow(
          otherListRunId,
          createSafeId<"legalList">(),
          "completed",
          new Date("2026-11-10T10:00:00Z"),
        ),
        runRow(newRunId, listId, "running", new Date("2026-11-11T10:00:00Z")),
      ]);
    await tx.insert(legalListClaims).values([
      ...PREVIOUS.map((claim, position) =>
        claimRow(
          previousRunId,
          idOf(previousClaimIds, claim.key),
          position,
          claim,
        ),
      ),
      // A run against another list: never a source, though newer.
      claimRow(otherListRunId, createSafeId<"legalListClaim">(), 0, {
        text: "The payment was made on 9 March.",
        block: "p1",
        verdict: supported,
      }),
    ]);
    // Rows from before reasons were required got past a check that did
    // not exist yet. The live check is NOT VALID for the same reason, so
    // the seed lifts it around the insert and puts back its definition.
    const check = await tx.execute<{ definition: string }>(
      sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = ${REASON_CHECK}`,
    );
    const definition =
      check.rows.at(0)?.definition ?? panic("The reason check is missing");
    await tx.execute(
      sql.raw(
        `ALTER TABLE legal_list_claim_review_events DROP CONSTRAINT ${REASON_CHECK}`,
      ),
    );
    await tx.insert(legalListClaimReviewEvents).values(
      seededEvents.map((event) => ({
        id: event.id,
        workspaceId,
        runId: previousRunId,
        claimId: idOf(previousClaimIds, event.claimKey),
        kind: event.payload.kind,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- seeds a stored row from before reasons were required
        payload: event.payload as never,
        actorId: reviewerId,
        createdAt: event.createdAt,
      })),
    );
    await tx.execute(
      sql.raw(
        `ALTER TABLE legal_list_claim_review_events ADD CONSTRAINT ${REASON_CHECK} ${definition.replace(/ NOT VALID$/u, "")} NOT VALID`,
      ),
    );
  });
});

afterAll(async () => {
  await deleteOrganizationsForTest(testDb, [organizationId]);
  await releaseTestDb();
});

const complete = async () =>
  await createScopedQuery(testDb)([workspaceId], organizationId, async (tx) => {
    await completeVerificationRun({
      tx,
      runId: newRunId,
      workspaceId,
      blocks: [],
      claims: NEXT.map((claim, position) =>
        claimRow(newRunId, idOf(nextClaimIds, claim.key), position, claim),
      ),
    });
  });

const readEvents = async (runId: SafeId<"legalListVerificationRun">) =>
  await raw(
    async (tx) =>
      await tx
        .select()
        .from(legalListClaimReviewEvents)
        .where(
          and(
            eq(legalListClaimReviewEvents.workspaceId, workspaceId),
            eq(legalListClaimReviewEvents.runId, runId),
          ),
        )
        .orderBy(
          asc(legalListClaimReviewEvents.createdAt),
          asc(legalListClaimReviewEvents.id),
        ),
  );

const eventsOn = (
  events: Awaited<ReturnType<typeof readEvents>>,
  key: string,
) => events.filter((event) => event.claimId === idOf(nextClaimIds, key));

describe("completing the next run of a document", () => {
  let previousBefore: Awaited<ReturnType<typeof readEvents>>;

  beforeAll(async () => {
    previousBefore = await readEvents(previousRunId);
    await complete();
  });

  test("records what became of each reviewed claim", async () => {
    const outcomes = await raw(
      async (tx) =>
        await tx
          .select({
            sourceClaimId: legalListClaimCarryOutcomes.sourceClaimId,
            sourceRunId: legalListClaimCarryOutcomes.sourceRunId,
            outcome: legalListClaimCarryOutcomes.outcome,
            targetClaimId: legalListClaimCarryOutcomes.targetClaimId,
          })
          .from(legalListClaimCarryOutcomes)
          .where(eq(legalListClaimCarryOutcomes.runId, newRunId)),
    );
    const expected = [
      ["same", "carried", "same"],
      ["conflict", "carried", "conflict"],
      ["legacy", "carried", "legacy"],
      ["edited", "text-changed", "edited"],
      ["regraded", "verdict-changed", "regraded"],
      ["gone", "unmatched", null],
      ["doubled", "ambiguous", null],
    ] as const;
    expect(
      new Map(outcomes.map((outcome) => [outcome.sourceClaimId, outcome])),
    ).toEqual(
      new Map(
        expected.map(([source, outcome, target]) => [
          idOf(previousClaimIds, source),
          {
            sourceClaimId: idOf(previousClaimIds, source),
            sourceRunId: previousRunId,
            outcome,
            targetClaimId: target === null ? null : idOf(nextClaimIds, target),
          },
        ]),
      ),
    );
  });

  test("copies each decision that may follow, naming its origin, with its reviewer and time", async () => {
    const events = await readEvents(newRunId);
    const origin = new Map(seededEvents.map((event) => [event.id, event]));
    for (const event of events) {
      const source =
        origin.get(
          event.carriedFromEventId ?? panic("A new-run event names no origin"),
        ) ?? panic("A carried event names an unknown origin");
      expect(event.carriedFromRunId).toBe(previousRunId);
      const stored: StoredClaimReviewEventPayload = event.payload;
      expect(stored).toEqual(source.payload);
      expect(event.actorId).toBe(reviewerId);
      expect(event.createdAt).toEqual(source.createdAt);
    }
    const reviewOf = (key: string) => foldClaimReview(eventsOn(events, key));
    expect(reviewOf("same")).toMatchObject({
      status: "reviewed",
      note: "Matches the bank statement.",
    });
    expect(reviewOf("conflict").recordConflictResolution).toEqual({
      kind: "governed",
      factEntityId: minutes,
    });
    // Kept as written, without the reason its kind now requires.
    expect(
      eventsOn(events, "legacy").map(
        (event): StoredClaimReviewEventPayload => event.payload,
      ),
    ).toEqual([{ kind: "override", state: "tension" }]);
    // Edited words: the decision on the old words is withdrawn even though
    // the verdict is the same; the note follows.
    expect(eventsOn(events, "edited").map((event) => event.kind)).toEqual([
      "note",
    ]);
    // Decided on a verdict the new run no longer gives: withdrawn; the note
    // still follows.
    expect(eventsOn(events, "regraded").map((event) => event.kind)).toEqual([
      "note",
    ]);
    expect(eventsOn(events, "doubled-a")).toEqual([]);
    expect(eventsOn(events, "doubled-b")).toEqual([]);
    expect(eventsOn(events, "rechecked-only")).toEqual([]);
  });

  test("never changes the previous run", async () => {
    expect(await readEvents(previousRunId)).toEqual(previousBefore);
  });

  test("the run says what came across and lists what did not", async () => {
    const run = await createScopedQuery(testDb)(
      [workspaceId],
      organizationId,
      async (tx) =>
        await readVerificationRun({ tx, workspaceId, runId: newRunId }),
    );
    expect(run?.carryOver).toEqual({
      sourceRunId: previousRunId,
      sourceRunCreatedAt: PREVIOUS_RUN_AT.toISOString(),
      carriedCount: 3,
      notCarried: [
        {
          sourceClaimId: idOf(previousClaimIds, "edited"),
          text: "The contract was signed in Prague on Monday.",
          outcome: "text-changed",
          targetClaimId: idOf(nextClaimIds, "edited"),
        },
        {
          sourceClaimId: idOf(previousClaimIds, "regraded"),
          text: "The fee was paid late.",
          outcome: "verdict-changed",
          targetClaimId: idOf(nextClaimIds, "regraded"),
        },
        {
          sourceClaimId: idOf(previousClaimIds, "gone"),
          text: "The parties met twice in May.",
          outcome: "unmatched",
          targetClaimId: null,
        },
        {
          sourceClaimId: idOf(previousClaimIds, "doubled"),
          text: "Interest accrued daily.",
          outcome: "ambiguous",
          targetClaimId: null,
        },
      ],
    });
    const previous = await createScopedQuery(testDb)(
      [workspaceId],
      organizationId,
      async (tx) =>
        await readVerificationRun({ tx, workspaceId, runId: previousRunId }),
    );
    expect(previous?.carryOver).toBeNull();
  });

  test("history names the run a carried decision was taken on", async () => {
    const history = await raw(
      async (tx) =>
        await readReviewHistory({
          tx: asTestRaw<Transaction>(tx),
          workspaceId,
          organizationId,
          runId: newRunId,
          claimId: idOf(nextClaimIds, "same"),
          cursor: null,
          limit: 10,
        }),
    );
    const page =
      history.type === "read"
        ? history.history
        : panic(`History reads as ${history.type}`);
    expect(page.items.map((item) => item.carriedFrom)).toEqual([
      { runId: previousRunId, runCreatedAt: PREVIOUS_RUN_AT.toISOString() },
      { runId: previousRunId, runCreatedAt: PREVIOUS_RUN_AT.toISOString() },
    ]);
    expect(page.items.at(-1)?.after.status).toBe("reviewed");
  });

  test("a replayed completion carries nothing twice", async () => {
    const before = await readEvents(newRunId);
    await complete();
    const written = await createScopedQuery(testDb)(
      [workspaceId],
      organizationId,
      async (tx) =>
        await carryReviewsToRun({ tx, runId: newRunId, workspaceId }),
    );
    expect(written).toBe(0);
    expect(await readEvents(newRunId)).toEqual(before);
  });
});
