// The STELLA_RUN_POSTGRES_TESTS runner also executes this verification suite.
/**
 * A run summary counts each claim as its reviewers see it, the state the
 * verification view counts it under: a re-checked claim counts under its new
 * grade, a reopened set-aside claim as missing coverage, a governed record
 * conflict under the governing record's verdict. Statuses, overrides and
 * notes move nothing.
 */

import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  fields,
  legalListClaimReviewEvents,
  legalListClaims,
  legalListVerificationRuns,
  properties,
  workspaces,
} from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import type {
  ClaimReviewEventPayload,
  ClaimState,
} from "@/api/lib/lists/verification/contract";
import { readClaimReviews } from "@/api/lib/lists/verification/read-run";
import {
  EMPTY_CLAIM_REVIEW,
  reviewedView,
} from "@/api/lib/lists/verification/review-fold";
import {
  listLatestRunSummaries,
  listRunSummaries,
} from "@/api/lib/lists/verification/run-summary";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
const reviewerId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
const workspaceId = createSafeId<"workspace">();
const documentId = createSafeId<"entity">();
const versionId = createSafeId<"entityVersion">();
const fileFieldId = createSafeId<"field">();
/** The run reviewers worked on. */
const reviewedRunId = createSafeId<"legalListVerificationRun">();
/** An earlier run of the same document nobody reviewed. */
const earlierRunId = createSafeId<"legalListVerificationRun">();
const bankRecord = createSafeId<"entity">();
const minutes = createSafeId<"entity">();

const rechecked = createSafeId<"legalListClaim">();
const reopened = createSafeId<"legalListClaim">();
const governed = createSafeId<"legalListClaim">();
const annotated = createSafeId<"legalListClaim">();
const untouched = createSafeId<"legalListClaim">();

type SeededEvent = {
  claimId: SafeId<"legalListClaim">;
  payload: ClaimReviewEventPayload;
};

/** Oldest first, one second apart. */
const SEEDED: readonly SeededEvent[] = [
  {
    claimId: rechecked,
    payload: {
      kind: "recheck",
      requestKey: "summary-recheck",
      grade: {
        state: "supported",
        score: 91,
        recordConflict: null,
        refs: [{ factEntityId: bankRecord, rel: "supports" }],
        qualifiers: [],
      },
      facts: { changed: [], removed: [] },
      modelRef: "test:model",
    },
  },
  {
    claimId: reopened,
    payload: { kind: "reopen", reason: "The date can be checked." },
  },
  {
    claimId: governed,
    payload: {
      kind: "record-conflict",
      resolution: { kind: "governed", factEntityId: minutes },
      reason: "The board minutes are the signed record.",
    },
  },
  {
    claimId: annotated,
    payload: { kind: "status", status: "disputed", origin: "single" },
  },
  {
    claimId: annotated,
    payload: {
      kind: "override",
      state: "contradicted",
      reason: "The diary entry is dated a week later.",
    },
  },
  {
    claimId: annotated,
    payload: { kind: "note", note: "Ask for the original diary." },
  },
];

const countsOf = (states: readonly ClaimState[]) => {
  const counts: Record<ClaimState, number> = {
    supported: 0,
    tension: 0,
    contradicted: 0,
    nocover: 0,
    notverifiable: 0,
    recordconflict: 0,
  };
  for (const state of states) {
    counts[state] += 1;
  }
  return counts;
};

/** As the run wrote them. */
const WRITTEN = countsOf([
  "contradicted",
  "notverifiable",
  "recordconflict",
  "tension",
  "supported",
]);
/** As reviewers see them: the re-check graded the claim supported, the
 *  reopened one lacks coverage, the minutes govern the conflict. */
const REVIEWED = countsOf([
  "supported",
  "nocover",
  "supported",
  "tension",
  "supported",
]);

beforeAll(async () => {
  testDb = await getTestDb();
  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx.insert(organization).values({
      id: organizationId,
      name: "Summary firm",
      slug: `summary-${Bun.randomUUIDv7()}`,
      createdAt: new Date("2026-11-01T09:00:00Z"),
    });
    await tx.insert(user).values({
      id: reviewerId,
      name: "Dana Reviewer",
      email: `${reviewerId}@example.test`,
    });
    await tx.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Summary matter",
      reference: Bun.randomUUIDv7().slice(0, 8),
    });
    await tx.insert(entities).values({
      id: documentId,
      workspaceId,
      kind: "document",
      name: "Witness statement",
    });
    await tx
      .insert(entityVersions)
      .values({ id: versionId, entityId: documentId, workspaceId });
    const propertyId = createSafeId<"property">();
    await tx.insert(properties).values({
      id: propertyId,
      workspaceId,
      name: "File",
      status: "fresh",
      content: { version: 1, type: "file" },
      tool: { version: 1, type: "manual-input" },
    });
    await tx.insert(fields).values({
      id: fileFieldId,
      workspaceId,
      entityVersionId: versionId,
      propertyId,
      content: {
        version: 1,
        type: "file",
        id: Bun.randomUUIDv7(),
        fileName: "statement.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 1,
        encrypted: false,
        sha256Hex: "a".repeat(64),
        pdfFileId: null,
      },
    });
    const run = {
      organizationId,
      workspaceId,
      entityId: documentId,
      fileFieldId,
      entityVersionId: versionId,
      contentSha256: "d".repeat(64),
      evidence: { listId: createSafeId<"legalList">(), facts: [] },
      status: "completed",
    } as const;
    await tx.insert(legalListVerificationRuns).values([
      {
        ...run,
        id: earlierRunId,
        createdAt: new Date("2026-11-10T09:00:00Z"),
      },
      {
        ...run,
        id: reviewedRunId,
        createdAt: new Date("2026-11-11T09:00:00Z"),
      },
    ]);
    const claim = {
      workspaceId,
      type: "fact",
      anchor: { type: "docx-block", blockId: "p1", start: 0, end: 5 },
    } as const;
    await tx.insert(legalListClaims).values([
      {
        ...claim,
        id: rechecked,
        runId: reviewedRunId,
        position: 0,
        text: "The payment was made on 9 March.",
        state: "contradicted",
        score: 12,
        refs: [{ factEntityId: bankRecord, rel: "conflicts" }],
      },
      {
        ...claim,
        id: reopened,
        runId: reviewedRunId,
        position: 1,
        type: "opinion",
        text: "The lender acted on 3 May.",
        state: "notverifiable",
        score: null,
      },
      {
        ...claim,
        id: governed,
        runId: reviewedRunId,
        position: 2,
        text: "The board approved the transfer.",
        state: "recordconflict",
        score: null,
        recordConflict: {
          subject: "Approval date",
          factEntityIds: [bankRecord, minutes],
          values: ["9 March", "3 May"],
          governingStates: ["contradicted", "supported"],
        },
      },
      {
        ...claim,
        id: annotated,
        runId: reviewedRunId,
        position: 3,
        text: "The diary records the meeting.",
        state: "tension",
        score: 50,
      },
      {
        ...claim,
        id: untouched,
        runId: reviewedRunId,
        position: 4,
        text: "The invoice was issued in March.",
        state: "supported",
        score: 88,
      },
      {
        ...claim,
        id: createSafeId<"legalListClaim">(),
        runId: earlierRunId,
        position: 0,
        text: "The payment was made on 9 March.",
        state: "contradicted",
        score: 15,
      },
    ]);
    await tx.insert(legalListClaimReviewEvents).values(
      SEEDED.map((event, index) => ({
        id: createSafeId<"legalListClaimReviewEvent">(),
        workspaceId,
        runId: reviewedRunId,
        claimId: event.claimId,
        kind: event.payload.kind,
        payload: event.payload,
        actorId: reviewerId,
        createdAt: new Date(Date.UTC(2026, 10, 11, 10, 0, index)),
      })),
    );
  });
});

afterAll(async () => {
  await deleteOrganizationsForTest(testDb, [organizationId]);
  await testDb.delete(user).where(eq(user.id, reviewerId));
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

/** What the verification view counts: every claim of the run through
 *  `reviewedView`, over the fold of all of its events. */
const viewCounts = async () =>
  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    const raw = asTestRaw<Transaction>(tx);
    const claims = await raw
      .select({
        id: legalListClaims.id,
        state: legalListClaims.state,
        refs: legalListClaims.refs,
        recordConflict: legalListClaims.recordConflict,
      })
      .from(legalListClaims)
      .where(eq(legalListClaims.runId, reviewedRunId));
    const reviews = await readClaimReviews({
      tx: raw,
      workspaceId,
      runId: reviewedRunId,
    });
    return countsOf(
      claims.map(
        (claim) =>
          reviewedView(
            claim,
            reviews.get(claim.id)?.review ?? EMPTY_CLAIM_REVIEW,
          ).state,
      ),
    );
  });

describe("run summaries", () => {
  test("the seeded reviews change what the claims read as", async () => {
    // Without a difference, a summary that ignored reviews would pass too.
    expect(REVIEWED).not.toEqual(WRITTEN);
    expect(await viewCounts()).toEqual(REVIEWED);
  });

  test("a document's run history counts claims as the verification view does", async () => {
    const page = (
      await listRunSummaries({
        safeDb: testSafeDb,
        workspaceId,
        entityId: documentId,
        fileFieldId,
        cursor: undefined,
        limit: 10,
      })
    ).unwrap("The run history could not be read");
    expect(page.items.map((run) => [run.id, run.claimCounts])).toEqual([
      [reviewedRunId, REVIEWED],
      [earlierRunId, countsOf(["contradicted"])],
    ]);
  });

  test("a document list's latest run counts claims as the verification view does", async () => {
    const latest = (
      await listLatestRunSummaries({
        safeDb: testSafeDb,
        workspaceId,
        documents: [{ entityId: documentId, fileFieldId }],
      })
    ).unwrap("The latest runs could not be read");
    expect(latest.map((run) => [run.id, run.claimCounts])).toEqual([
      [reviewedRunId, await viewCounts()],
    ]);
    expect(
      latest.at(0)?.claimCounts ?? panic("The document has no latest run"),
    ).toEqual(REVIEWED);
  });
});
