/**
 * Requeueing Slovak court decisions whose document was settled as empty.
 *
 * The fixture pairs each qualifying decision with ones that differ from it in
 * a single column (text present, still pending, no document address, an AST
 * with blocks, an attempt before the window), so a selection that loosens
 * or tightens any one condition fails here. A requeued decision must be one
 * the walk hands out again, and a second run must find nothing left to do.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawIndexJobs,
  caseLawSources,
} from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { SafeId } from "@/api/lib/branded-types";
import {
  loadPendingDocuments,
  MAX_DOCUMENT_FETCH_ATTEMPTS,
} from "@/api/lib/legal-search/sk-document-backfill";
import {
  requeueEmptiedDocuments,
  scanEmptiedDocuments,
} from "@/api/lib/legal-search/sk-emptied-document-repair";
import type { EmptiedDocumentRepairRow } from "@/api/lib/legal-search/sk-emptied-document-repair-command";
import { runEmptiedDocumentRepair } from "@/api/lib/legal-search/sk-emptied-document-repair-command";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (hours: number): Date =>
  new Date(Date.now() - hours * HOUR_MS);

/** The window starts two days back; "recent" attempts fall inside it. */
const SINCE = hoursAgo(48);

const BLOCK = {
  id: "b1",
  anchorId: "p1",
  type: "paragraph",
  inlines: [{ type: "text", text: "Text." }],
  plainText: "Text.",
};

type Seed = {
  label: string;
  fulltext: string | null;
  documentAst: unknown;
  documentUrl: string | null;
  attemptedAt: Date;
  qualifies: boolean;
};

const SEEDS: readonly Seed[] = [
  {
    label: "settled-empty",
    fulltext: "",
    documentAst: {},
    documentUrl: "https://example.test/settled-empty.pdf",
    attemptedAt: hoursAgo(6),
    qualifies: true,
  },
  {
    label: "settled-blank-unreadable-ast",
    fulltext: "  ",
    documentAst: { blocks: "broken" },
    documentUrl: "https://example.test/blank.pdf",
    attemptedAt: hoursAgo(6),
    qualifies: true,
  },
  {
    label: "settled-before-window",
    fulltext: "",
    documentAst: {},
    documentUrl: "https://example.test/old.pdf",
    attemptedAt: hoursAgo(24 * 30),
    qualifies: false,
  },
  {
    label: "has-text",
    fulltext: "Decision text.",
    documentAst: {},
    documentUrl: "https://example.test/text.pdf",
    attemptedAt: hoursAgo(6),
    qualifies: false,
  },
  {
    label: "still-pending",
    fulltext: null,
    documentAst: {},
    documentUrl: "https://example.test/pending.pdf",
    attemptedAt: hoursAgo(6),
    qualifies: false,
  },
  {
    label: "no-document-address",
    fulltext: "",
    documentAst: {},
    documentUrl: null,
    attemptedAt: hoursAgo(6),
    qualifies: false,
  },
  {
    label: "ast-with-blocks",
    fulltext: "",
    documentAst: { version: 1, blocks: [BLOCK] },
    documentUrl: "https://example.test/ast.pdf",
    attemptedAt: hoursAgo(6),
    qualifies: false,
  },
];

let testDb: TestDatabase;
let scopedDb: ScopedDb;
let sourceId: SafeId<"caseLawSource">;
let sourceOwnership: "created" | "borrowed" = "borrowed";
const seeded = new Map<string, SafeId<"caseLawDecision">>();
const suffix = Bun.randomUUIDv7().slice(0, 8);

const idFor = (label: string): SafeId<"caseLawDecision"> => {
  const id = seeded.get(label);
  if (id === undefined) {
    throw new Error(`fixture did not seed ${label}`);
  }
  return id;
};

const ours = (ids: readonly SafeId<"caseLawDecision">[]) => {
  const seededIds = new Set(seeded.values());
  return ids.filter((id) => seededIds.has(id)).toSorted();
};

const qualifying = () =>
  SEEDS.filter(({ qualifies }) => qualifies)
    .map(({ label }) => idFor(label))
    .toSorted();

const scanAll = async () =>
  await scanEmptiedDocuments({
    scopedDb,
    sourceId,
    since: SINCE,
    after: null,
    scan: 50_000,
  });

beforeAll(async () => {
  testDb = await getTestDb();
  scopedDb = asTestRaw<ScopedDb>(
    async (callback: (tx: TestDatabase) => Promise<unknown>) =>
      await testDb.transaction(
        async (tx) => await callback(asTestRaw<TestDatabase>(tx)),
      ),
  );
  const existing = await testDb.query.caseLawSources.findFirst({
    where: { adapterKey: { eq: ADAPTER_KEYS.SK_COURTS } },
    columns: { id: true },
  });
  if (existing) {
    sourceId = existing.id;
  } else {
    const [source] = await testDb
      .insert(caseLawSources)
      .values({
        adapterKey: ADAPTER_KEYS.SK_COURTS,
        name: `SK emptied documents ${suffix}`,
        enabled: false,
      })
      .returning({ id: caseLawSources.id });
    if (!source) {
      throw new Error("expected source row");
    }
    sourceId = source.id;
    sourceOwnership = "created";
  }

  for (const seed of SEEDS) {
    const [row] = await testDb
      .insert(caseLawDecisions)
      .values({
        sourceId,
        caseNumber: `emptied-${suffix}-${seed.label}`,
        court: "Krajský súd",
        country: "SVK",
        language: "sk",
        fulltext: seed.fulltext,
        documentAst: sql`${JSON.stringify(seed.documentAst)}::text::jsonb`,
        documentUrl: seed.documentUrl,
        decisionDate: "2026-05-01",
        documentFetchAttempts: MAX_DOCUMENT_FETCH_ATTEMPTS - 1,
        documentFetchAttemptedAt: seed.attemptedAt,
      })
      .returning({ id: caseLawDecisions.id });
    if (!row) {
      throw new Error("expected decision row");
    }
    seeded.set(seed.label, row.id);
  }
});

afterAll(async () => {
  await testDb
    .delete(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, [...seeded.values()]));
  if (sourceOwnership === "created") {
    await testDb.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
  }
  await releaseTestDb();
});

test("the scan selects exactly the decisions settled empty inside the window", async () => {
  expect(ours((await scanAll()).matched)).toEqual(qualifying());
});

test("a scan visits at most its bound and names where the next one starts", async () => {
  const first = await scanEmptiedDocuments({
    scopedDb,
    sourceId,
    since: SINCE,
    after: null,
    scan: 1,
  });
  expect(first.visited).toBe(1);
  expect(first.lastVisitedId).not.toBeNull();
  const second = await scanEmptiedDocuments({
    scopedDb,
    sourceId,
    since: SINCE,
    after: first.lastVisitedId,
    scan: 1,
  });
  expect(second.lastVisitedId).not.toBe(first.lastVisitedId);
});

test("a dry run records what qualifies and writes nothing", async () => {
  const rows: EmptiedDocumentRepairRow[] = [];
  const run = await runEmptiedDocumentRepair(
    {
      since: SINCE,
      after: null,
      scan: 50_000,
      resultsOut: null,
      write: { type: "dry-run" },
    },
    {
      scopedDb,
      sourceId,
      record: async (row) => {
        rows.push(row);
        await Promise.resolve();
      },
      write: () => undefined,
    },
  );

  expect(run.unwrap().requeued).toBe(0);
  expect(ours(rows.map(({ id }) => id))).toEqual(qualifying());
  expect(rows.every(({ outcome }) => outcome === "eligible")).toBe(true);
  expect(ours((await scanAll()).matched)).toEqual(qualifying());
});

test("an applied run requeues each qualifying decision into the walk once", async () => {
  const rows: EmptiedDocumentRepairRow[] = [];
  const command = {
    since: SINCE,
    after: null,
    scan: 50_000,
    resultsOut: "/unused",
    write: {
      type: "apply",
      reason: "requeue for the fixed parser",
      actor: "test",
    },
  } as const;
  const options = {
    scopedDb,
    sourceId,
    record: async (row: EmptiedDocumentRepairRow) => {
      rows.push(row);
      await Promise.resolve();
    },
    write: () => undefined,
  };

  expect((await runEmptiedDocumentRepair(command, options)).isOk()).toBe(true);

  const requeued = qualifying();
  expect(
    ours(
      rows.filter(({ outcome }) => outcome === "requeued").map(({ id }) => id),
    ),
  ).toEqual(requeued);
  expect(
    rows
      .filter(({ id }) => requeued.includes(id))
      .every(
        ({ actor, reason }) =>
          actor === "test" && reason === "requeue for the fixed parser",
      ),
  ).toBe(true);

  const audit = await testDb
    .select({
      id: caseLawIndexJobs.decisionId,
      operation: caseLawIndexJobs.operation,
    })
    .from(caseLawIndexJobs)
    .where(inArray(caseLawIndexJobs.decisionId, requeued));
  expect(audit.map(({ id }) => id).toSorted()).toEqual(requeued);
  expect(audit.every(({ operation }) => operation === "withdraw")).toBe(true);

  const stored = await testDb
    .select({
      id: caseLawDecisions.id,
      fulltext: caseLawDecisions.fulltext,
      attempts: caseLawDecisions.documentFetchAttempts,
    })
    .from(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, [...seeded.values()]));
  for (const row of stored) {
    const isRequeued = requeued.includes(row.id);
    expect({
      id: row.id,
      pending: row.fulltext === null && row.attempts === 0,
    }).toEqual({
      id: row.id,
      pending: isRequeued,
    });
  }

  // The walk hands them out again once the base cooldown passed.
  await testDb
    .update(caseLawDecisions)
    .set({ documentFetchAttemptedAt: hoursAgo(24 * 365) })
    .where(inArray(caseLawDecisions.id, requeued));
  const queue = await loadPendingDocuments({
    scopedDb,
    adapterKey: ADAPTER_KEYS.SK_COURTS,
    limit: 1000,
  });
  expect(ours(queue.map(({ id }) => id))).toEqual(requeued);

  // Nothing is left to requeue, and a stale list requeues nothing twice.
  expect(ours((await scanAll()).matched)).toEqual([]);
  const again = await requeueEmptiedDocuments({
    scopedDb,
    sourceId,
    since: SINCE,
    decisionIds: requeued,
  });
  expect(again.map(({ outcome }) => outcome.type)).toEqual(
    requeued.map(() => "no-longer-eligible"),
  );
});

test("a rejected row is quarantined without rolling back its healthy batch sibling", async () => {
  const ids = qualifying();
  await testDb
    .update(caseLawDecisions)
    .set({
      fulltext: "",
      documentFetchAttempts: 2,
      documentFetchAttemptedAt: hoursAgo(6),
    })
    .where(inArray(caseLawDecisions.id, ids));
  const poison = ids.at(0);
  if (poison === undefined) {
    throw new Error("missing poison fixture");
  }
  await testDb.execute(
    sql`ALTER TABLE case_law_decisions ADD CONSTRAINT reject_empty_requeue
    CHECK (id <> ${poison} OR fulltext IS NOT NULL)`.inlineParams(),
  );
  const result = await requeueEmptiedDocuments({
    scopedDb,
    sourceId,
    since: SINCE,
    decisionIds: ids,
  });
  expect(result).toEqual(
    ids.map((decisionId) => ({
      decisionId,
      outcome:
        decisionId === poison
          ? { type: "quarantined", reason: "projection-or-update-failed" }
          : { type: "requeued" },
    })),
  );
  const stored = await testDb
    .select({ id: caseLawDecisions.id, fulltext: caseLawDecisions.fulltext })
    .from(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, ids));
  expect(stored.find(({ id }) => id === poison)?.fulltext).toBe("");
  expect(
    stored
      .filter(({ id }) => id !== poison)
      .every(({ fulltext }) => fulltext === null),
  ).toBe(true);
  await testDb.execute(
    sql`ALTER TABLE case_law_decisions DROP CONSTRAINT reject_empty_requeue`,
  );
});
