// The STELLA_RUN_POSTGRES_TESTS runner also executes this verification suite.
/**
 * A claim's asserted date in storage: what the engine writes reads back
 * unchanged, the table refuses a date without its source or a partial date
 * not stored as its first day, a re-check's reading replaces the run's, and
 * a claim written before claims carried dates reads its words.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
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
import { assertedDateColumns } from "@/api/lib/lists/verification/claim-date";
import type {
  ClaimAssertedDate,
  ClaimGrade,
  ClaimReviewEventPayload,
  StoredClaimReviewEventPayload,
} from "@/api/lib/lists/verification/contract";
import { readVerificationRun } from "@/api/lib/lists/verification/read-run";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
const workspaceId = createSafeId<"workspace">();
const runId = createSafeId<"legalListVerificationRun">();

beforeAll(async () => {
  testDb = await getTestDb();
  await testDb.insert(organization).values({
    id: organizationId,
    name: "Asserted date firm",
    slug: `asserted-date-${Bun.randomUUIDv7()}`,
    createdAt: new Date("2026-11-01T09:00:00Z"),
  });
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Asserted date matter",
    reference: Bun.randomUUIDv7().slice(0, 8),
  });
  const documentId = toSafeId<"entity">(Bun.randomUUIDv7());
  await testDb
    .insert(entities)
    .values({ id: documentId, workspaceId, name: "Witness statement" });
  await testDb.insert(legalListVerificationRuns).values({
    id: runId,
    organizationId,
    workspaceId,
    entityId: documentId,
    fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
    entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
    contentSha256: "e".repeat(64),
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
  text: string,
  overrides: Omit<Partial<typeof legalListClaims.$inferInsert>, "id"> = {},
) => {
  const position = nextPosition;
  nextPosition += 1;
  return {
    id: createSafeId<"legalListClaim">(),
    workspaceId,
    runId,
    position,
    type: "fact",
    state: "nocover",
    score: null,
    text,
    anchor: { type: "docx-block", blockId: "p1", start: 0, end: text.length },
    ...overrides,
  } satisfies typeof legalListClaims.$inferInsert;
};

const readAssertedDates = async () => {
  const run = await readVerificationRun({
    tx: asTestRaw<Pick<Transaction, "select">>(testDb),
    workspaceId,
    runId,
  });
  return new Map(
    (run?.claims ?? []).map((read) => [read.id, read.assertedOn] as const),
  );
};

const stores = async (values: typeof legalListClaims.$inferInsert) =>
  await testDb
    .insert(legalListClaims)
    .values(values)
    .then(
      () => "stored",
      () => "rejected",
    );

describe("claim asserted dates", () => {
  test("every date the engine writes reads back as written", async () => {
    const written: readonly ClaimAssertedDate[] = [
      { type: "dated", source: "text", date: "2021-08-10", precision: "day" },
      { type: "dated", source: "text", date: "2021-08-01", precision: "month" },
      {
        type: "dated",
        source: "grader",
        date: "2021-01-01",
        precision: "year",
      },
      { type: "none" },
    ];
    const rows = written.map((asserted) =>
      claim("The board met.", assertedDateColumns(asserted)),
    );
    await testDb.insert(legalListClaims).values(rows);
    const read = await readAssertedDates();
    expect(rows.map((row) => read.get(row.id))).toEqual([...written]);
  });

  test("a date is stored with its source and precision, on its first day", async () => {
    const refused = [
      {
        assertedOn: "2021-08-10",
        assertedOnPrecision: null,
        assertedOnSource: "text",
      },
      { assertedOn: null, assertedOnPrecision: null, assertedOnSource: "text" },
      {
        assertedOn: "2021-08-10",
        assertedOnPrecision: "day",
        assertedOnSource: "none",
      },
      {
        assertedOn: "2021-08-10",
        assertedOnPrecision: "day",
        assertedOnSource: "pending",
      },
      {
        assertedOn: "2021-08-10",
        assertedOnPrecision: "month",
        assertedOnSource: "text",
      },
      {
        assertedOn: "2021-08-01",
        assertedOnPrecision: "year",
        assertedOnSource: "grader",
      },
    ] as const;
    for (const columns of refused) {
      expect(await stores(claim("The board met.", columns))).toBe("rejected");
    }
    expect(
      await stores(
        claim("The board met.", {
          assertedOn: "2021-01-01",
          assertedOnPrecision: "year",
          assertedOnSource: "grader",
        }),
      ),
    ).toBe("stored");
    const sourceCheck = await testDb.execute(
      sql`SELECT 1 FROM pg_constraint WHERE conname = 'legal_list_claims_asserted_on_check'`,
    );
    expect(sourceCheck.rows).toHaveLength(1);
  });

  test("a claim stored before claims carried dates reads its words", async () => {
    const pending = claim("On 2-20 August 2021 I was abroad.");
    await testDb.insert(legalListClaims).values(pending);
    const read = await readAssertedDates();
    expect(read.get(pending.id)).toEqual({
      type: "dated",
      source: "text",
      date: "2021-08-01",
      precision: "month",
    });
  });

  test("a re-check's reading is the date the claim is read with; an older re-check keeps the run's", async () => {
    const run: ClaimAssertedDate = {
      type: "dated",
      source: "text",
      date: "2021-08-10",
      precision: "day",
    };
    const rechecked = claim(
      "On 10 August 2021 I called.",
      assertedDateColumns(run),
    );
    const legacy = claim(
      "On 10 August 2021 I called.",
      assertedDateColumns(run),
    );
    await testDb.insert(legalListClaims).values([rechecked, legacy]);
    const grade: ClaimGrade = {
      state: "nocover",
      score: null,
      recordConflict: null,
      refs: [],
      qualifiers: [],
    };
    const regraded: ClaimAssertedDate = {
      type: "dated",
      source: "grader",
      date: "2021-08-01",
      precision: "month",
    };
    const recorded: ClaimReviewEventPayload = {
      kind: "recheck",
      requestKey: "asserted-date",
      grade,
      facts: { changed: [], removed: [] },
      modelRef: null,
      assertedOn: regraded,
    };
    // As stored before re-checks recorded a date.
    const before: StoredClaimReviewEventPayload = {
      kind: "recheck",
      requestKey: "before-dates",
      grade,
      facts: { changed: [], removed: [] },
      modelRef: null,
    };
    const event = (
      claimId: SafeId<"legalListClaim">,
      payload: StoredClaimReviewEventPayload,
    ) => ({
      id: createSafeId<"legalListClaimReviewEvent">(),
      workspaceId,
      runId,
      claimId,
      kind: payload.kind,
      payload: asTestRaw<ClaimReviewEventPayload>(payload),
    });
    await testDb
      .insert(legalListClaimReviewEvents)
      .values([event(rechecked.id, recorded), event(legacy.id, before)]);
    const read = await readAssertedDates();
    expect(read.get(rechecked.id)).toEqual(regraded);
    expect(read.get(legacy.id)).toEqual(run);
  });
});
