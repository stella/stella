import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { organization } from "@/api/db/auth-schema";
import { databaseRelations } from "@/api/db/database-relations";
import { contacts, workspaceContacts, workspaces } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  rebuildSupplementalSearchDocuments,
  reindexWorkspacesForContact,
  upsertContactSearchDocument,
  upsertWorkspaceSearchDocument,
} from "@/api/lib/search/index-global";
import { buildSearchPreviewPassages } from "@/api/lib/search/preview-passages";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// Contact and matter projections are rebuilt in bounded batches. What is
// asserted here: the statements a rebuild issues grow with its number of
// batches, not its number of sources; and a batched rebuild writes exactly
// what rebuilding each source on its own writes, projection and preview
// passages alike.

const SEED_AT = new Date("2026-01-01T00:00:00.000Z");
const BATCH = 100;

const uuid = (prefix: number, suffix: number): string =>
  `00000000-0000-4000-${String(prefix).padStart(4, "0")}-${String(suffix).padStart(12, "0")}`;
const contactId = (org: number, suffix: number): SafeId<"contact"> =>
  toSafeId<"contact">(uuid(org, suffix));
const workspaceId = (org: number, suffix: number): SafeId<"workspace"> =>
  toSafeId<"workspace">(uuid(org + 5000, suffix));
const orgId = (org: number): SafeId<"organization"> =>
  toSafeId<"organization">(`org-supplemental-${org}`);

type TestPglite = Awaited<ReturnType<typeof createTestPglite>>;
const createProjectionDb = (pglite: TestPglite) =>
  drizzle({ client: pglite, relations: databaseRelations });

let client: TestPglite;
let db: ReturnType<typeof createProjectionDb>;

type ProjectionDatabase = Parameters<
  typeof rebuildSupplementalSearchDocuments
>[1];

type Counts = { reads: number; transactions: number; statements: number };

/**
 * The test database behind a counter: every read the rebuild issues, every
 * transaction it opens, and every statement inside one.
 */
const countingDatabase = (): {
  counts: Counts;
  database: ProjectionDatabase;
} => {
  const counts: Counts = { reads: 0, transactions: 0, statements: 0 };
  const counted =
    <Args extends unknown[], Result>(run: (...args: Args) => Result) =>
    (...args: Args): Result => {
      counts.reads += 1;
      return run(...args);
    };
  const database = asTestRaw<ProjectionDatabase>({
    query: {
      contacts: {
        findFirst: counted(db.query.contacts.findFirst.bind(db.query.contacts)),
        findMany: counted(db.query.contacts.findMany.bind(db.query.contacts)),
      },
      workspaces: {
        findMany: counted(
          db.query.workspaces.findMany.bind(db.query.workspaces),
        ),
      },
    },
    select: counted(db.select.bind(db)),
    transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      counts.transactions += 1;
      return await db.transaction(
        async (tx) =>
          await run({
            execute: async (query: SQL) => {
              counts.statements += 1;
              return (await tx.execute(query)).rows;
            },
          }),
      );
    },
  });
  return { counts, database };
};

const seedOrganization = async (org: number) => {
  await db.insert(organization).values({
    createdAt: SEED_AT,
    id: orgId(org),
    name: `Supplemental ${org}`,
    slug: orgId(org),
  });
};

const seedContacts = async (org: number, count: number) => {
  await db.insert(contacts).values(
    Array.from({ length: count }, (_, index) => ({
      createdAt: SEED_AT,
      displayName: `Contact ${org}-${index}`,
      id: contactId(org, index + 1),
      organizationId: orgId(org),
      type: "person" as const,
      updatedAt: SEED_AT,
    })),
  );
};

const seedWorkspaces = async (org: number, count: number) => {
  await db.insert(workspaces).values(
    Array.from({ length: count }, (_, index) => ({
      createdAt: SEED_AT,
      id: workspaceId(org, index + 1),
      lastActivityAt: SEED_AT,
      name: `Matter ${org}-${index}`,
      organizationId: orgId(org),
      reference: `ref-${org}-${index}`,
    })),
  );
};

const projectionCount = async (org: number) => {
  const result = await db.execute<{ contacts: number; matters: number }>(sql`
    SELECT
      (SELECT count(*)::int FROM contact_search_documents
        WHERE organization_id = ${orgId(org)}) AS contacts,
      (SELECT count(*)::int FROM workspace_search_documents
        WHERE organization_id = ${orgId(org)}) AS matters
  `);
  return result.rows.at(0);
};

beforeAll(async () => {
  client = await createTestPglite();
  db = createProjectionDb(client);
}, 300_000);

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.execute(sql.raw('TRUNCATE TABLE "organization" CASCADE'));
});

describe("batched supplemental rebuild", () => {
  // Per keyset page: one id read, one source read, one transaction of four
  // statements. Pages here are never exactly full at the end, so there is no
  // trailing empty page to account for.
  const expectedCounts = (pages: number): Counts => ({
    reads: 2 * pages,
    transactions: pages,
    statements: 4 * pages,
  });

  test("issues work per batch, not per source", async () => {
    await seedOrganization(1);
    await seedContacts(1, 3);
    await seedWorkspaces(1, 2);
    await seedOrganization(2);
    await seedContacts(2, 2 * BATCH + 50);
    await seedWorkspaces(2, BATCH + 30);

    const small = countingDatabase();
    await rebuildSupplementalSearchDocuments(orgId(1), small.database);
    expect(small.counts).toEqual(expectedCounts(1 + 1));
    expect(await projectionCount(1)).toEqual({ contacts: 3, matters: 2 });

    // Two hundred more sources cost three more batches, not two hundred
    // more transactions.
    const large = countingDatabase();
    await rebuildSupplementalSearchDocuments(orgId(2), large.database);
    expect(large.counts).toEqual(expectedCounts(3 + 2));
    expect(await projectionCount(2)).toEqual({
      contacts: 2 * BATCH + 50,
      matters: BATCH + 30,
    });
  });

  test("a contact's matter cascade rebuilds its matters by batch", async () => {
    await seedOrganization(3);
    await seedContacts(3, 1);
    const party = contactId(3, 1);
    await seedWorkspaces(3, BATCH + 20);
    await db.insert(workspaceContacts).values(
      Array.from({ length: BATCH + 20 }, (_, index) => ({
        contactId: party,
        id: toSafeId<"workspaceContact">(uuid(9000, index + 1)),
        organizationId: orgId(3),
        role: "third_party" as const,
        workspaceId: workspaceId(3, index + 1),
      })),
    );

    const cascade = countingDatabase();
    await reindexWorkspacesForContact(party, cascade.database);
    // The contact, its matter ids, then two batches of matters.
    expect(cascade.counts).toEqual({
      reads: 2 + 2,
      transactions: 2,
      statements: 8,
    });
    expect((await projectionCount(3))?.matters).toBe(BATCH + 20);
  });
});

type ProjectionSnapshot = {
  documents: Record<string, unknown>[];
  passages: Record<string, unknown>[];
};

// Everything but the generation id, which is random per write; its
// consistency is asserted separately.
const snapshot = async (org: number): Promise<ProjectionSnapshot> => {
  const documents = await db.execute<Record<string, unknown>>(sql`
    SELECT 'contact' AS kind, contact_id::text AS id, organization_id,
      contact_type, title, searchable_text, updated_at::text AS updated_at,
      tsv::text AS tsv
    FROM contact_search_documents WHERE organization_id = ${orgId(org)}
    UNION ALL
    SELECT 'matter', workspace_id::text, organization_id, NULL, title,
      searchable_text, updated_at::text, tsv::text
    FROM workspace_search_documents WHERE organization_id = ${orgId(org)}
    ORDER BY kind, id
  `);
  const passages = await db.execute<Record<string, unknown>>(sql`
    SELECT 'contact' AS kind, contact_id::text AS id, ordinal, content,
      tsv::text AS tsv
    FROM contact_search_document_preview_passages
    WHERE organization_id = ${orgId(org)}
    UNION ALL
    SELECT 'matter', workspace_id::text, ordinal, content, tsv::text
    FROM workspace_search_document_preview_passages
    WHERE organization_id = ${orgId(org)}
    ORDER BY kind, id, ordinal
  `);
  return { documents: documents.rows, passages: passages.rows };
};

// Every document names the generation its passages carry, and no stale
// passage from an earlier generation survives the replacement.
const generationMismatches = async (org: number) => {
  const result = await db.execute<{ id: string }>(sql`
    SELECT d.contact_id::text AS id
    FROM contact_search_documents d
    JOIN contact_search_document_preview_passages p ON p.contact_id = d.contact_id
    WHERE d.organization_id = ${orgId(org)}
      AND p.generation IS DISTINCT FROM d.preview_generation
    UNION ALL
    SELECT d.workspace_id::text
    FROM workspace_search_documents d
    JOIN workspace_search_document_preview_passages p ON p.workspace_id = d.workspace_id
    WHERE d.organization_id = ${orgId(org)}
      AND p.generation IS DISTINCT FROM d.preview_generation
  `);
  return result.rows;
};

describe("batched rebuild parity", () => {
  const LONG_NOTES = "Closing memorandum clause. ".repeat(5000);

  const seedParityFixtures = async () => {
    await seedOrganization(4);
    await db.insert(contacts).values([
      {
        addresses: [
          {
            city: "Praha",
            country: "CZ",
            isPrimary: true,
            line1: "Václavské náměstí 1",
            postalCode: "110 00",
            type: "office",
          },
        ],
        createdAt: SEED_AT,
        displayName: "Nováková & partneři",
        emails: [
          {
            address: "office@example.com",
            isPrimary: true,
            label: "Podatelna",
            type: "work",
          },
        ],
        id: contactId(4, 1),
        notes: LONG_NOTES,
        organizationId: orgId(4),
        organizationName: "Nováková & partneři s.r.o.",
        phones: [{ isPrimary: true, number: "+420 123 456", type: "office" }],
        registrationNumber: "12345678",
        tags: ["klient", "vip"],
        type: "organization",
        updatedAt: SEED_AT,
      },
      {
        createdAt: SEED_AT,
        displayName: "محمد علي",
        firstName: "محمد",
        id: contactId(4, 2),
        lastName: "علي",
        organizationId: orgId(4),
        type: "person",
        updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ]);
    await db.insert(workspaces).values([
      {
        billingReference: "INV-7",
        clientId: contactId(4, 1),
        createdAt: SEED_AT,
        id: workspaceId(4, 1),
        lastActivityAt: new Date("2026-03-01T00:00:00.000Z"),
        name: "Akvizice",
        organizationId: orgId(4),
        reference: "M-1",
      },
      {
        createdAt: SEED_AT,
        id: workspaceId(4, 2),
        lastActivityAt: SEED_AT,
        name: "Spor",
        organizationId: orgId(4),
        reference: "M-2",
      },
    ]);
    await db.insert(workspaceContacts).values({
      contactId: contactId(4, 2),
      id: toSafeId<"workspaceContact">(uuid(9100, 1)),
      notes: "svědek",
      organizationId: orgId(4),
      role: "witness",
      workspaceId: workspaceId(4, 2),
    });
  };

  test("writes what rebuilding each source alone writes", async () => {
    await seedParityFixtures();
    const { database } = countingDatabase();

    for (const id of [contactId(4, 1), contactId(4, 2)]) {
      await upsertContactSearchDocument(id, database);
    }
    for (const id of [workspaceId(4, 1), workspaceId(4, 2)]) {
      await upsertWorkspaceSearchDocument(id, database);
    }
    const perSource = await snapshot(4);

    await rebuildSupplementalSearchDocuments(orgId(4), database);
    const batched = await snapshot(4);

    expect(batched).toEqual(perSource);
    expect(await generationMismatches(4)).toEqual([]);
  });

  test("builds the projection text, vector and passages from the sources", async () => {
    await seedParityFixtures();
    const { database } = countingDatabase();
    await rebuildSupplementalSearchDocuments(orgId(4), database);

    const { documents, passages } = await snapshot(4);
    const clientDocument = documents.find(({ id }) => id === contactId(4, 1));
    expect(clientDocument?.["searchable_text"]).toBe(
      [
        "Nováková & partneři s.r.o.",
        LONG_NOTES.trim(),
        "office@example.com Podatelna",
        "+420 123 456",
        "Václavské náměstí 1 Praha 110 00 CZ",
        "klient vip",
        "12345678",
      ].join(" "),
    );
    const matter = documents.find(({ id }) => id === workspaceId(4, 1));
    expect(matter?.["updated_at"]).toBe(
      (
        await db.execute<{ at: string }>(
          sql`SELECT ${new Date("2026-03-01T00:00:00.000Z")}::timestamptz::text AS at`,
        )
      ).rows.at(0)?.at,
    );

    // The vectors are the database's own over the stored text.
    const vectorMismatches = await db.execute<{ id: string }>(sql`
      SELECT contact_id::text AS id FROM contact_search_documents
      WHERE organization_id = ${orgId(4)}
        AND tsv::text IS DISTINCT FROM to_tsvector('simple',
          unaccent(arabic_normalize(coalesce(title, '') || ' ' ||
            coalesce(searchable_text, ''))))::text
      UNION ALL
      SELECT workspace_id::text FROM workspace_search_documents
      WHERE organization_id = ${orgId(4)}
        AND tsv::text IS DISTINCT FROM to_tsvector('simple',
          unaccent(arabic_normalize(coalesce(title, '') || ' ' ||
            coalesce(searchable_text, ''))))::text
    `);
    expect(vectorMismatches.rows).toEqual([]);

    // The long notes span several passages, in order, as the passage
    // builder cuts them.
    const clientPassages = passages
      .filter(({ id }) => id === contactId(4, 1))
      .map(({ ordinal, content }) => ({ content, ordinal }));
    expect(clientPassages).toEqual(
      buildSearchPreviewPassages(
        "Nováková & partneři",
        String(clientDocument?.["searchable_text"]),
      ),
    );
    expect(clientPassages.length).toBeGreaterThan(1);
  });
});
