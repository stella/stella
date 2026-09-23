/**
 * The verdict and review invariants the verification tables state
 * themselves, so no writer (engine, handler, or a future import) can store a
 * claim whose verdict and score disagree, or rewrite a reviewer's action.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import {
  legalListClaimReviewEvents,
  legalListClaims,
  legalListVerificationRuns,
  workspaces,
} from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createScopedQuery,
  getTestDb,
  releaseTestDb,
} from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
const workspaceId = createSafeId<"workspace">();
const runId = createSafeId<"legalListVerificationRun">();
const FACT = toSafeId<"entity">(Bun.randomUUIDv7());
const OTHER_FACT = toSafeId<"entity">(Bun.randomUUIDv7());

beforeAll(async () => {
  testDb = await getTestDb();
  await testDb.insert(organization).values({
    id: organizationId,
    name: "Verification test firm",
    slug: `verification-${Bun.randomUUIDv7()}`,
    createdAt: new Date(),
  });
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Verification matter",
    reference: Bun.randomUUIDv7().slice(0, 8),
  });
  await testDb.insert(legalListVerificationRuns).values({
    id: runId,
    workspaceId,
    entityId: toSafeId<"entity">(Bun.randomUUIDv7()),
    fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
    entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
    contentSha256: "a".repeat(64),
    evidence: {
      listId: toSafeId<"legalList">(Bun.randomUUIDv7()),
      facts: [],
    },
    status: "completed",
  });
});

afterAll(async () => {
  await releaseTestDb();
});

let nextPosition = 0;

const claim = (
  overrides: Partial<typeof legalListClaims.$inferInsert>,
): typeof legalListClaims.$inferInsert => {
  nextPosition += 1;
  return {
    id: createSafeId<"legalListClaim">(),
    workspaceId,
    runId,
    position: nextPosition,
    type: "fact",
    state: "supported",
    score: 90,
    text: "I first met him on 9 March 2021.",
    anchor: { type: "docx-block", blockId: "p2", start: 0, end: 32 },
    refs: [{ factEntityId: FACT, rel: "supports" }],
    ...overrides,
  };
};

const rejects = async (values: typeof legalListClaims.$inferInsert) => {
  const outcome = await testDb
    .insert(legalListClaims)
    .values(values)
    .then(
      () => "stored",
      () => "rejected",
    );
  expect(outcome).toBe("rejected");
};

describe("verification claims", () => {
  test("a scored state always carries a 0-100 score", async () => {
    await rejects(claim({ state: "supported", score: null }));
    await rejects(claim({ state: "tension", score: 101 }));
    await rejects(claim({ state: "nocover", score: 40, refs: [] }));
  });

  test("only a fact is checkable, and a fact is never set aside", async () => {
    await rejects(claim({ type: "opinion" }));
    await rejects(claim({ state: "notverifiable", score: null }));
  });

  test("only a record conflict carries the two records", async () => {
    const conflict = {
      subject: "Date of the first meeting",
      factEntityIds: [FACT, OTHER_FACT],
      values: ["9 March 2021", "3 May 2021"],
      governingStates: ["supported", "contradicted"],
    } as const;
    await rejects(claim({ state: "recordconflict", score: null }));
    await rejects(claim({ recordConflict: conflict }));
    await testDb
      .insert(legalListClaims)
      .values(
        claim({
          state: "recordconflict",
          score: null,
          recordConflict: conflict,
        }),
      );
  });
});

describe("claim review events", () => {
  const seedClaim = async (): Promise<SafeId<"legalListClaim">> => {
    const values = claim({});
    await testDb.insert(legalListClaims).values(values);
    return toSafeId<"legalListClaim">(values.id);
  };

  test("the payload names the same event as its kind", async () => {
    const claimId = await seedClaim();
    const outcome = await testDb
      .insert(legalListClaimReviewEvents)
      .values({
        id: createSafeId<"legalListClaimReviewEvent">(),
        workspaceId,
        runId,
        claimId,
        kind: "override",
        payload: { kind: "reopen" },
      })
      .then(
        () => "stored",
        () => "rejected",
      );
    expect(outcome).toBe("rejected");
  });

  test("a recorded action cannot be rewritten or removed", async () => {
    const claimId = await seedClaim();
    const eventId = createSafeId<"legalListClaimReviewEvent">();
    await testDb.insert(legalListClaimReviewEvents).values({
      id: eventId,
      workspaceId,
      runId,
      claimId,
      kind: "note",
      payload: { kind: "note", note: "Check the diary." },
    });

    const scopedQuery = createScopedQuery(testDb);
    const touched = await scopedQuery(
      [workspaceId],
      organizationId,
      async (tx) => {
        const byEvent = and(
          eq(legalListClaimReviewEvents.id, eventId),
          eq(legalListClaimReviewEvents.workspaceId, workspaceId),
        );
        const updated = await tx
          .update(legalListClaimReviewEvents)
          .set({ payload: { kind: "note", note: "rewritten" } })
          .where(byEvent)
          .returning({ id: legalListClaimReviewEvents.id });
        const deleted = await tx
          .delete(legalListClaimReviewEvents)
          .where(byEvent)
          .returning({ id: legalListClaimReviewEvents.id });
        const visible = await tx
          .select({ id: legalListClaimReviewEvents.id })
          .from(legalListClaimReviewEvents)
          .where(byEvent);
        return {
          updated: updated.length,
          deleted: deleted.length,
          visible: visible.length,
        };
      },
    );
    expect(touched).toEqual({ updated: 0, deleted: 0, visible: 1 });
  });
});
