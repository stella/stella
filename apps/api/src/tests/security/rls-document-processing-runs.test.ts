import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull, lte, or } from "drizzle-orm";

import {
  DOCUMENT_PROCESSING_KINDS,
  DOCUMENT_PROCESSING_REQUEST_SOURCES,
  DOCUMENT_PROCESSING_STATUSES,
  documentProcessingRuns,
  SCOPED_NATIVE_EXTRACTION_ENQUEUE,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION } from "@/api/lib/document-processing-contract";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type {
  TestDatabase,
  createDryScopedQuery,
  createScopedQuery,
} from "@/api/tests/security/test-utils";

// `document_processing_runs` is root-worker owned except for one hole: the
// transaction that commits an uploaded file may commit the request to extract
// its text (policy `document_processing_runs_native_extraction_insert`). These
// tests pin the width of that hole from both sides — the enqueue shape goes in,
// nothing else does — and that the request survives exactly with its caller.

let testDb: TestDatabase;
let ids: TestIds;
let scopedQuery: ReturnType<typeof createScopedQuery>;
let dryScopedQuery: ReturnType<typeof createDryScopedQuery>;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedQuery = fixture.scopedQuery;
  dryScopedQuery = fixture.dryScopedQuery;
});

afterAll(async () => {
  await releaseRlsFixture();
});

/** The row the upload path writes, for the seeded document in wsA1/orgA. */
const enqueueValues = () =>
  ({
    id: createSafeId<"documentProcessingRun">(),
    ...SCOPED_NATIVE_EXTRACTION_ENQUEUE,
    entityId: ids.entityA1,
    entityVersionId: ids.entityVersionA1,
    fieldId: ids.fileFieldA1,
    organizationId: ids.orgA,
    processorVersion: DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION,
    // Distinct per call: the source identity is unique, so reusing one file id
    // would make a later insert a no-op conflict instead of a policy decision.
    sourceFileId: Bun.randomUUIDv7(),
    sourceSha256Hex: "a".repeat(64),
    workspaceId: ids.wsA1,
  }) satisfies typeof documentProcessingRuns.$inferInsert;

const tryCatch = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};

/** Insert as the app role from a session scoped to wsA1/orgA. */
const insertAsScopedRole = async (
  values: typeof documentProcessingRuns.$inferInsert,
) =>
  await scopedQuery(
    [ids.wsA1],
    ids.orgA,
    async (tx) =>
      await tryCatch(async () => {
        await tx.insert(documentProcessingRuns).values(values);
      }),
    ids.userA1,
  );

const expectRejected = (error: unknown) => {
  expect(isPgError(error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
};

// One rejection case per off-shape value, derived from the persisted domain
// unions rather than hand-listed: a new kind, status, or request source is
// covered by this matrix the moment it is added to the schema.
type RejectionCase = {
  label: string;
  overrides: () => Partial<typeof documentProcessingRuns.$inferInsert>;
};

const offShapeCases: RejectionCase[] = [
  ...DOCUMENT_PROCESSING_KINDS.filter(
    (kind) => kind !== SCOPED_NATIVE_EXTRACTION_ENQUEUE.kind,
  ).map((kind) => ({ label: `kind ${kind}`, overrides: () => ({ kind }) })),
  ...DOCUMENT_PROCESSING_REQUEST_SOURCES.filter(
    (source) => source !== SCOPED_NATIVE_EXTRACTION_ENQUEUE.requestSource,
  ).map((requestSource) => ({
    label: `request source ${requestSource}`,
    overrides: () => ({ requestSource }),
  })),
  ...DOCUMENT_PROCESSING_STATUSES.filter(
    (status) => status !== SCOPED_NATIVE_EXTRACTION_ENQUEUE.status,
  ).map((status) => ({
    label: `status ${status}`,
    overrides: () => ({ status }),
  })),
  { label: "attempts already spent", overrides: () => ({ attemptCount: 1 }) },
  {
    label: "attribution to a user",
    overrides: () => ({ requestedBy: ids.userA1 }),
  },
];

const foreignScopeCases: RejectionCase[] = [
  {
    label: "a workspace outside the session",
    overrides: () => ({
      entityId: ids.entityB1,
      entityVersionId: ids.entityVersionB1,
      fieldId: ids.fileFieldB1,
      organizationId: ids.orgB,
      sourceSha256Hex: "b".repeat(64),
      workspaceId: ids.wsB1,
    }),
  },
  {
    label: "another organization on an authorized workspace",
    overrides: () => ({ organizationId: ids.orgB }),
  },
];

describe("document_processing_runs INSERT", () => {
  test("the upload enqueue shape is accepted", async () => {
    const values = enqueueValues();

    expect(await insertAsScopedRole(values)).toBeNull();
    expect(
      await testDb.$count(
        documentProcessingRuns,
        eq(documentProcessingRuns.id, values.id),
      ),
    ).toBe(1);
  });

  // Both directions: every declared domain value is either the one value the
  // enqueue shape carries or a value the matrix below proves is rejected. A
  // new kind, status, or request source lands as a failing test, not as a
  // silently admitted insert.
  test("every persisted domain value is decided", () => {
    const exercised = new Set(offShapeCases.map(({ label }) => label));
    const declared = [
      ...DOCUMENT_PROCESSING_KINDS.map((kind) => `kind ${kind}`),
      ...DOCUMENT_PROCESSING_REQUEST_SOURCES.map(
        (source) => `request source ${source}`,
      ),
      ...DOCUMENT_PROCESSING_STATUSES.map((status) => `status ${status}`),
    ];

    expect(declared.filter((label) => !exercised.has(label))).toEqual([
      `kind ${SCOPED_NATIVE_EXTRACTION_ENQUEUE.kind}`,
      `request source ${SCOPED_NATIVE_EXTRACTION_ENQUEUE.requestSource}`,
      `status ${SCOPED_NATIVE_EXTRACTION_ENQUEUE.status}`,
    ]);
    expect([...exercised].filter((label) => !declared.includes(label))).toEqual(
      ["attempts already spent", "attribution to a user"],
    );
  });

  for (const { label, overrides } of offShapeCases) {
    test(`rejects ${label}`, async () => {
      expectRejected(
        await insertAsScopedRole({ ...enqueueValues(), ...overrides() }),
      );
    });
  }

  for (const { label, overrides } of foreignScopeCases) {
    test(`rejects ${label}`, async () => {
      expectRejected(
        await insertAsScopedRole({ ...enqueueValues(), ...overrides() }),
      );
    });
  }
});

describe("document_processing_runs — post-insert lifecycle stays root-owned", () => {
  test("the requesting tenant cannot advance, retry, or delete its run", async () => {
    const values = enqueueValues();
    expect(await insertAsScopedRole(values)).toBeNull();

    const { deleted, updated } = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      async (tx) => ({
        updated: await tx
          .update(documentProcessingRuns)
          .set({ status: "running", attemptCount: 5 })
          .where(eq(documentProcessingRuns.id, values.id))
          .returning({ id: documentProcessingRuns.id }),
        deleted: await tx
          .delete(documentProcessingRuns)
          .where(eq(documentProcessingRuns.id, values.id))
          .returning({ id: documentProcessingRuns.id }),
      }),
      ids.userA1,
    );

    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
    const stored = await testDb
      .select({
        attemptCount: documentProcessingRuns.attemptCount,
        status: documentProcessingRuns.status,
      })
      .from(documentProcessingRuns)
      .where(eq(documentProcessingRuns.id, values.id));
    expect(stored.at(0)).toEqual({ attemptCount: 0, status: "queued" });
  });
});

describe("document_processing_runs — request durability", () => {
  const countRun = async (runId: SafeId<"documentProcessingRun">) =>
    await testDb.$count(
      documentProcessingRuns,
      eq(documentProcessingRuns.id, runId),
    );

  /** The predicate `dispatchQueuedDocumentProcessingRuns` selects on. */
  const isDispatchable = (runId: SafeId<"documentProcessingRun">) =>
    and(
      eq(documentProcessingRuns.id, runId),
      eq(documentProcessingRuns.status, "queued"),
      or(
        isNull(documentProcessingRuns.nextAttemptAt),
        lte(documentProcessingRuns.nextAttemptAt, new Date()),
      ),
    );

  test("a rolled-back caller leaves no request behind", async () => {
    const values = enqueueValues();

    await dryScopedQuery(
      [ids.wsA1],
      ids.orgA,
      async (tx) => {
        await tx.insert(documentProcessingRuns).values(values);
      },
      ids.userA1,
    );

    expect(await countRun(values.id)).toBe(0);
  });

  test("a committed caller leaves a request the dispatcher can claim", async () => {
    const values = enqueueValues();

    expect(await insertAsScopedRole(values)).toBeNull();

    expect(
      await testDb.$count(documentProcessingRuns, isDispatchable(values.id)),
    ).toBe(1);
  });

  test("re-requesting the same source does not create a second run", async () => {
    const values = enqueueValues();
    expect(await insertAsScopedRole(values)).toBeNull();

    const duplicate = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      async (tx) =>
        await tx
          .insert(documentProcessingRuns)
          .values({ ...values, id: createSafeId<"documentProcessingRun">() })
          .onConflictDoNothing({
            target: [
              documentProcessingRuns.organizationId,
              documentProcessingRuns.kind,
              documentProcessingRuns.entityVersionId,
              documentProcessingRuns.fieldId,
              documentProcessingRuns.sourceFileId,
              documentProcessingRuns.sourceSha256Hex,
              documentProcessingRuns.processorVersion,
            ],
          })
          .returning({ id: documentProcessingRuns.id }),
      ids.userA1,
    );

    expect(duplicate).toEqual([]);
    expect(await countRun(values.id)).toBe(1);
  });
});

describe("document_processing_runs SELECT", () => {
  test("a run is invisible outside its tenant", async () => {
    const values = enqueueValues();
    expect(await insertAsScopedRole(values)).toBeNull();

    const foreignCount = await scopedQuery(
      [ids.wsB1],
      ids.orgB,
      async (tx) =>
        await tx.$count(
          documentProcessingRuns,
          eq(documentProcessingRuns.id, values.id),
        ),
      ids.userB1,
    );

    expect(foreignCount).toBe(0);
  });
});
