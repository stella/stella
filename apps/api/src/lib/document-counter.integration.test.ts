import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
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
import {
  allocateEntityStamps,
  recordEntityStamps,
} from "@/api/lib/document-counter";
import { toDocumentReference } from "@/api/lib/document-reference";
import { insertEntityVersions } from "@/api/lib/entity-versions/insert-entity-version";
import { logger } from "@/api/lib/observability/logger";
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
const createdReferences = new Set<string>();

const createMatter = async (
  reference: string,
  organizationId = ids.orgA,
): Promise<SafeId<"workspace">> => {
  const workspaceId = createSafeId<"workspace">();
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: `Matter ${reference}`,
    reference,
    status: "active" as const,
  });
  createdWorkspaceIds.push(workspaceId);
  createdReferences.add(reference);
  return workspaceId;
};

const setReference = async (
  workspaceId: SafeId<"workspace">,
  reference: string,
) => {
  createdReferences.add(reference);
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

const readLedger = async (reference: string, organizationId = ids.orgA) =>
  (
    await testDb
      .select({
        workspaceId: documentReferenceCounters.workspaceId,
        lastValue: documentReferenceCounters.lastValue,
      })
      .from(documentReferenceCounters)
      .where(
        and(
          eq(documentReferenceCounters.organizationId, organizationId),
          eq(documentReferenceCounters.reference, reference),
        ),
      )
  ).at(0);

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
  if (createdReferences.size > 0) {
    await testDb
      .delete(documentReferenceCounters)
      .where(
        and(
          inArray(documentReferenceCounters.organizationId, [
            ids.orgA,
            ids.orgB,
          ]),
          inArray(documentReferenceCounters.reference, [...createdReferences]),
        ),
      );
  }
  await releaseRlsFixture();
});

describe("document stamp allocation across a matter reference", () => {
  test("claims an unissued zero-value ledger before the first stamp", async () => {
    const reference = "ZERO-SEED/2026";
    const matter = await createMatter("ZERO-SEED-TEMP/2026");
    await testDb.insert(documentReferenceCounters).values({
      id: createSafeId<"documentReferenceCounter">(),
      organizationId: ids.orgA,
      reference,
      workspaceId: null,
      lastValue: 0,
    });
    await setReference(matter, reference);

    const [stamp] = await allocate(matter, 1);

    expect(stamp).toEqual({
      docSequence: 1,
      stamp: `${reference}/001.v1`,
    });
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

  test("a live matter adopts a deleted owner's reference above its high-water mark", async () => {
    const reference = "RETIRED-ALLOCATION/2026";
    const previous = await createMatter(reference);
    await allocate(previous, 3);
    await testDb.delete(workspaces).where(eq(workspaces.id, previous));
    const current = await createMatter(reference);

    const issued = await allocate(current, 2);

    expect(issued.map(({ stamp }) => stamp)).toEqual([
      `${reference}/004.v1`,
      `${reference}/005.v1`,
    ]);
    expect(await readLedger(reference)).toEqual({
      workspaceId: current,
      lastValue: 5,
    });
  });

  test("shared numbering preserves a live owner and every caller's high-water mark", async () => {
    const reference = "SHARED-ALLOCATION/2026";
    const owner = await createMatter(reference);
    const before = await allocate(owner, 2);
    await setReference(owner, "SHARED-OWNER-AWAY/2026");
    const other = await createMatter(reference);
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    let borrowed: Awaited<ReturnType<typeof allocate>> = [];
    try {
      borrowed = await allocate(other, 2);
      expect(warn).toHaveBeenCalledWith("document_reference.shared_numbering", {
        "organization.id": ids.orgA,
        "workspace.id": other,
        "workspace.owner_id": owner,
      });
    } finally {
      warn.mockRestore();
    }
    await setReference(other, "SHARED-OTHER-AWAY/2026");
    await setReference(owner, reference);
    const returned = await allocate(owner, 1);
    const stamps = [...before, ...borrowed, ...returned].map(
      ({ stamp }) => stamp,
    );
    expect(stamps).toEqual(
      Array.from(
        { length: 5 },
        (_, index) => `${reference}/00${String(index + 1)}.v1`,
      ),
    );
    expect(new Set(stamps).size).toBe(stamps.length);
    expect(await readLedger(reference)).toEqual({
      workspaceId: owner,
      lastValue: 5,
    });
  });

  test("later versions from multiple matters merge the greatest value without changing a live owner", async () => {
    const reference = "SHARED-VERSIONS/2026";
    const owner = await createMatter(reference);
    await allocate(owner, 2);
    const other = await createMatter("SHARED-VERSIONS-OTHER/2026");
    const { scopedDb } = scopeFor([owner, other]);
    await scopedDb(async (tx) => {
      await recordEntityStamps({
        tx,
        stamps: [
          { workspaceId: owner, stamp: `${reference}/003.v2` },
          { workspaceId: other, stamp: `${reference}/009.v2` },
          { workspaceId: owner, stamp: `${reference}/004.v3` },
        ],
      });
      await recordEntityStamps({
        tx,
        stamps: [{ workspaceId: other, stamp: `${reference}/006.v3` }],
      });
    });
    expect(await readLedger(reference)).toEqual({
      workspaceId: owner,
      lastValue: 9,
    });
  });

  test("the same reference numbers independently across organizations", async () => {
    const reference = "TENANT-NUMBERING/2026";
    const first = await createMatter(reference);
    const second = await createMatter(reference, ids.orgB);
    const a = await allocate(first, 2);
    const dbB = asTestRaw<ScopedDb>(
      createScopedDb(testDb, [second], ids.orgB, ids.userB1),
    );
    const b = await dbB(
      async (tx) =>
        await allocateEntityStamps({ tx, workspaceId: second, count: 1 }),
    );
    expect(a.map(({ docSequence }) => docSequence)).toEqual([1, 2]);
    expect(b.map(({ docSequence }) => docSequence)).toEqual([1]);
    expect(await readLedger(reference)).toEqual({
      workspaceId: first,
      lastValue: 2,
    });
    expect(await readLedger(reference, ids.orgB)).toEqual({
      workspaceId: second,
      lastValue: 1,
    });
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
        userEmail: "standard@example.test",
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
      {
        id: createSafeId<"entityVersion">(),
        workspaceId: matter,
        entityId,
        versionNumber: 4,
        stamp: "STAMPED-COUNT/2026/001/001.v4",
      },
      {
        id: createSafeId<"entityVersion">(),
        workspaceId: matter,
        entityId,
        versionNumber: 5,
        stamp: "PREVIOUS-REFERENCE/001.v5",
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

test("later issuance reserves its prefix while moved history keeps its original owner", async () => {
  const reference = "LATER-ISSUANCE/2026";
  const source = await createMatter(reference);
  const target = await createMatter("MOVED-HISTORY/2026");
  const staleOwner = await createMatter("STALE-ZERO-OWNER/2026");
  const zeroReference = "ZERO-LATER-ISSUANCE/2026";
  const zeroSource = await createMatter("ZERO-LATER-TEMP/2026");
  await testDb.insert(documentReferenceCounters).values({
    id: createSafeId<"documentReferenceCounter">(),
    organizationId: ids.orgA,
    reference: zeroReference,
    workspaceId: staleOwner,
    lastValue: 0,
  });
  await setReference(zeroSource, zeroReference);
  const sourceEntity = createSafeId<"entity">();
  const targetEntity = createSafeId<"entity">();
  const versions = [2, 3].map((versionNumber) => ({
    versionNumber,
    stamp: toDocumentReference({
      matterReference: reference,
      docSequence: 7,
      versionNumber,
    }),
  }));
  const { scopedDb } = scopeFor([source, target, zeroSource]);
  await scopedDb(async (tx) => {
    await tx.insert(entities).values([
      {
        id: sourceEntity,
        name: "Original document",
        workspaceId: source,
        kind: "document",
        docSequence: 7,
      },
      {
        id: targetEntity,
        name: "Moved document",
        workspaceId: target,
        kind: "document",
        docSequence: 1,
      },
    ]);
    await insertEntityVersions({
      tx,
      stampOrigin: "issued",
      values: versions.map((version) => ({
        ...version,
        workspaceId: source,
        entityId: sourceEntity,
      })),
    });
    await insertEntityVersions({
      tx,
      stampOrigin: "copied",
      values: versions.map((version) => ({
        ...version,
        workspaceId: target,
        entityId: targetEntity,
      })),
    });
    const zeroEntity = createSafeId<"entity">();
    await tx.insert(entities).values({
      id: zeroEntity,
      name: "Zero-value ledger document",
      workspaceId: zeroSource,
      kind: "document",
      docSequence: 4,
    });
    await insertEntityVersions({
      tx,
      stampOrigin: "issued",
      values: [
        {
          workspaceId: zeroSource,
          entityId: zeroEntity,
          versionNumber: 1,
          stamp: toDocumentReference({
            matterReference: zeroReference,
            docSequence: 4,
            versionNumber: 1,
          }),
        },
      ],
    });
  });

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
  expect(ledger).toEqual({ workspaceId: source, lastValue: 7 });
  expect((await allocate(source, 1)).at(0)?.docSequence).toBe(8);
  const copied = await testDb
    .select({ stamp: entityVersions.stamp })
    .from(entityVersions)
    .where(eq(entityVersions.entityId, targetEntity))
    .orderBy(entityVersions.versionNumber);
  expect(copied.map(({ stamp }) => stamp)).toEqual(
    versions.map(({ stamp }) => stamp),
  );
  const [zeroLedger] = await testDb
    .select({
      workspaceId: documentReferenceCounters.workspaceId,
      lastValue: documentReferenceCounters.lastValue,
    })
    .from(documentReferenceCounters)
    .where(
      and(
        eq(documentReferenceCounters.organizationId, ids.orgA),
        eq(documentReferenceCounters.reference, zeroReference),
      ),
    );
  expect(zeroLedger).toEqual({ workspaceId: staleOwner, lastValue: 4 });
});
