// The STELLA_RUN_POSTGRES_TESTS runner also executes this verification suite.
/**
 * A claim's qualifiers as the run read returns them: the grader's stored
 * ones, and the ones computed from the facts its verdict rests on as they
 * stand on the list at the moment of reading, so a fact that gains a source
 * or is held after the run changes what the claim says without a re-run.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  entities,
  entityVersions,
  legalListClaimReviewEvents,
  legalListClaims,
  legalListFactDetails,
  legalListItems,
  legalListItemSources,
  legalLists,
  legalListSourceDocuments,
  legalListVerificationRuns,
  workspaces,
} from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  VerificationEvidenceFact,
  VerificationEvidenceSource,
} from "@/api/lib/lists/verification/contract";
import {
  claimNeedsAttention,
  readClaimReviews,
  readClaimsForBulkReview,
  readRunAttentionInputs,
  readVerificationRun,
} from "@/api/lib/lists/verification/read-run";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
const userId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
const workspaceId = createSafeId<"workspace">();
const listId = createSafeId<"legalList">();
const runId = createSafeId<"legalListVerificationRun">();
const documentId = createSafeId<"entity">();
const documentVersionId = createSafeId<"entityVersion">();
/** A second record, never marked as testimony. */
const ledgerId = createSafeId<"entity">();
const ledgerVersionId = createSafeId<"entityVersion">();
const statementId = createSafeId<"entity">();

/** Sourced when pinned and still sourced. */
const bankRecord = createSafeId<"entity">();
/** Unsourced throughout. */
const diaryNote = createSafeId<"entity">();
/** Unsourced when pinned; gains a source after the run. */
const leaveCalendar = createSafeId<"entity">();
/** Included when pinned; held after the run. */
const marginNote = createSafeId<"entity">();
/** Pinned with a source, then taken off the list. */
const removedEmail = createSafeId<"entity">();

const source = {
  sourceEntityId: documentId,
  sourceEntityVersionId: documentVersionId,
  sourceName: "Email bundle.pdf",
  locator: { type: "document" },
  quote: null,
} satisfies VerificationEvidenceSource;

const pinned = (
  factEntityId: SafeId<"entity">,
  text: string,
  sources: readonly VerificationEvidenceSource[],
): VerificationEvidenceFact => ({
  factEntityId,
  text,
  occurredOn: null,
  occurredOnPrecision: null,
  evidenceKind: null,
  medium: null,
  confidence: "high",
  interpretationNote: null,
  sources,
});

const claimIds = {
  sourcedSupport: createSafeId<"legalListClaim">(),
  unsourcedSupport: createSafeId<"legalListClaim">(),
  silent: createSafeId<"legalListClaim">(),
  widened: createSafeId<"legalListClaim">(),
  governedByHeld: createSafeId<"legalListClaim">(),
  openConflict: createSafeId<"legalListClaim">(),
  offList: createSafeId<"legalListClaim">(),
};

beforeAll(async () => {
  testDb = await getTestDb();
  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx.insert(organization).values({
      id: organizationId,
      name: "Qualifier firm",
      slug: `qualifiers-${Bun.randomUUIDv7()}`,
      createdAt: new Date("2026-11-01T09:00:00Z"),
    });
    await tx.insert(user).values({
      id: userId,
      name: "Qualifier Reviewer",
      email: `${userId}@example.test`,
    });
    await tx.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Qualifier matter",
      reference: Bun.randomUUIDv7().slice(0, 8),
    });
    await tx.insert(legalLists).values({
      id: listId,
      workspaceId,
      name: "Chronology",
      status: "active",
      createdBy: userId,
    });
    const onList = [
      { id: bankRecord, name: "Transfer of £40,000", position: "a" },
      { id: diaryNote, name: "Diary: call with J. Harrow", position: "b" },
      { id: leaveCalendar, name: "Leave 2–20 August 2021", position: "c" },
      { id: marginNote, name: "Margin note: approx £40k", position: "d" },
    ];
    await tx.insert(entities).values([
      ...onList.map((fact) => ({
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
        id: documentId,
        workspaceId,
        kind: "document" as const,
        name: "Email bundle.pdf",
        createdBy: userId,
      },
      {
        id: statementId,
        workspaceId,
        kind: "document" as const,
        name: "Witness statement.docx",
        createdBy: userId,
      },
      {
        id: ledgerId,
        workspaceId,
        kind: "document" as const,
        name: "Ledger.xlsx",
        createdBy: userId,
      },
    ]);
    await tx.insert(entityVersions).values([
      { id: documentVersionId, workspaceId, entityId: documentId },
      { id: ledgerVersionId, workspaceId, entityId: ledgerId },
    ]);
    await tx.insert(legalListItems).values(
      onList.map((fact) => ({
        entityId: fact.id,
        workspaceId,
        listId,
        position: fact.position,
        addedBy: userId,
      })),
    );
    const itemSource = (itemEntityId: SafeId<"entity">) => ({
      id: createSafeId<"legalListItemSource">(),
      workspaceId,
      listId,
      itemEntityId,
      sourceEntityId: documentId,
      sourceEntityVersionId: documentVersionId,
      locator: { type: "document" as const },
      quote: null,
      createdBy: userId,
    });
    await tx
      .insert(legalListItemSources)
      .values([
        itemSource(bankRecord),
        { ...itemSource(diaryNote), verificationStatus: "rejected" as const },
      ]);

    await tx.insert(legalListVerificationRuns).values({
      id: runId,
      organizationId,
      workspaceId,
      entityId: statementId,
      fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
      entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
      contentSha256: "c".repeat(64),
      evidence: {
        listId,
        facts: [
          pinned(bankRecord, "Transfer of £40,000", [source]),
          pinned(diaryNote, "Diary: call with J. Harrow", []),
          pinned(leaveCalendar, "Leave 2–20 August 2021", []),
          pinned(marginNote, "Margin note: approx £40k", []),
          pinned(removedEmail, "Email: payment approved", [source]),
        ],
      },
      status: "completed",
    });
    const claim = (
      id: SafeId<"legalListClaim">,
      position: number,
      values: Pick<
        typeof legalListClaims.$inferInsert,
        "state" | "score" | "refs" | "recordConflict" | "qualifiers"
      >,
    ): typeof legalListClaims.$inferInsert => ({
      id,
      workspaceId,
      runId,
      position,
      type: "fact",
      text: `Claim ${String(position)}`,
      anchor: { type: "docx-block", blockId: "p1", start: 0, end: 5 },
      ...values,
    });
    const conflict = {
      subject: "The amount",
      factEntityIds: [bankRecord, marginNote],
      values: ["£40,000", "approx £40k"],
      governingStates: ["supported", "tension"],
    } as const;
    await tx.insert(legalListClaims).values([
      claim(claimIds.sourcedSupport, 0, {
        state: "supported",
        score: 90,
        refs: [
          { factEntityId: bankRecord, rel: "supports" },
          { factEntityId: diaryNote, rel: "record" },
        ],
      }),
      claim(claimIds.unsourcedSupport, 1, {
        state: "supported",
        score: 80,
        refs: [{ factEntityId: diaryNote, rel: "supports" }],
      }),
      claim(claimIds.silent, 2, {
        state: "nocover",
        score: null,
        refs: [],
        qualifiers: [
          {
            kind: "record-silent",
            explanation: "The witness's own expectation.",
          },
        ],
      }),
      claim(claimIds.widened, 3, {
        state: "tension",
        score: 45,
        refs: [{ factEntityId: leaveCalendar, rel: "conflicts" }],
        qualifiers: [
          {
            kind: "scope-mismatch",
            explanation: "The leave covers part of August only.",
          },
        ],
      }),
      claim(claimIds.governedByHeld, 4, {
        state: "recordconflict",
        score: null,
        refs: [],
        recordConflict: conflict,
      }),
      claim(claimIds.openConflict, 5, {
        state: "recordconflict",
        score: null,
        refs: [],
        recordConflict: conflict,
      }),
      claim(claimIds.offList, 6, {
        state: "supported",
        score: 85,
        refs: [{ factEntityId: removedEmail, rel: "supports" }],
      }),
    ]);
    await tx.insert(legalListClaimReviewEvents).values({
      id: createSafeId<"legalListClaimReviewEvent">(),
      workspaceId,
      runId,
      claimId: claimIds.governedByHeld,
      kind: "record-conflict",
      payload: {
        kind: "record-conflict",
        resolution: { kind: "governed", factEntityId: marginNote },
        reason: "The margin note is the later record.",
      },
      actorId: userId,
    });
  });
});

afterAll(async () => {
  await deleteOrganizationsForTest(testDb, [organizationId]);
  await releaseTestDb();
});

const readRun = async () => {
  const run = await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    return await readVerificationRun({
      tx: asTestRaw<Transaction>(tx),
      workspaceId,
      runId,
    });
  });
  if (run === null) {
    throw new Error("The seeded run is not readable");
  }
  return run;
};

const readQualifiers = async () =>
  new Map(
    (await readRun()).claims.map((claim) => [
      claim.id,
      claim.qualifiers.map(({ kind }) => kind),
    ]),
  );

test("qualifiers follow the facts as they stand when the run is read", async () => {
  const before = await readQualifiers();
  expect(Object.fromEntries(before)).toEqual({
    [claimIds.sourcedSupport]: [],
    // A rejected source does not say where a fact comes from.
    [claimIds.unsourcedSupport]: ["unsourced-only"],
    [claimIds.silent]: ["record-silent"],
    [claimIds.widened]: ["scope-mismatch", "unsourced-only"],
    [claimIds.governedByHeld]: ["unsourced-only"],
    // An open conflict rests on neither record yet.
    [claimIds.openConflict]: [],
    [claimIds.offList]: [],
  });

  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx.insert(legalListItemSources).values({
      id: createSafeId<"legalListItemSource">(),
      workspaceId,
      listId,
      itemEntityId: leaveCalendar,
      sourceEntityId: documentId,
      sourceEntityVersionId: documentVersionId,
      locator: { type: "document" },
      quote: null,
      createdBy: userId,
    });
    await tx.insert(legalListFactDetails).values({
      itemEntityId: marginNote,
      workspaceId,
      listId,
      confidence: "low",
      scoring: "held",
    });
  });

  const after = await readQualifiers();
  expect(after.get(claimIds.widened)).toEqual(["scope-mismatch"]);
  expect(after.get(claimIds.governedByHeld)).toEqual([
    "unsourced-only",
    "rests-on-held",
  ]);
  expect(after.get(claimIds.sourcedSupport)).toEqual([]);

  // The stored row keeps only what the grader gave.
  const stored = await testDb
    .select({ qualifiers: legalListClaims.qualifiers })
    .from(legalListClaims)
    .where(eq(legalListClaims.id, claimIds.governedByHeld));
  expect(stored).toEqual([{ qualifiers: [] }]);

  // The read reports the footing it computed them from, for every pinned
  // fact, so a reader shows what the qualifiers state.
  const standings = new Map(
    (await readRun()).factStandings.map(({ factEntityId, ...standing }) => [
      factEntityId,
      standing,
    ]),
  );
  expect(Object.fromEntries(standings)).toEqual({
    [bankRecord]: { scoring: "included", tier: "document" },
    [diaryNote]: { scoring: "included", tier: "unsourced" },
    [leaveCalendar]: { scoring: "included", tier: "document" },
    [marginNote]: { scoring: "held", tier: "unsourced" },
    [removedEmail]: { scoring: "included", tier: "document" },
  });

  // Bulk accept reads the same footing: a verdict now resting on a held fact
  // is not routine, one resting only on unsourced facts still is. The run
  // read serves that same answer on each claim, so the routine claims the
  // browser offers are the ones bulk accept takes.
  const routine = await testDb.transaction(
    async (tx: TestDatabaseTransaction) => {
      await tx.execute(sql.raw("RESET ROLE"));
      const raw = asTestRaw<Transaction>(tx);
      const inputs = await readRunAttentionInputs({
        tx: raw,
        workspaceId,
        runId,
      });
      if (inputs === null) {
        throw new Error("The seeded run is not readable");
      }
      const rows = await readClaimsForBulkReview({
        tx: raw,
        workspaceId,
        runId,
        claimIds: [claimIds.governedByHeld, claimIds.unsourcedSupport],
      });
      const reviews = await readClaimReviews({ tx: raw, workspaceId, runId });
      return Object.fromEntries(
        rows.map((claim) => [
          claim.id,
          claimNeedsAttention(
            claim,
            reviews.get(claim.id)?.review ?? null,
            inputs,
          ),
        ]),
      );
    },
  );
  expect(routine).toEqual({
    [claimIds.governedByHeld]: true,
    [claimIds.unsourcedSupport]: false,
  });
  const served = (await readRun()).claims.filter(
    (claim) =>
      claim.id === claimIds.governedByHeld ||
      claim.id === claimIds.unsourcedSupport,
  );
  expect(
    Object.fromEntries(served.map((claim) => [claim.id, claim.needsAttention])),
  ).toEqual(routine);
});

test("a document marked as testimony moves every fact citing it, and the record is suggested over the account", async () => {
  const read = async () => {
    const run = await readRun();
    return {
      tiers: new Map(
        run.factStandings.map(({ factEntityId, tier }) => [factEntityId, tier]),
      ),
      claims: new Map(run.claims.map((claim) => [claim.id, claim])),
    };
  };
  const before = await read();
  // Both conflicting facts are unsourced or document records: nothing in
  // their sources says which should govern.
  expect(
    before.claims.get(claimIds.openConflict)?.suggestedGoverningFactId,
  ).toBeNull();

  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx.insert(legalListSourceDocuments).values({
      workspaceId,
      listId,
      documentEntityId: documentId,
      sourceKind: "testimony",
      updatedBy: userId,
    });
    // The held margin note gains a source in a record never marked.
    await tx.insert(legalListItemSources).values({
      id: createSafeId<"legalListItemSource">(),
      workspaceId,
      listId,
      itemEntityId: marginNote,
      sourceEntityId: ledgerId,
      sourceEntityVersionId: ledgerVersionId,
      locator: { type: "document" },
      quote: null,
      createdBy: userId,
    });
  });

  const after = await read();
  expect(Object.fromEntries(after.tiers)).toEqual({
    [bankRecord]: "testimony",
    // Its only source is rejected, so the kind of that document is moot.
    [diaryNote]: "unsourced",
    [leaveCalendar]: "testimony",
    [marginNote]: "document",
    // Off the list: read from the sources the run pinned.
    [removedEmail]: "testimony",
  });
  const kindsOf = (claimId: SafeId<"legalListClaim">) =>
    after.claims.get(claimId)?.qualifiers.map(({ kind }) => kind);
  expect(kindsOf(claimIds.offList)).toEqual(["testimony-only"]);
  expect(kindsOf(claimIds.widened)).toEqual([
    "scope-mismatch",
    "testimony-only",
  ]);
  // It rests on testimony alone: the unsourced fact beside it is cited only
  // as context, so no record backs it.
  expect(kindsOf(claimIds.sourcedSupport)).toEqual(["testimony-only"]);
  // The ledger's record is suggested over the testimony-backed transfer,
  // and the conflict stays open until someone chooses.
  const open = after.claims.get(claimIds.openConflict);
  expect(open?.suggestedGoverningFactId).toBe(marginNote);
  expect(open?.review).toBeNull();
  expect(open?.verdict.state).toBe("recordconflict");
  expect(
    after.claims.get(claimIds.sourcedSupport)?.suggestedGoverningFactId,
  ).toBeNull();
});
