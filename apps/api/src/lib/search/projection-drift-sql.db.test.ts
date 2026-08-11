import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { organization } from "@/api/db/auth-schema";
import {
  contactSearchDocuments,
  contacts,
  entities,
  entityVersions,
  searchDocuments,
  workspaceContacts,
  workspaceSearchDocuments,
  workspaces,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  SEARCH_PROJECTION_REPAIR_BATCH_SIZE,
  staleContactSearchDocumentsQuery,
  staleEntitySearchDocumentsQuery,
  staleWorkspaceSearchDocumentsQuery,
} from "@/api/lib/search/projection-drift-sql";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// These predicates are the entire standing repair: whatever they fail to
// classify as drifted is never reindexed, and whatever they wrongly classify
// as drifted is rewritten every five minutes forever. Neither failure is
// visible from the types, and both are invisible in production — a projection
// that is simply missing produces no error, just a document nobody can find.

const ORGANIZATION_ID = "org-projection-drift";
const EARLY = new Date("2026-01-01T00:00:00.000Z");
const MIDDLE = new Date("2026-02-01T00:00:00.000Z");
const LATE = new Date("2026-03-01T00:00:00.000Z");

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

const driftedIds = async (query: SQL): Promise<string[]> => {
  const { rows } = await db.execute(query);
  return rows.map((row) => String(row["id"]));
};

type SeedWorkspaceOptions = {
  clientId?: SafeId<"contact">;
  id: SafeId<"workspace">;
  indexedAt?: Date;
  lastActivityAt?: Date;
  status?: "active" | "archived" | "deleting";
};

const seedWorkspace = async ({
  clientId,
  id,
  indexedAt,
  lastActivityAt = EARLY,
  status = "active",
}: SeedWorkspaceOptions): Promise<SafeId<"workspace">> => {
  await db.insert(workspaces).values({
    ...(clientId === undefined ? {} : { clientId }),
    createdAt: EARLY,
    id,
    lastActivityAt,
    name: `Matter ${id}`,
    organizationId: toSafeId<"organization">(ORGANIZATION_ID),
    reference: `ref-${id}`,
    status,
  });
  if (indexedAt !== undefined) {
    await db.insert(workspaceSearchDocuments).values({
      organizationId: toSafeId<"organization">(ORGANIZATION_ID),
      title: "Matter",
      updatedAt: indexedAt,
      workspaceId: id,
    });
  }
  return id;
};

type SeedContactOptions = {
  id: SafeId<"contact">;
  indexedAt?: Date;
  updatedAt?: Date;
};

const seedContact = async ({
  id,
  indexedAt,
  updatedAt = EARLY,
}: SeedContactOptions): Promise<SafeId<"contact">> => {
  await db.insert(contacts).values({
    createdAt: EARLY,
    displayName: `Contact ${id}`,
    id,
    organizationId: toSafeId<"organization">(ORGANIZATION_ID),
    type: "person",
    updatedAt,
  });
  if (indexedAt !== undefined) {
    await db.insert(contactSearchDocuments).values({
      contactId: id,
      contactType: "person",
      organizationId: toSafeId<"organization">(ORGANIZATION_ID),
      title: "Contact",
      updatedAt: indexedAt,
    });
  }
  return id;
};

type SeedEntityOptions = {
  id: SafeId<"entity">;
  indexedAt?: Date;
  updatedAt?: Date;
  withCurrentVersion?: boolean;
  workspaceId: SafeId<"workspace">;
};

const seedEntity = async ({
  id,
  indexedAt,
  updatedAt = EARLY,
  withCurrentVersion = true,
  workspaceId: entityWorkspaceId,
}: SeedEntityOptions): Promise<SafeId<"entity">> => {
  await db.insert(entities).values({
    createdAt: EARLY,
    id,
    name: `Document ${id}`,
    updatedAt,
    workspaceId: entityWorkspaceId,
  });
  if (withCurrentVersion) {
    const versionId = toSafeId<"entityVersion">(id);
    await db.insert(entityVersions).values({
      createdAt: EARLY,
      entityId: id,
      id: versionId,
      workspaceId: entityWorkspaceId,
    });
    // `updated_at` carries no `$onUpdate`, so this back-reference fix-up
    // leaves the entity's own drift timestamp exactly where the seed put it.
    await db
      .update(entities)
      .set({ currentVersionId: versionId })
      .where(eq(entities.id, id));
  }
  if (indexedAt !== undefined) {
    await db.insert(searchDocuments).values({
      entityId: id,
      kind: "document",
      organizationId: toSafeId<"organization">(ORGANIZATION_ID),
      title: "Document",
      updatedAt: indexedAt,
      workspaceId: entityWorkspaceId,
    });
  }
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
  // Every seeded table hangs off the organization, so one cascading truncate
  // isolates each test without paying for a second PGlite instance.
  await db.execute(sql.raw('TRUNCATE TABLE "organization" CASCADE'));
  await db.insert(organization).values({
    createdAt: EARLY,
    id: ORGANIZATION_ID,
    name: "Projection drift",
    slug: ORGANIZATION_ID,
  });
});

test("detects entities with a missing or stale search document", async () => {
  const matter = await seedWorkspace({ id: workspaceId(1) });
  const current = await seedEntity({
    id: entityId(10),
    indexedAt: EARLY,
    updatedAt: EARLY,
    workspaceId: matter,
  });
  const stale = await seedEntity({
    id: entityId(11),
    indexedAt: EARLY,
    updatedAt: MIDDLE,
    workspaceId: matter,
  });
  const missing = await seedEntity({
    id: entityId(12),
    updatedAt: MIDDLE,
    workspaceId: matter,
  });

  const drifted = await driftedIds(
    staleEntitySearchDocumentsQuery(SEARCH_PROJECTION_REPAIR_BATCH_SIZE),
  );

  // Missing first: an unwritten projection is unfindable, which is worse
  // than one serving text from an earlier edit.
  expect(drifted).toEqual([missing, stale]);
  expect(drifted).not.toContain(current);
});

test("skips entities with no current version and matters sealed for deletion", async () => {
  const matter = await seedWorkspace({ id: workspaceId(1) });
  const sealed = await seedWorkspace({
    id: workspaceId(2),
    status: "deleting",
  });
  await seedEntity({
    id: entityId(10),
    withCurrentVersion: false,
    workspaceId: matter,
  });
  await seedEntity({ id: entityId(11), workspaceId: sealed });

  expect(
    await driftedIds(
      staleEntitySearchDocumentsQuery(SEARCH_PROJECTION_REPAIR_BATCH_SIZE),
    ),
  ).toEqual([]);
});

test("does not resurrect the projection of a deleted entity", async () => {
  const matter = await seedWorkspace({ id: workspaceId(1) });
  const deleted = await seedEntity({
    id: entityId(10),
    indexedAt: EARLY,
    updatedAt: MIDDLE,
    workspaceId: matter,
  });

  expect(
    await driftedIds(
      staleEntitySearchDocumentsQuery(SEARCH_PROJECTION_REPAIR_BATCH_SIZE),
    ),
  ).toEqual([deleted]);

  await db.delete(entities).where(eq(entities.id, deleted));

  expect(await db.select().from(searchDocuments)).toEqual([]);
  expect(
    await driftedIds(
      staleEntitySearchDocumentsQuery(SEARCH_PROJECTION_REPAIR_BATCH_SIZE),
    ),
  ).toEqual([]);
});

test("detects contacts with a missing or stale search document", async () => {
  const current = await seedContact({
    id: contactId(20),
    indexedAt: EARLY,
    updatedAt: EARLY,
  });
  const stale = await seedContact({
    id: contactId(21),
    indexedAt: EARLY,
    updatedAt: MIDDLE,
  });
  const missing = await seedContact({ id: contactId(22), updatedAt: MIDDLE });

  const drifted = await driftedIds(
    staleContactSearchDocumentsQuery(SEARCH_PROJECTION_REPAIR_BATCH_SIZE),
  );

  expect(drifted).toEqual([missing, stale]);
  expect(drifted).not.toContain(current);
});

test("does not resurrect the projection of a deleted contact", async () => {
  const deleted = await seedContact({
    id: contactId(20),
    indexedAt: EARLY,
    updatedAt: MIDDLE,
  });

  expect(
    await driftedIds(
      staleContactSearchDocumentsQuery(SEARCH_PROJECTION_REPAIR_BATCH_SIZE),
    ),
  ).toEqual([deleted]);

  await db.delete(contacts).where(eq(contacts.id, deleted));

  expect(await db.select().from(contactSearchDocuments)).toEqual([]);
  expect(
    await driftedIds(
      staleContactSearchDocumentsQuery(SEARCH_PROJECTION_REPAIR_BATCH_SIZE),
    ),
  ).toEqual([]);
});

test("detects matters whose projection predates the matter or one of its parties", async () => {
  const current = await seedWorkspace({
    id: workspaceId(1),
    indexedAt: EARLY,
    lastActivityAt: EARLY,
  });
  const staleByActivity = await seedWorkspace({
    id: workspaceId(2),
    indexedAt: EARLY,
    lastActivityAt: MIDDLE,
  });
  const missing = await seedWorkspace({ id: workspaceId(3) });
  // A renamed party changes the matter's searchable text without touching
  // any column on the matter itself.
  const renamedParty = await seedContact({
    id: contactId(20),
    indexedAt: LATE,
    updatedAt: LATE,
  });
  const staleByParty = await seedWorkspace({
    id: workspaceId(4),
    indexedAt: MIDDLE,
    lastActivityAt: EARLY,
  });
  await db.insert(workspaceContacts).values({
    contactId: renamedParty,
    organizationId: toSafeId<"organization">(ORGANIZATION_ID),
    role: "opposing_party",
    workspaceId: staleByParty,
  });
  // A renamed client is the same drift through the other join.
  const staleByClient = await seedWorkspace({
    clientId: renamedParty,
    id: workspaceId(5),
    indexedAt: MIDDLE,
    lastActivityAt: EARLY,
  });

  const drifted = await driftedIds(
    staleWorkspaceSearchDocumentsQuery(SEARCH_PROJECTION_REPAIR_BATCH_SIZE),
  );

  expect(drifted).toEqual([
    missing,
    staleByActivity,
    staleByParty,
    staleByClient,
  ]);
  expect(drifted).not.toContain(current);
});

test("skips matters sealed for deletion and does not resurrect a deleted matter", async () => {
  await seedWorkspace({ id: workspaceId(1), status: "deleting" });
  const deleted = await seedWorkspace({
    id: workspaceId(2),
    indexedAt: EARLY,
    lastActivityAt: MIDDLE,
  });

  expect(
    await driftedIds(
      staleWorkspaceSearchDocumentsQuery(SEARCH_PROJECTION_REPAIR_BATCH_SIZE),
    ),
  ).toEqual([deleted]);

  await db.delete(workspaces).where(eq(workspaces.id, deleted));

  expect(await db.select().from(workspaceSearchDocuments)).toEqual([]);
  expect(
    await driftedIds(
      staleWorkspaceSearchDocumentsQuery(SEARCH_PROJECTION_REPAIR_BATCH_SIZE),
    ),
  ).toEqual([]);
});

test("hands back at most one batch even when more rows have drifted", async () => {
  const overflow = SEARCH_PROJECTION_REPAIR_BATCH_SIZE + 1;
  await db.insert(contacts).values(
    Array.from({ length: overflow }, (_unused, index) => ({
      createdAt: EARLY,
      displayName: `Contact ${index}`,
      id: contactId(1000 + index),
      organizationId: toSafeId<"organization">(ORGANIZATION_ID),
      type: "person" as const,
      updatedAt: MIDDLE,
    })),
  );

  expect(
    (
      await driftedIds(
        staleContactSearchDocumentsQuery(SEARCH_PROJECTION_REPAIR_BATCH_SIZE),
      )
    ).length,
  ).toBe(SEARCH_PROJECTION_REPAIR_BATCH_SIZE);
});
