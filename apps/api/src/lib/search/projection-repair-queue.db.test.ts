import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  contacts,
  entities,
  searchProjectionRepairQueue,
  workspaceContacts,
  workspaces,
} from "@/api/db/schema";
import type { SearchProjectionKind } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  SEARCH_PROJECTION_REPAIR_BATCH_SIZE,
  drainSearchProjectionRepairQueue,
  enqueueContactSearchRepairs,
  enqueueEntitySearchRepairs,
  enqueueWorkspaceSearchRepairs,
  flushWorkspaceSearchRepairs,
} from "@/api/lib/search/projection-repair-queue";
import type { SearchProjectionRepairDeps } from "@/api/lib/search/projection-repair-queue";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// The queue is now the only durable record that a projection is behind, so
// what is asserted here is the part no type can hold: that the mark commits
// with the mutation and disappears with it, that a repeat edit produces one
// pending repair rather than a queue of them, that a repair which cannot be
// made stops occupying the batch, and that an edit landing mid-repair is not
// deleted as already handled. The party-removal case is the one that had no
// detectable trace at all before this table existed.

const ORGANIZATION_ID = "org-projection-repair-queue";
const SEED_AT = new Date("2026-01-01T00:00:00.000Z");

const uuid = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const workspaceId = (suffix: number): SafeId<"workspace"> =>
  toSafeId<"workspace">(uuid(suffix));
const contactId = (suffix: number): SafeId<"contact"> =>
  toSafeId<"contact">(uuid(suffix));
const entityId = (suffix: number): SafeId<"entity"> =>
  toSafeId<"entity">(uuid(suffix));

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

/** pglite stands in for both the request transaction and the owner handle. */
const asTx = () => asTestRaw<Transaction>(db);

type RepairLog = {
  failing: Set<string>;
  repaired: string[];
};

const repairDeps = (log: RepairLog): SearchProjectionRepairDeps => {
  const record = async (sourceId: string): Promise<void> => {
    if (log.failing.has(sourceId)) {
      throw new Error(`repair refused for ${sourceId}`);
    }
    log.repaired.push(sourceId);
  };
  return {
    db: asTestRaw<SearchProjectionRepairDeps["db"]>(db),
    repair: { contact: record, entity: record, workspace: record },
  };
};

const emptyLog = (): RepairLog => ({ failing: new Set(), repaired: [] });

const queueRows = async () =>
  await db
    .select({
      attempts: searchProjectionRepairQueue.attempts,
      kind: searchProjectionRepairQueue.kind,
      revision: searchProjectionRepairQueue.revision,
      sourceId: searchProjectionRepairQueue.sourceId,
    })
    .from(searchProjectionRepairQueue)
    .orderBy(searchProjectionRepairQueue.sourceId);

const seedWorkspace = async (id: SafeId<"workspace">) => {
  await db.insert(workspaces).values({
    createdAt: SEED_AT,
    id,
    lastActivityAt: SEED_AT,
    name: `Matter ${id}`,
    organizationId: toSafeId<"organization">(ORGANIZATION_ID),
    reference: `ref-${id}`,
  });
  return id;
};

const seedContact = async (id: SafeId<"contact">) => {
  await db.insert(contacts).values({
    createdAt: SEED_AT,
    displayName: `Contact ${id}`,
    id,
    organizationId: toSafeId<"organization">(ORGANIZATION_ID),
    type: "person",
    updatedAt: SEED_AT,
  });
  return id;
};

const seedEntities = async (
  ids: readonly SafeId<"entity">[],
  entityWorkspaceId: SafeId<"workspace">,
) => {
  await db.insert(entities).values(
    ids.map((id) => ({
      createdAt: SEED_AT,
      id,
      name: `Document ${id}`,
      updatedAt: SEED_AT,
      workspaceId: entityWorkspaceId,
    })),
  );
  return ids;
};

const seedEntity = async (
  id: SafeId<"entity">,
  entityWorkspaceId: SafeId<"workspace">,
) => {
  await seedEntities([id], entityWorkspaceId);
  return id;
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
}, 300_000);

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  // Every seeded source hangs off the organization, so one cascading truncate
  // isolates each test without paying for a second PGlite instance. The queue
  // takes no foreign key to its sources, which is the point of it, so it is
  // named explicitly rather than swept up by the cascade.
  await db.execute(
    sql.raw(
      'TRUNCATE TABLE "organization", "search_projection_repair_queue" CASCADE',
    ),
  );
  await db.insert(organization).values({
    createdAt: SEED_AT,
    id: ORGANIZATION_ID,
    name: "Projection repair queue",
    slug: ORGANIZATION_ID,
  });
});

test("the dirty mark rolls back with the mutation that wrote it", async () => {
  const matter = await seedWorkspace(workspaceId(1));
  const document = await seedEntity(entityId(10), matter);

  await expect(
    db.transaction(async (tx) => {
      await enqueueEntitySearchRepairs(asTestRaw<Transaction>(tx), [document]);
      throw new Error("mutation failed after enqueue");
    }),
  ).rejects.toThrow("mutation failed after enqueue");

  expect(await queueRows()).toEqual([]);

  await db.transaction(async (tx) => {
    await enqueueEntitySearchRepairs(asTestRaw<Transaction>(tx), [document]);
  });

  expect(await queueRows()).toMatchObject([
    { attempts: 0, kind: "entity", sourceId: document },
  ]);
});

test("repeat edits collapse onto one row and reset its schedule", async () => {
  const matter = await seedWorkspace(workspaceId(1));
  const document = await seedEntity(entityId(10), matter);

  await enqueueEntitySearchRepairs(asTx(), [document]);
  const first = (await queueRows()).at(0);

  // A row already backed off is due again once the source changes: the new
  // edit has not been tried, whatever happened to the previous one.
  await db
    .update(searchProjectionRepairQueue)
    .set({ attempts: 4, nextAttemptAt: new Date(Date.now() + 3_600_000) })
    .where(eq(searchProjectionRepairQueue.sourceId, document));
  await enqueueEntitySearchRepairs(asTx(), [document, document]);

  const rows = await queueRows();
  expect(rows).toHaveLength(1);
  expect(rows.at(0)?.attempts).toBe(0);
  expect(rows.at(0)?.revision).not.toBe(first?.revision);

  const log = emptyLog();
  const outcome = await drainSearchProjectionRepairQueue({
    deps: repairDeps(log),
  });
  expect(outcome).toEqual({ failed: 0, repaired: 1 });
  expect(log.repaired).toEqual([document]);
});

test("a drained repair removes its row; a failed one backs off out of the batch", async () => {
  const matter = await seedWorkspace(workspaceId(1));
  const healthy = await seedEntity(entityId(10), matter);
  const poison = await seedEntity(entityId(11), matter);

  await enqueueEntitySearchRepairs(asTx(), [healthy, poison]);

  const log = emptyLog();
  log.failing.add(poison);
  const first = await drainSearchProjectionRepairQueue({
    deps: repairDeps(log),
  });

  expect(first).toEqual({ failed: 1, repaired: 1 });
  expect(log.repaired).toEqual([healthy]);
  expect(await queueRows()).toMatchObject([
    { attempts: 1, kind: "entity", sourceId: poison },
  ]);

  // The failed row keeps its place in the queue but not in the next batch,
  // so it cannot starve the work behind it.
  const secondLog = emptyLog();
  secondLog.failing.add(poison);
  expect(
    await drainSearchProjectionRepairQueue({ deps: repairDeps(secondLog) }),
  ).toEqual({ failed: 0, repaired: 0 });
  expect(await queueRows()).toHaveLength(1);
});

test("a queued source that no longer exists is dropped, not resurrected", async () => {
  const matter = await seedWorkspace(workspaceId(1));
  const document = await seedEntity(entityId(10), matter);

  await enqueueEntitySearchRepairs(asTx(), [document]);
  await db.delete(entities).where(eq(entities.id, document));

  // The upsert helpers this stands in for read their source and write
  // nothing when it is gone; the queue row goes with the repair either way.
  const log = emptyLog();
  expect(
    await drainSearchProjectionRepairQueue({ deps: repairDeps(log) }),
  ).toEqual({ failed: 0, repaired: 1 });
  expect(await queueRows()).toEqual([]);
});

test("an edit that lands mid-repair survives the repair it raced", async () => {
  const matter = await seedWorkspace(workspaceId(1));
  const document = await seedEntity(entityId(10), matter);

  await enqueueEntitySearchRepairs(asTx(), [document]);
  const log = emptyLog();
  const deps = repairDeps(log);
  const racing: SearchProjectionRepairDeps = {
    db: deps.db,
    repair: {
      ...deps.repair,
      entity: async (sourceId) => {
        await enqueueEntitySearchRepairs(asTx(), [document]);
        await deps.repair.entity(sourceId);
      },
    },
  };

  expect(await drainSearchProjectionRepairQueue({ deps: racing })).toEqual({
    failed: 0,
    repaired: 1,
  });
  expect(await queueRows()).toMatchObject([
    { attempts: 0, kind: "entity", sourceId: document },
  ]);
});

test("a drain claims at most one batch and leaves the rest queued", async () => {
  const matter = await seedWorkspace(workspaceId(1));
  const overflow = SEARCH_PROJECTION_REPAIR_BATCH_SIZE + 3;
  const documents = await seedEntities(
    Array.from({ length: overflow }, (_unused, index) => entityId(100 + index)),
    matter,
  );
  await enqueueEntitySearchRepairs(asTx(), documents);

  const log = emptyLog();
  expect(
    await drainSearchProjectionRepairQueue({ deps: repairDeps(log) }),
  ).toEqual({ failed: 0, repaired: SEARCH_PROJECTION_REPAIR_BATCH_SIZE });
  expect(await queueRows()).toHaveLength(
    overflow - SEARCH_PROJECTION_REPAIR_BATCH_SIZE,
  );
});

test("removing a party marks its matter, which nothing else records", async () => {
  const matter = await seedWorkspace(workspaceId(1));
  const party = await seedContact(contactId(20));
  await db.insert(workspaceContacts).values({
    contactId: party,
    organizationId: toSafeId<"organization">(ORGANIZATION_ID),
    role: "opposing_party",
    workspaceId: matter,
  });

  // The matter's searchable text folds in each party's name, but removing a
  // party moves no timestamp on any surviving row: the matter's own columns
  // are untouched and the join row is gone. Only this mark is left.
  await db.transaction(async (tx) => {
    await tx
      .delete(workspaceContacts)
      .where(
        and(
          eq(workspaceContacts.workspaceId, matter),
          eq(workspaceContacts.contactId, party),
        ),
      );
    await enqueueWorkspaceSearchRepairs(asTestRaw<Transaction>(tx), [matter]);
  });

  const survivor = await db
    .select({ lastActivityAt: workspaces.lastActivityAt })
    .from(workspaces)
    .where(eq(workspaces.id, matter));
  expect(survivor.at(0)?.lastActivityAt).toEqual(SEED_AT);

  const kind: SearchProjectionKind = "workspace";
  expect(await queueRows()).toMatchObject([{ kind, sourceId: matter }]);

  const log = emptyLog();
  expect(await flushWorkspaceSearchRepairs([matter], repairDeps(log))).toEqual({
    failed: 0,
    repaired: 1,
  });
  expect(log.repaired).toEqual([matter]);
  expect(await queueRows()).toEqual([]);
});

test("a flush repairs only the sources it was handed", async () => {
  const matter = await seedWorkspace(workspaceId(1));
  const party = await seedContact(contactId(20));
  const document = await seedEntity(entityId(10), matter);

  await enqueueWorkspaceSearchRepairs(asTx(), [matter]);
  await enqueueContactSearchRepairs(asTx(), [party]);
  await enqueueEntitySearchRepairs(asTx(), [document]);

  const log = emptyLog();
  expect(await flushWorkspaceSearchRepairs([matter], repairDeps(log))).toEqual({
    failed: 0,
    repaired: 1,
  });
  expect(log.repaired).toEqual([matter]);
  expect((await queueRows()).map(({ kind }) => kind).toSorted()).toEqual([
    "contact",
    "entity",
  ]);
});
