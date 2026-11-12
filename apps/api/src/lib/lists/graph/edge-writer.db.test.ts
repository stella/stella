// The STELLA_RUN_POSTGRES_TESTS runner also executes this suite.
/**
 * The graph's edges are derived from the rows that already hold each link,
 * written once per identity, never changed, and the backfill derives exactly
 * the edges the live writers would have for rows written before them.
 */

import { panic } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { asc, eq, getTableName, sql } from "drizzle-orm";
import fc from "fast-check";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";
import type { ReviewDecision } from "@stll/api-contract/review-decision";
import { assertProperty } from "@stll/property-testing";
import { createTestState } from "@stll/test-state";

import { member, organization, user } from "@/api/db/auth-schema";
import type { OnlineMigrationConnection } from "@/api/db/online-migration-connection";
import type { Transaction } from "@/api/db/root";
import {
  entities,
  entityVersions,
  legalGraphEdges,
  legalListClaimReviewEvents,
  legalListClaims,
  legalListItems,
  legalListItemSourceDecisions,
  legalListItemSources,
  legalLists,
  legalListVerificationRuns,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { graphEdgeDecisionOf } from "@/api/lib/lists/graph/contract";
import { GRAPH_EDGES_TABLE } from "@/api/lib/lists/graph/edge-insert";
import { writeGraphEdges } from "@/api/lib/lists/graph/edge-writer";
import type { GraphEdgeWrite } from "@/api/lib/lists/graph/edge-writer";
import { writeFactSourceEdges } from "@/api/lib/lists/graph/fact-source-edges";
import type { FactSourceEdgeWrite } from "@/api/lib/lists/graph/fact-source-edges";
import type {
  ClaimRef,
  ClaimReviewEventPayload,
} from "@/api/lib/lists/verification/contract";
import { completeVerificationRun } from "@/api/lib/lists/verification/run-persistence";
import { organizationFeatureGrants } from "@/api/tests/helpers/feature-grants";
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

import {
  createLegalGraphEdgeBackfill,
  GRAPH_EDGE_ROLLOUT_GRACE_MS,
} from "../../../db/legal-graph-edge-backfill";

type EntityId = SafeId<"entity">;
type SourceId = SafeId<"legalListItemSource">;
type ClaimId = SafeId<"legalListClaim">;
type RunId = SafeId<"legalListVerificationRun">;
type EventId = SafeId<"legalListClaimReviewEvent">;

const FIXTURE_TIME = new Date("2026-11-01T09:00:00Z");
let testDb: TestDatabase;
const testState = createTestState({ file: import.meta.path, config: env });
const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
const userId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);

/** One matter's verification history, written without the graph writers so
 *  the tests decide which writer or backfill derives its edges. */
type Matter = {
  workspaceId: SafeId<"workspace">;
  facts: readonly [EntityId, EntityId];
  /** A list item that is not a fact: its Spot is no graph edge. */
  taskId: EntityId;
  documentId: EntityId;
  sources: readonly [SourceId, SourceId, SourceId];
  runId: RunId;
  claims: readonly { id: ClaimId; refs: ClaimRef[] }[];
  recheckId: EventId;
  recheckRefs: ClaimRef[];
};

const root = async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    return await fn(asTestRaw<Transaction>(tx));
  });

const scoped = async <T>(
  workspaceId: SafeId<"workspace">,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  await createScopedQuery(testDb)(
    [workspaceId],
    organizationId,
    async (tx) => await fn(asTestRaw<Transaction>(tx)),
    userId,
  );

type TaskOptions = {
  workspaceId: SafeId<"workspace">;
  id: EntityId;
  name: string;
  listItemType: (typeof LIST_ITEM_TYPE)[keyof typeof LIST_ITEM_TYPE];
};

const task = ({ workspaceId, id, name, listItemType }: TaskOptions) => ({
  id,
  workspaceId,
  kind: "task" as const,
  listItemType,
  name,
  createdBy: userId,
  agendaKind: "task" as const,
  status: "open" as const,
  priority: "none" as const,
  agendaSource: "manual" as const,
});

const seedMatter = async (): Promise<Matter> => {
  const workspaceId = createSafeId<"workspace">();
  const listId = createSafeId<"legalList">();
  const facts = [createSafeId<"entity">(), createSafeId<"entity">()] as const;
  const removedFactId = createSafeId<"entity">();
  const taskId = createSafeId<"entity">();
  const documentId = createSafeId<"entity">();
  const versionId = createSafeId<"entityVersion">();
  const sources = [
    createSafeId<"legalListItemSource">(),
    createSafeId<"legalListItemSource">(),
    createSafeId<"legalListItemSource">(),
  ] as const;
  const runId = createSafeId<"legalListVerificationRun">();
  const claims = [
    {
      id: createSafeId<"legalListClaim">(),
      refs: [
        { factEntityId: facts[0], rel: "supports" },
        { factEntityId: facts[1], rel: "conflicts" },
        // A fact taken off the record after the run pinned it.
        { factEntityId: removedFactId, rel: "record" },
      ],
    },
    {
      id: createSafeId<"legalListClaim">(),
      refs: [{ factEntityId: facts[1], rel: "record" }],
    },
    { id: createSafeId<"legalListClaim">(), refs: [] },
  ] satisfies { id: ClaimId; refs: ClaimRef[] }[];
  const firstClaim = claims.at(0) ?? panic("first claim");
  const recheckId = createSafeId<"legalListClaimReviewEvent">();
  const recheckRefs: ClaimRef[] = [{ factEntityId: facts[1], rel: "supports" }];
  await root(async (tx) => {
    await tx.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Graph matter",
      reference: Bun.randomUUIDv7().slice(-8),
    });
    await tx.insert(legalLists).values({
      id: listId,
      workspaceId,
      name: "Chronology",
      createdBy: userId,
    });
    await tx.insert(entities).values([
      task({
        workspaceId,
        id: facts[0],
        name: "Contract signed",
        listItemType: LIST_ITEM_TYPE.FACT,
      }),
      task({
        workspaceId,
        id: facts[1],
        name: "Goods delivered late",
        listItemType: LIST_ITEM_TYPE.FACT,
      }),
      task({
        workspaceId,
        id: taskId,
        name: "Ask for the invoice",
        listItemType: LIST_ITEM_TYPE.TASK,
      }),
      {
        id: documentId,
        workspaceId,
        kind: "document" as const,
        name: "Minutes.docx",
        createdBy: userId,
      },
    ]);
    await tx
      .insert(entityVersions)
      .values({ id: versionId, workspaceId, entityId: documentId });
    await tx.insert(legalListItems).values(
      [facts[0], facts[1], taskId].map((entityId, index) => ({
        entityId,
        workspaceId,
        listId,
        position: String.fromCodePoint(97 + index),
        addedBy: userId,
      })),
    );
    await tx.insert(legalListItemSources).values(
      (
        [
          [sources[0], facts[0], "The contract was signed on 3 May."],
          [sources[1], facts[1], "Delivery arrived on 9 June."],
          [sources[2], taskId, "Invoice to follow."],
        ] as const
      ).map(([id, itemEntityId, quote], index) => ({
        id,
        workspaceId,
        listId,
        itemEntityId,
        sourceEntityId: documentId,
        sourceEntityVersionId: versionId,
        locator: { type: "docx-block" as const, blockId: `p${index}` },
        quote,
        createdBy: userId,
      })),
    );
    await tx.insert(legalListVerificationRuns).values({
      id: runId,
      organizationId,
      workspaceId,
      entityId: documentId,
      fileFieldId: createSafeId<"field">(),
      entityVersionId: versionId,
      contentSha256: "a".repeat(64),
      evidence: { listId, facts: [] },
      status: "completed",
      pipelineVersion: 3,
    });
    await tx.insert(legalListClaims).values(
      claims.map((claim, position) => ({
        id: claim.id,
        runId,
        workspaceId,
        position,
        type: "fact" as const,
        state:
          claim.refs.length === 0 ? ("nocover" as const) : ("tension" as const),
        score: claim.refs.length === 0 ? null : 50,
        text: `Claim ${String(position)}`,
        anchor: {
          type: "docx-block" as const,
          blockId: "p0",
          start: 0,
          end: 5,
        },
        refs: claim.refs,
      })),
    );
    const payload = {
      kind: "recheck",
      requestKey: Bun.randomUUIDv7(),
      grade: {
        state: "supported",
        score: 90,
        recordConflict: null,
        refs: recheckRefs,
        qualifiers: [],
      },
      facts: { changed: [], removed: [] },
      modelRef: null,
    } satisfies ClaimReviewEventPayload;
    await tx.insert(legalListClaimReviewEvents).values({
      id: recheckId,
      workspaceId,
      runId,
      claimId: firstClaim.id,
      kind: payload.kind,
      payload,
      actorId: userId,
    });
  });
  return {
    workspaceId,
    facts,
    taskId,
    documentId,
    sources,
    runId,
    claims,
    recheckId,
    recheckRefs,
  };
};

/** An edge as its identity and content, without the generated id. */
const identityOf = (edge: typeof legalGraphEdges.$inferSelect) =>
  [
    edge.kind,
    edge.fromKind,
    edge.fromClaimId ?? edge.fromEntityId,
    edge.toKind,
    edge.toEntityId,
    edge.stance,
    edge.sourceId ?? edge.provenanceReason,
    edge.producerKind,
    edge.producerId,
  ].join("|");

/** The edges every writer of a matter derives, computed from the seed rows
 *  rather than by the SQL under test. */
const expectedEdges = (matter: Matter): string[] => {
  const live = new Set<string>(matter.facts);
  const runEdges = matter.claims.flatMap((claim) =>
    claim.refs
      .filter((ref) => live.has(ref.factEntityId))
      .map((ref) =>
        [
          "cites",
          "claim",
          claim.id,
          "fact",
          ref.factEntityId,
          ref.rel,
          "claim-anchor",
          "run",
          matter.runId,
        ].join("|"),
      ),
  );
  const recheckEdges = matter.recheckRefs
    .filter((ref) => live.has(ref.factEntityId))
    .map((ref) =>
      [
        "cites",
        "claim",
        matter.claims.at(0)?.id ?? panic("first claim"),
        "fact",
        ref.factEntityId,
        ref.rel,
        "claim-anchor",
        "recheck",
        matter.recheckId,
      ].join("|"),
    );
  // Only fact items are facts; the task's Spot is no edge.
  const sourceEdges = matter.facts.map((factId, index) => {
    const sourceId = matter.sources[index] ?? panic("source per fact");
    return [
      "sourced-from",
      "fact",
      factId,
      "document",
      matter.documentId,
      "",
      sourceId,
      "reviewer",
      sourceId,
    ].join("|");
  });
  return [...runEdges, ...recheckEdges, ...sourceEdges].toSorted();
};

/** The producers each of `writesOf`'s writes names, in the same order. */
const PRODUCER_OF_WRITE = [
  ["run", "recheck"],
  ["recheck"],
  ["reviewer"],
] as const;

type AnyWrite = GraphEdgeWrite | FactSourceEdgeWrite;

/** Each write through the writer that owns it. */
const applyWrite = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
  write: AnyWrite,
): Promise<number> =>
  write.type === "run" || write.type === "recheck"
    ? await writeGraphEdges(tx, workspaceId, write)
    : await writeFactSourceEdges(tx, workspaceId, write);

const writesOf = (matter: Matter): AnyWrite[] => [
  { type: "run", runId: matter.runId },
  { type: "recheck", eventId: matter.recheckId },
  {
    type: "fact-sources",
    sourceIds: matter.sources,
    producer: { type: "reviewer" },
  },
];

const readEdges = async (
  workspaceId: SafeId<"workspace">,
  tx?: Transaction,
): Promise<(typeof legalGraphEdges.$inferSelect)[]> => {
  const read = async (reader: Transaction) =>
    await reader
      .select()
      .from(legalGraphEdges)
      .where(eq(legalGraphEdges.workspaceId, workspaceId))
      .orderBy(asc(legalGraphEdges.id));
  return tx === undefined ? await root(read) : await read(tx);
};

testState.beforeAll(async () => {
  testState.setConfig("FEATURE_LEGAL_LISTS", true);
  testState.setConfig(
    "API_FEATURE_ACCESS_GRANTS",
    organizationFeatureGrants(organizationId, [
      LEGAL_LISTS_FEATURE_ID,
      LIST_VERIFICATION_FEATURE_ID,
    ]),
  );
  testDb = await getTestDb();
  await root(async (tx) => {
    await tx.insert(organization).values({
      id: organizationId,
      name: "Graph firm",
      slug: `graph-${Bun.randomUUIDv7()}`,
      createdAt: FIXTURE_TIME,
    });
    await tx.insert(user).values({
      id: userId,
      name: "Graph Reviewer",
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    // Feature access reads the reviewer's membership.
    await tx.insert(member).values({
      id: `member_${Bun.randomUUIDv7()}`,
      organizationId,
      userId,
      role: "owner",
      createdAt: FIXTURE_TIME,
    });
  });
});

afterAll(async () => {
  await deleteOrganizationsForTest(testDb, [organizationId]);
  await releaseTestDb();
});

describe("graph edge writers", () => {
  test("the writers insert into the schema's edge table", () => {
    expect(GRAPH_EDGES_TABLE).toBe(getTableName(legalGraphEdges));
  });

  test("each producer writes one edge per live link it holds, and a replay writes none", async () => {
    const matter = await seedMatter();
    const counts = [];
    for (const write of writesOf(matter)) {
      counts.push(
        await scoped(
          matter.workspaceId,
          async (tx) => await applyWrite(tx, matter.workspaceId, write),
        ),
      );
    }
    // The run: three live citations of its claims and the one its re-check
    // holds (a re-check on its claims is written with it); the re-check
    // again: nothing new; two fact Spots of three item Spots.
    expect(counts).toEqual([4, 0, 2]);
    const first = await readEdges(matter.workspaceId);
    expect(first.map(identityOf).toSorted()).toEqual(expectedEdges(matter));
    // Edges inherit the list feature gate from what they link.
    expect(new Set(first.map((edge) => edge.entityFeatureGate))).toEqual(
      new Set(["legal-lists"]),
    );

    for (const write of writesOf(matter)) {
      expect(
        await scoped(
          matter.workspaceId,
          async (tx) => await applyWrite(tx, matter.workspaceId, write),
        ),
      ).toBe(0);
    }
    expect(await readEdges(matter.workspaceId)).toEqual(first);
  });

  test("completing a run writes its citations with the claims", async () => {
    const matter = await seedMatter();
    const runId = createSafeId<"legalListVerificationRun">();
    const claimId = createSafeId<"legalListClaim">();
    await root(async (tx) => {
      await tx.insert(legalListVerificationRuns).values({
        id: runId,
        organizationId,
        workspaceId: matter.workspaceId,
        entityId: matter.documentId,
        fileFieldId: createSafeId<"field">(),
        entityVersionId: createSafeId<"entityVersion">(),
        contentSha256: "b".repeat(64),
        evidence: { listId: createSafeId<"legalList">(), facts: [] },
        status: "running",
        pipelineVersion: 3,
      });
    });
    await scoped(matter.workspaceId, async (tx) => {
      await completeVerificationRun({
        tx,
        runId,
        workspaceId: matter.workspaceId,
        blocks: [
          {
            id: "p0",
            text: "Signed.",
            source: { type: "docx-block", blockId: "p0" },
          },
        ],
        claims: [
          {
            id: claimId,
            runId,
            workspaceId: matter.workspaceId,
            position: 0,
            type: "fact",
            state: "supported",
            score: 80,
            text: "Signed",
            anchor: { type: "docx-block", blockId: "p0", start: 0, end: 6 },
            refs: [{ factEntityId: matter.facts[0], rel: "supports" }],
          },
        ],
      });
    });
    const edges = (await readEdges(matter.workspaceId)).filter(
      (edge) => edge.producerId === runId,
    );
    expect(edges.map(identityOf)).toEqual([
      [
        "cites",
        "claim",
        claimId,
        "fact",
        matter.facts[0],
        "supports",
        "claim-anchor",
        "run",
        runId,
      ].join("|"),
    ]);
  });

  test("only facts are cited, and an item that becomes a fact brings its Spots", async () => {
    const matter = await seedMatter();
    const runId = createSafeId<"legalListVerificationRun">();
    const claimId = createSafeId<"legalListClaim">();
    await root(async (tx) => {
      await tx.insert(legalListVerificationRuns).values({
        id: runId,
        organizationId,
        workspaceId: matter.workspaceId,
        entityId: matter.documentId,
        fileFieldId: createSafeId<"field">(),
        entityVersionId: createSafeId<"entityVersion">(),
        contentSha256: "c".repeat(64),
        evidence: { listId: createSafeId<"legalList">(), facts: [] },
        status: "completed",
        pipelineVersion: 3,
      });
      // A claim whose grade cites the task: not a fact, so no node.
      await tx.insert(legalListClaims).values({
        id: claimId,
        runId,
        workspaceId: matter.workspaceId,
        position: 0,
        type: "fact",
        state: "tension",
        score: 40,
        text: "Invoice sent",
        anchor: { type: "docx-block", blockId: "p0", start: 0, end: 7 },
        refs: [{ factEntityId: matter.taskId, rel: "record" }],
      });
    });
    expect(
      await scoped(
        matter.workspaceId,
        async (tx) =>
          await writeGraphEdges(tx, matter.workspaceId, { type: "run", runId }),
      ),
    ).toBe(0);

    // The task becomes a fact: its Spot, added while it was a task, is now
    // the fact's source, credited to the reviewer who added it.
    await root(async (tx) => {
      await tx
        .update(entities)
        .set({ listItemType: LIST_ITEM_TYPE.FACT })
        .where(eq(entities.id, matter.taskId));
    });
    expect(
      await scoped(
        matter.workspaceId,
        async (tx) =>
          await writeFactSourceEdges(tx, matter.workspaceId, {
            type: "item-became-fact",
            itemEntityId: matter.taskId,
          }),
      ),
    ).toBe(1);
    const sourced = (await readEdges(matter.workspaceId)).filter(
      (edge) => edge.fromEntityId === matter.taskId,
    );
    expect(sourced.map(identityOf)).toEqual([
      [
        "sourced-from",
        "fact",
        matter.taskId,
        "document",
        matter.documentId,
        "",
        matter.sources[2],
        "reviewer",
        matter.sources[2],
      ].join("|"),
    ]);
  });

  test("another matter neither reads nor writes a matter's edges", async () => {
    const matter = await seedMatter();
    const other = await seedMatter();
    await scoped(
      matter.workspaceId,
      async (tx) =>
        await writeGraphEdges(tx, matter.workspaceId, {
          type: "run",
          runId: matter.runId,
        }),
    );
    expect(
      await scoped(
        other.workspaceId,
        async (tx) =>
          await tx
            .select({ id: legalGraphEdges.id })
            .from(legalGraphEdges)
            .where(eq(legalGraphEdges.workspaceId, matter.workspaceId)),
      ),
    ).toEqual([]);
    // Scoped to the other matter, a write naming this one derives nothing:
    // its claims are invisible there.
    expect(
      await scoped(
        other.workspaceId,
        async (tx) =>
          await writeGraphEdges(tx, matter.workspaceId, {
            type: "run",
            runId: matter.runId,
          }),
      ),
    ).toBe(0);
    // And a row naming this matter is refused outright.
    const refusal = await scoped(other.workspaceId, async (tx) => {
      try {
        await tx.execute(sql`SAVEPOINT cross_matter`);
        await tx.insert(legalGraphEdges).values({
          workspaceId: matter.workspaceId,
          kind: "sourced-from",
          fromKind: "fact",
          fromEntityId: matter.facts[0],
          toKind: "document",
          toEntityId: matter.documentId,
          sourceId: matter.sources[0],
          producerKind: "reviewer",
          producerId: matter.sources[0],
        });
        return "written";
      } catch {
        await tx.execute(sql`ROLLBACK TO SAVEPOINT cross_matter`);
        return "refused";
      }
    });
    expect(refusal).toBe("refused");
  });
});

describe("graph edge backfill", () => {
  const connectionOf = (): OnlineMigrationConnection => ({
    query: async (statement, parameters = []) =>
      (await testDb.$client.query(statement, [...parameters])).rows,
    execute: async (statement, parameters = []) => {
      await testDb.$client.query(statement, [...parameters]);
    },
    release: () => {},
  });

  test("derives every edge the writers would, loses none, and converges on replay", async () => {
    const backfilled = await seedMatter();
    // A matter whose run a live writer already covered: the backfill must
    // not write its edges again.
    const live = await seedMatter();
    await scoped(
      live.workspaceId,
      async (tx) =>
        await writeGraphEdges(tx, live.workspaceId, {
          type: "run",
          runId: live.runId,
        }),
    );
    const liveRunEdges = await readEdges(live.workspaceId);

    // The migrate runs' clock: the first pass finishes at FIXTURE_TIME.
    let clock = FIXTURE_TIME.getTime();
    const repair = createLegalGraphEdgeBackfill({ now: () => clock });
    await testDb.$client.query(
      "DELETE FROM public.database_backfill_states WHERE name = $1",
      [repair.name],
    );
    expect(await repair.readCompletion(connectionOf())).toMatchObject({
      type: "incomplete",
    });
    expect(await repair.repair(connectionOf())).toEqual({ type: "complete" });
    // The first pass waits for the walk after the writers' rollout.
    expect(await repair.readCompletion(connectionOf())).toMatchObject({
      type: "pending",
      cursor: `1:done@${new Date(clock).toISOString()}`,
    });
    // A task of the previous release writes a matter's rows without edges
    // during the rollout. A second migrate run within the rollout leaves the
    // repair pending; once the grace has passed, the second pass derives them.
    const duringRollout = await seedMatter();
    clock += GRAPH_EDGE_ROLLOUT_GRACE_MS - 1;
    expect(await repair.repair(connectionOf())).toEqual({ type: "complete" });
    expect(await repair.readCompletion(connectionOf())).toMatchObject({
      type: "pending",
    });
    expect(await readEdges(duringRollout.workspaceId)).toEqual([]);
    clock += 1;
    expect(await repair.repair(connectionOf())).toEqual({ type: "complete" });
    expect(await repair.readCompletion(connectionOf())).toEqual({
      type: "complete",
    });

    // Zero loss: exactly the derivable links, counted from the seed rows.
    for (const matter of [backfilled, live, duringRollout]) {
      const derived = expectedEdges(matter);
      const written = (await readEdges(matter.workspaceId)).map(identityOf);
      expect(written.length).toBe(derived.length);
      expect(written.toSorted()).toEqual(derived);
    }
    // The live writer's rows are the ones kept.
    const afterBackfill = await readEdges(live.workspaceId);
    for (const edge of liveRunEdges) {
      expect(afterBackfill).toContainEqual(edge);
    }

    // Walking again from scratch writes nothing new and changes nothing.
    const before = await readEdges(backfilled.workspaceId);
    await testDb.$client.query(
      "DELETE FROM public.database_backfill_states WHERE name = $1",
      [repair.name],
    );
    expect(await repair.repair(connectionOf())).toEqual({ type: "complete" });
    expect(await readEdges(backfilled.workspaceId)).toEqual(before);
  });
});

describe("graph edge decisions", () => {
  type Step =
    | { type: "write"; write: number }
    | { type: "decide"; decision: ReviewDecision | null };

  const step: fc.Arbitrary<Step> = fc.oneof(
    fc.record({
      type: fc.constant("write" as const),
      write: fc.nat({ max: 2 }),
    }),
    fc.record({
      type: fc.constant("decide" as const),
      decision: fc.constantFrom<ReviewDecision | null>(
        "accepted",
        "rejected",
        null,
      ),
    }),
  );

  test("writes in any order and number never change an edge, and the decision is the fold of the Spot's events", async () => {
    const matter = await seedMatter();
    const writes = writesOf(matter);
    await assertProperty(
      "writes in any order and number never change an edge, and the decision is the fold of the Spot's events",
      fc.asyncProperty(
        fc.array(step, { minLength: 1, maxLength: 8 }),
        async (steps) => {
          await scoped(matter.workspaceId, async (tx) => {
            await tx.execute(sql`SAVEPOINT property_case`);
            const firstSeen = new Map<
              string,
              typeof legalGraphEdges.$inferSelect
            >();
            const applied = new Set<number>();
            const decisions: { decision: ReviewDecision | null; at: Date }[] =
              [];
            for (const [index, current] of steps.entries()) {
              if (current.type === "write") {
                const write = writes[current.write] ?? panic("write index");
                await applyWrite(tx, matter.workspaceId, write);
                applied.add(current.write);
              } else {
                const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
                await tx.insert(legalListItemSourceDecisions).values({
                  workspaceId: matter.workspaceId,
                  sourceId: matter.sources[0],
                  decision: current.decision,
                  actorId: userId,
                  createdAt: at,
                });
                decisions.push({ decision: current.decision, at });
              }
              for (const edge of await readEdges(matter.workspaceId, tx)) {
                const seen = firstSeen.get(edge.id);
                if (seen === undefined) {
                  firstSeen.set(edge.id, edge);
                } else {
                  // Never overwritten: the row reads as it was first written.
                  expect(edge).toEqual(seen);
                }
              }
            }
            const all = expectedEdges(matter);
            const producersApplied: readonly string[] = [...applied].flatMap(
              (write) => PRODUCER_OF_WRITE.at(write) ?? panic("write index"),
            );
            const edges = await readEdges(matter.workspaceId, tx);
            expect(edges.map(identityOf).toSorted()).toEqual(
              all.filter((identity) =>
                producersApplied.some(
                  (producer) => identity.split("|")[7] === producer,
                ),
              ),
            );
            // The Spot edge's decision is its Spot's stored history folded:
            // the latest decision, or proposed while none stands. Writing the
            // edge again never resets it, since the edge holds no decision.
            const history = await tx
              .select({
                decision: legalListItemSourceDecisions.decision,
                reason: legalListItemSourceDecisions.reason,
                actorId: legalListItemSourceDecisions.actorId,
                createdAt: legalListItemSourceDecisions.createdAt,
              })
              .from(legalListItemSourceDecisions)
              .where(
                eq(legalListItemSourceDecisions.sourceId, matter.sources[0]),
              )
              .orderBy(asc(legalListItemSourceDecisions.createdAt));
            expect(history).toHaveLength(decisions.length);
            expect(
              graphEdgeDecisionOf(
                history.map((event) => ({
                  ...event,
                  at: event.createdAt.toISOString(),
                })),
              ),
            ).toBe(decisions.at(-1)?.decision ?? "proposed");
            await tx.execute(sql`ROLLBACK TO SAVEPOINT property_case`);
          });
        },
      ),
      { numRuns: 25 },
    );
  });
});
