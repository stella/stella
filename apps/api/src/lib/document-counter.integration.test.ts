import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { MATTER_REFERENCE_RETIRED_CODE } from "@stll/api-contract";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  documentReferenceCounters,
  entities,
  entityVersions,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { readWorkspaceHandler } from "@/api/handlers/workspaces/get";
import { updateWorkspaceHandler } from "@/api/handlers/workspaces/update";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { allocateEntityStamps } from "@/api/lib/document-counter";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
const recordAuditEvent: AuditRecorder = async () => undefined;

// Each test owns the matters it stamps, so the shared fixture's seeded rows
// and their references stay untouched.
const createdWorkspaceIds: SafeId<"workspace">[] = [];

const createMatter = async (
  reference: string,
): Promise<SafeId<"workspace">> => {
  const workspaceId = createSafeId<"workspace">();
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId: ids.orgA,
    name: `Matter ${reference}`,
    reference,
    status: "active" as const,
  });
  createdWorkspaceIds.push(workspaceId);
  return workspaceId;
};

const setReference = async (
  workspaceId: SafeId<"workspace">,
  reference: string,
) => {
  await testDb
    .update(workspaces)
    .set({ reference })
    .where(eq(workspaces.id, workspaceId));
};

const scopeFor = (workspaceIds: SafeId<"workspace">[]) => ({
  safeDb: asTestRaw<SafeDb>(
    createSafeDb(testDb, workspaceIds, ids.orgA, ids.userA1),
  ),
  scopedDb: asTestRaw<ScopedDb>(
    createScopedDb(testDb, workspaceIds, ids.orgA, ids.userA1),
  ),
});

const allocate = async (workspaceId: SafeId<"workspace">, count: number) => {
  const { scopedDb } = scopeFor([workspaceId]);
  return await scopedDb(
    async (tx) => await allocateEntityStamps({ tx, workspaceId, count }),
  );
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  // The fixture database is shared with every other DB-backed file in the
  // batch, so the matters this file invented are removed again.
  if (createdWorkspaceIds.length > 0) {
    await testDb
      .delete(workspaces)
      .where(inArray(workspaces.id, createdWorkspaceIds));
  }
  await releaseRlsFixture();
});

describe("document stamp allocation across a matter reference", () => {
  test("a matter taking over a freed reference continues its numbering", async () => {
    const handoverReference = "HANDOVER/2026";
    const matterA = await createMatter(handoverReference);

    const first = await allocate(matterA, 3);
    expect(first.map(({ stamp }) => stamp)).toEqual([
      `${handoverReference}/001.v1`,
      `${handoverReference}/002.v1`,
      `${handoverReference}/003.v1`,
    ]);

    // The reference is freed and handed to a brand-new matter, whose own
    // document counter starts at zero. Without the reference ledger the next
    // stamp would be HANDOVER/2026/001.v1 again.
    await setReference(matterA, "HANDOVER-RETIRED/2026");
    const matterB = await createMatter(handoverReference);

    const second = await allocate(matterB, 2);
    expect(second.map(({ stamp }) => stamp)).toEqual([
      `${handoverReference}/004.v1`,
      `${handoverReference}/005.v1`,
    ]);

    const stamps = [...first, ...second].map(({ stamp }) => stamp);
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  test("a matter returning to a reference it lent out does not repeat", async () => {
    const original = "ROUNDTRIP/2026";
    const interim = "ROUNDTRIP-INTERIM/2026";
    const borrower = "ROUNDTRIP-BORROWER/2026";
    const matter = await createMatter(original);
    const other = await createMatter(borrower);

    const before = await allocate(matter, 2);

    // The reference goes to another matter, which carries it further, and then
    // comes back. The original matter's own counter still stands at two, so
    // only the reference ledger can stop it from reissuing 003.
    await setReference(matter, interim);
    await setReference(other, original);
    const borrowed = await allocate(other, 2);
    await setReference(other, borrower);
    await setReference(matter, original);
    const after = await allocate(matter, 1);

    expect(before.map(({ stamp }) => stamp)).toEqual([
      `${original}/001.v1`,
      `${original}/002.v1`,
    ]);
    expect(borrowed.map(({ stamp }) => stamp)).toEqual([
      `${original}/003.v1`,
      `${original}/004.v1`,
    ]);
    expect(after.map(({ stamp }) => stamp)).toEqual([`${original}/005.v1`]);

    const stamps = [...before, ...borrowed, ...after].map(({ stamp }) => stamp);
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  // PGlite drives one single-threaded connection, so two transactions cannot
  // genuinely overlap here; this asserts the observable invariant instead —
  // separate transactions allocating under a shared reference from different
  // matters receive disjoint, strictly increasing blocks, which is what the
  // ledger's `FOR UPDATE` serialization has to produce.
  test("separate transactions under one reference receive disjoint blocks", async () => {
    const shared = "SHARED/2026";
    const matterA = await createMatter(shared);
    const matterB = await createMatter("SHARED-OTHER/2026");

    const blockA = await allocate(matterA, 2);
    await setReference(matterA, "SHARED-RETIRED/2026");
    await setReference(matterB, shared);
    const blockB = await allocate(matterB, 2);

    const sequences = [...blockA, ...blockB].map(
      ({ docSequence }) => docSequence,
    );
    expect(sequences).toEqual([1, 2, 3, 4]);
    const stamps = [...blockA, ...blockB].map(({ stamp }) => stamp);
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  test("a matter with an empty reference gets sequence numbers and no stamp", async () => {
    const matter = await createMatter("");

    const allocated = await allocate(matter, 2);

    expect(allocated).toEqual([
      { docSequence: 1, stamp: null },
      { docSequence: 2, stamp: null },
    ]);
  });
});

describe("matter reference change", () => {
  const changeReference = async (
    workspaceId: SafeId<"workspace">,
    reference: string,
  ) => {
    const { safeDb } = scopeFor([workspaceId]);
    return await Result.gen(() =>
      updateWorkspaceHandler({
        safeDb,
        organizationId: ids.orgA,
        workspaceId,
        recordAuditEvent,
        body: { reference },
      }),
    );
  };

  test("refuses a reference another matter has numbered documents under", async () => {
    const claimed = "CLAIMED/2026";
    const owner = await createMatter(claimed);
    await allocate(owner, 2);
    await setReference(owner, "CLAIMED-MOVED-ON/2026");

    const receiver = await createMatter("RECEIVER/2026");
    const updated = await changeReference(receiver, claimed);

    expect(Result.isError(updated)).toBe(true);
    expect(Result.isError(updated) && updated.error).toMatchObject({
      status: 409,
      code: MATTER_REFERENCE_RETIRED_CODE,
    });

    // The write is refused, not merely reported: the matter keeps its own
    // reference and the ledger keeps its owner.
    const [unchanged] = await testDb
      .select({ reference: workspaces.reference })
      .from(workspaces)
      .where(eq(workspaces.id, receiver));
    expect(unchanged?.reference).toBe("RECEIVER/2026");
  });

  test("refuses a reference whose owning matter was deleted", async () => {
    const orphaned = "ORPHANED/2026";
    const owner = await createMatter(orphaned);
    await allocate(owner, 1);
    await testDb.delete(workspaces).where(eq(workspaces.id, owner));

    // The ledger row outlives the matter with a null owner, which is what
    // keeps the reference retired instead of letting it look unclaimed.
    const [ledger] = await testDb
      .select({ workspaceId: documentReferenceCounters.workspaceId })
      .from(documentReferenceCounters)
      .where(
        and(
          eq(documentReferenceCounters.organizationId, ids.orgA),
          eq(documentReferenceCounters.reference, orphaned),
        ),
      );
    expect(ledger?.workspaceId).toBeNull();

    const receiver = await createMatter("ORPHAN-RECEIVER/2026");
    const updated = await changeReference(receiver, orphaned);

    expect(Result.isError(updated) && updated.error).toMatchObject({
      status: 409,
      code: MATTER_REFERENCE_RETIRED_CODE,
    });
  });

  test("allows the owning matter to return to its own reference", async () => {
    const original = "OWN-RETURN/2026";
    const matter = await createMatter(original);
    await allocate(matter, 2);
    await setReference(matter, "OWN-RETURN-INTERIM/2026");

    const updated = await changeReference(matter, original);

    expect(Result.isOk(updated)).toBe(true);
    expect(Result.isOk(updated) && updated.value).toEqual({});

    // Numbering resumes above the mark the matter already reached under it.
    const next = await allocate(matter, 1);
    expect(next.map(({ stamp }) => stamp)).toEqual([`${original}/003.v1`]);
  });

  test("allows a reference nothing has numbered documents under", async () => {
    const matter = await createMatter("FRESH-BEFORE/2026");

    const updated = await changeReference(matter, "FRESH-AFTER/2026");

    expect(Result.isOk(updated)).toBe(true);
    expect(Result.isOk(updated) && updated.value).toEqual({});
  });
});

describe("reference ledger ownership", () => {
  test("records the matter that first numbers documents under a reference", async () => {
    const reference = "OWNERSHIP/2026";
    const matter = await createMatter(reference);

    await allocate(matter, 1);

    const [ledger] = await testDb
      .select({
        workspaceId: documentReferenceCounters.workspaceId,
        lastValue: documentReferenceCounters.lastValue,
      })
      .from(documentReferenceCounters)
      .where(
        and(
          eq(documentReferenceCounters.organizationId, ids.orgA),
          eq(documentReferenceCounters.reference, reference),
        ),
      );

    expect(ledger).toEqual({ workspaceId: matter, lastValue: 1 });
  });
});

describe("matter read", () => {
  test("counts the live versions that already carry a stamp", async () => {
    const matter = await createMatter("STAMPED-COUNT/2026");
    const entityId = createSafeId<"entity">();
    await testDb.insert(entities).values({
      id: entityId,
      workspaceId: matter,
      kind: "document" as const,
      name: "Agreement",
    });
    await testDb.insert(entityVersions).values([
      {
        id: createSafeId<"entityVersion">(),
        workspaceId: matter,
        entityId,
        versionNumber: 1,
        stamp: "STAMPED-COUNT/2026/001.v1",
      },
      {
        id: createSafeId<"entityVersion">(),
        workspaceId: matter,
        entityId,
        versionNumber: 2,
        stamp: "STAMPED-COUNT/2026/001.v2",
        deletedAt: new Date(),
      },
      {
        id: createSafeId<"entityVersion">(),
        workspaceId: matter,
        entityId,
        versionNumber: 3,
        stamp: null,
      },
    ]);

    // A stamped version in a sibling matter must not be counted: the subquery
    // is correlated to the matter being read, not a table-wide aggregate.
    const sibling = await createMatter("STAMPED-COUNT-SIBLING/2026");
    const siblingEntityId = createSafeId<"entity">();
    await testDb.insert(entities).values({
      id: siblingEntityId,
      workspaceId: sibling,
      kind: "document" as const,
      name: "Sibling agreement",
    });
    await testDb.insert(entityVersions).values({
      id: createSafeId<"entityVersion">(),
      workspaceId: sibling,
      entityId: siblingEntityId,
      versionNumber: 1,
      stamp: "STAMPED-COUNT-SIBLING/2026/001.v1",
    });

    const { scopedDb } = scopeFor([matter]);
    const read = await readWorkspaceHandler({
      scopedDb,
      workspaceId: matter,
      organizationId: ids.orgA,
    });

    expect(read).toMatchObject({ stampedVersionCount: 1 });
  });
});
