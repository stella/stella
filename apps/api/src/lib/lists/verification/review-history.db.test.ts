// The STELLA_RUN_POSTGRES_TESTS runner also executes this verification suite.
/**
 * A run's review history as reviewers read it: newest first, page after page
 * without a gap or a repeat, each entry naming who acted and folding where
 * the claim stood just before and after from the stored events alone.
 */

import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  entities,
  legalListClaimReviewEvents,
  legalListClaims,
  legalListVerificationRuns,
  workspaces,
} from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { ClaimReviewEventPayload } from "@/api/lib/lists/verification/contract";
import {
  readReviewHistory,
  reviewHistoryCursor,
} from "@/api/lib/lists/verification/review-history";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
/** A member of the firm. */
const reviewerId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
/** Acted on the run, then left the firm. */
const leaverId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
const workspaceId = createSafeId<"workspace">();
const runId = createSafeId<"legalListVerificationRun">();
const bankRecord = createSafeId<"entity">();
const minutes = createSafeId<"entity">();
const plainClaim = createSafeId<"legalListClaim">();
const conflictClaim = createSafeId<"legalListClaim">();

type SeededEvent = {
  claimId: SafeId<"legalListClaim">;
  actorId: SafeId<"user">;
  payload: ClaimReviewEventPayload;
};

/** Oldest first, one second apart. */
const SEEDED: readonly SeededEvent[] = [
  {
    claimId: plainClaim,
    actorId: reviewerId,
    payload: { kind: "status", status: "reviewed", origin: "single" },
  },
  {
    claimId: conflictClaim,
    actorId: reviewerId,
    payload: {
      kind: "record-conflict",
      resolution: { kind: "governed", factEntityId: minutes },
      reason: "The board minutes are the signed record.",
    },
  },
  {
    claimId: plainClaim,
    actorId: leaverId,
    payload: {
      kind: "override",
      state: "contradicted",
      reason: "The diary entry is dated a week later.",
    },
  },
  {
    claimId: conflictClaim,
    actorId: reviewerId,
    payload: { kind: "status", status: "needs-evidence", origin: "single" },
  },
  {
    claimId: plainClaim,
    actorId: reviewerId,
    payload: { kind: "note", note: "Ask for the original diary." },
  },
  {
    claimId: conflictClaim,
    actorId: reviewerId,
    payload: {
      kind: "record-conflict",
      resolution: null,
      reason: "The minutes were amended later.",
    },
  },
];
const eventIds = SEEDED.map(() => createSafeId<"legalListClaimReviewEvent">());
const eventId = (index: number) =>
  eventIds.at(index) ?? panic(`No seeded event ${String(index)}`);
const newestFirst = eventIds.toReversed();

beforeAll(async () => {
  testDb = await getTestDb();
  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx.insert(organization).values({
      id: organizationId,
      name: "History firm",
      slug: `history-${Bun.randomUUIDv7()}`,
      createdAt: new Date("2026-11-01T09:00:00Z"),
    });
    await tx.insert(user).values([
      {
        id: reviewerId,
        name: "Dana Reviewer",
        email: `${reviewerId}@example.test`,
      },
      {
        id: leaverId,
        name: "Lee Leaver",
        email: `${leaverId}@example.test`,
      },
    ]);
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
      name: "History matter",
      reference: Bun.randomUUIDv7().slice(0, 8),
    });
    const documentId = createSafeId<"entity">();
    await tx
      .insert(entities)
      .values({ id: documentId, workspaceId, name: "Witness statement" });
    await tx.insert(legalListVerificationRuns).values({
      id: runId,
      organizationId,
      workspaceId,
      entityId: documentId,
      fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
      entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
      contentSha256: "d".repeat(64),
      evidence: { listId: createSafeId<"legalList">(), facts: [] },
      status: "completed",
    });
    const claim = {
      workspaceId,
      runId,
      type: "fact",
      anchor: { type: "docx-block", blockId: "p1", start: 0, end: 5 },
    } as const;
    await tx.insert(legalListClaims).values([
      {
        ...claim,
        id: plainClaim,
        position: 0,
        text: "The payment was made on 9 March.",
        state: "supported",
        score: 88,
        refs: [{ factEntityId: bankRecord, rel: "supports" }],
      },
      {
        ...claim,
        id: conflictClaim,
        position: 1,
        text: "The board approved the transfer.",
        state: "recordconflict",
        score: null,
        refs: [],
        recordConflict: {
          subject: "Approval date",
          factEntityIds: [bankRecord, minutes],
          values: ["9 March", "3 May"],
          governingStates: ["contradicted", "supported"],
        },
      },
    ]);
    await tx.insert(legalListClaimReviewEvents).values(
      SEEDED.map((event, index) => ({
        id: eventId(index),
        workspaceId,
        runId,
        claimId: event.claimId,
        kind: event.payload.kind,
        payload: event.payload,
        actorId: event.actorId,
        createdAt: new Date(Date.UTC(2026, 10, 11, 9, 0, index)),
      })),
    );
  });
});

afterAll(async () => {
  await deleteOrganizationsForTest(testDb, [organizationId]);
  await releaseTestDb();
});

type HistoryFilter = Omit<
  Parameters<typeof readReviewHistory>[0],
  "tx" | "workspaceId" | "organizationId" | "runId" | "cursor" | "limit"
>;

const readPage = async (
  filter: HistoryFilter,
  cursor: string | null,
  limit: number,
) =>
  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    const result = await readReviewHistory({
      tx: asTestRaw<Transaction>(tx),
      workspaceId,
      organizationId,
      runId,
      ...filter,
      cursor: cursor === null ? null : reviewHistoryCursor.decode(cursor),
      limit,
    });
    return result.type === "read"
      ? result.history
      : panic(`The seeded run reads as ${result.type}`);
  });

const readAll = async (filter: HistoryFilter, limit: number) => {
  const pages = [];
  let cursor: string | null = null;
  do {
    const page = await readPage(filter, cursor, limit);
    pages.push(page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return pages;
};

describe("review history", () => {
  test("names which of the run and the claim the workspace does not hold", async () => {
    const read = async (args: {
      runId?: typeof runId;
      claimId?: typeof plainClaim;
    }) =>
      await testDb.transaction(async (tx: TestDatabaseTransaction) => {
        await tx.execute(sql.raw("RESET ROLE"));
        return (
          await readReviewHistory({
            tx: asTestRaw<Transaction>(tx),
            workspaceId,
            organizationId,
            runId: args.runId ?? runId,
            ...(args.claimId === undefined ? {} : { claimId: args.claimId }),
            cursor: null,
            limit: 10,
          })
        ).type;
      });
    expect(
      await read({ runId: createSafeId<"legalListVerificationRun">() }),
    ).toBe("run-not-found");
    expect(await read({ claimId: createSafeId<"legalListClaim">() })).toBe(
      "claim-not-found",
    );
    expect(await read({ claimId: plainClaim })).toBe("read");
  });

  test("lists every action newest first, in pages that neither skip nor repeat", async () => {
    const whole = (await readAll({}, 100)).flat();
    expect(whole.map((entry) => entry.id)).toEqual(newestFirst);
    for (const limit of [1, 2, 4]) {
      const pages = await readAll({}, limit);
      expect(pages.every((page) => page.length <= limit)).toBe(true);
      expect(pages.flat()).toEqual(whole);
    }
  });

  test("each entry's before is the previous entry's after on the same claim", async () => {
    const whole = (await readAll({}, 100)).flat().toReversed();
    for (const claimId of [plainClaim, conflictClaim]) {
      const entries = whole.filter((entry) => entry.claimId === claimId);
      expect(entries.at(0)?.before).toEqual({
        verdict: claimId === plainClaim ? "supported" : "recordconflict",
        override: null,
        status: null,
      });
      expect(entries.slice(1).map((entry) => entry.before)).toEqual(
        entries.slice(0, -1).map((entry) => entry.after),
      );
    }
  });

  test("an entry says who acted, why, and what changed", async () => {
    const byId = new Map(
      (await readAll({}, 100)).flat().map((entry) => [entry.id, entry]),
    );
    expect(byId.get(eventId(1))).toMatchObject({
      kind: "record-conflict",
      actor: { type: "member", id: reviewerId, name: "Dana Reviewer" },
      reason: {
        type: "given",
        text: "The board minutes are the signed record.",
      },
      action: {
        kind: "record-conflict",
        resolution: { kind: "governed", factEntityId: minutes },
      },
      before: { verdict: "recordconflict", override: null, status: null },
      after: { verdict: "supported", override: null, status: null },
    });
    // The reviewer has left the firm: the action stays, the name does not.
    expect(byId.get(eventId(2))).toMatchObject({
      actor: { type: "former" },
      before: { verdict: "supported", override: null, status: "reviewed" },
      after: {
        verdict: "supported",
        override: "contradicted",
        status: "reviewed",
      },
    });
    expect(byId.get(eventId(3))).toMatchObject({
      reason: { type: "none" },
      before: { verdict: "supported", status: null },
      after: { verdict: "supported", status: "needs-evidence" },
    });
    expect(byId.get(eventId(2))?.action).not.toHaveProperty("reason");
  });

  test("filters by claim, kind and reviewer, and names only current members", async () => {
    const ids = async (filter: HistoryFilter) =>
      (await readAll(filter, 100)).flat().map((entry) => entry.id);
    expect(await ids({ claimId: plainClaim })).toEqual([
      eventId(4),
      eventId(2),
      eventId(0),
    ]);
    expect(await ids({ kind: "record-conflict" })).toEqual([
      eventId(5),
      eventId(1),
    ]);
    expect(await ids({ actorId: leaverId })).toEqual([eventId(2)]);
    const page = await readPage({}, null, 1);
    expect(page.reviewers).toEqual({
      type: "complete",
      items: [{ id: reviewerId, name: "Dana Reviewer", image: null }],
    });
  });
});
