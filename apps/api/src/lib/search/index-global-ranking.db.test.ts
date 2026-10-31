import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import {
  entities,
  searchDocuments,
  workspaces,
  workspaceSearchDocuments,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { searchGlobal } from "@/api/lib/search/index-global";
import type { GlobalSearchQuery } from "@/api/lib/search/index-global";
import { decodeGlobalSearchCursor } from "@/api/lib/search/pagination";
import type { SearchRankingTier } from "@/api/lib/search/pagination";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { executeRowsScopedDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
const documentWorkspaceId = createSafeId<"workspace">();
const exactDocumentId = createSafeId<"entity">();
const prefixDocumentId = createSafeId<"entity">();
const matterIds = Array.from({ length: 30 }, () => createSafeId<"workspace">());
const accessibleWorkspaceIds = [documentWorkspaceId, ...matterIds];

let testDb: TestDatabase;

const search = async (overrides: Partial<GlobalSearchQuery> = {}) =>
  await searchGlobal(
    {
      query: "Zaloba Prehled.pdf",
      organizationId,
      userId,
      accessibleWorkspaceIds,
      selectedWorkspaceIds: [],
      types: ["document", "matter"],
      editedByUserIds: [],
      mimeTypes: [],
      limit: 2,
      ...overrides,
    },
    {
      scopedDb: executeRowsScopedDb(
        async (read) => await testDb.transaction(read),
      ),
      readLanguageAlternates: async () =>
        await Promise.resolve({ alternatesFor: () => [] }),
    },
  );

beforeAll(async () => {
  testDb = await getTestDb();
  await testDb.execute(
    sql`CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple)`,
  );
  await testDb.insert(organization).values({
    id: organizationId,
    name: "Search ranking organization",
    slug: `search-ranking-${organizationId}`,
    createdAt: new Date(),
  });
  await recordNewOrganizationAccessState(testDb, {
    organizationId,
    now: new Date(),
  });
  await testDb.insert(workspaces).values(
    accessibleWorkspaceIds.map((id, index) => ({
      id,
      organizationId,
      name: index === 0 ? "Documents" : `Žaloba matter ${index}`,
      reference: `RANK-${index}`,
      status: "active" as const,
    })),
  );
  await testDb.insert(entities).values([
    {
      id: exactDocumentId,
      workspaceId: documentWorkspaceId,
      kind: "document",
      name: "Žaloba Přehled.pdf",
    },
    {
      id: prefixDocumentId,
      workspaceId: documentWorkspaceId,
      kind: "document",
      name: "Žaloba Přehled - poznámky.docx",
    },
  ]);
  await testDb.insert(searchDocuments).values([
    {
      entityId: exactDocumentId,
      organizationId,
      workspaceId: documentWorkspaceId,
      kind: "document",
      title: "Žaloba Přehled.pdf",
      searchableText: "žaloba přehled pdf",
      tsv: sql`to_tsvector('public.stella_unaccent', 'zaloba prehled pdf')`,
    },
    {
      entityId: prefixDocumentId,
      organizationId,
      workspaceId: documentWorkspaceId,
      kind: "document",
      title: "Žaloba Přehled - poznámky.docx",
      searchableText: "žaloba přehled poznámky pdf",
      tsv: sql`to_tsvector('public.stella_unaccent', 'zaloba prehled poznamky pdf')`,
    },
  ]);
  await testDb.insert(workspaceSearchDocuments).values(
    matterIds.map((workspaceId, index) => ({
      workspaceId,
      organizationId,
      title: `Žaloba matter ${index + 1}`,
      searchableText: `přehled pdf ${"žaloba přehled pdf ".repeat(20)}`,
      tsv: sql`to_tsvector('public.stella_unaccent', ${`Zaloba matter ${index + 1} prehled pdf ${"zaloba prehled pdf ".repeat(20)}`})`,
    })),
  );
});

afterAll(async () => {
  await releaseTestDb();
});

test("a dotted reference is not mistaken for a filename extension", async () => {
  const bodyOnlyId = createSafeId<"entity">();
  const titleMatchId = createSafeId<"entity">();
  await testDb.insert(entities).values([
    {
      id: bodyOnlyId,
      workspaceId: documentWorkspaceId,
      kind: "document",
      name: "Article 10",
    },
    {
      id: titleMatchId,
      workspaceId: documentWorkspaceId,
      kind: "document",
      name: "Notes on Article 1.2",
    },
  ]);
  await testDb.insert(searchDocuments).values([
    {
      entityId: bodyOnlyId,
      organizationId,
      workspaceId: documentWorkspaceId,
      kind: "document",
      title: "Article 10",
      searchableText: "article 10 refers to article 1.2",
      tsv: sql`to_tsvector('public.stella_unaccent', 'article 10 refers to article 1.2')`,
    },
    {
      entityId: titleMatchId,
      organizationId,
      workspaceId: documentWorkspaceId,
      kind: "document",
      title: "Notes on Article 1.2",
      searchableText: "notes on article 1.2",
      tsv: sql`to_tsvector('public.stella_unaccent', 'notes on article 1.2')`,
    },
  ]);

  const page = await search({
    query: "Article 1.2",
    types: ["document"],
    limit: 2,
  });

  expect(page.hits.map(({ id }) => id)).toEqual([
    `entity:${titleMatchId}`,
    `entity:${bodyOnlyId}`,
  ]);
});

test("database title tiers outrank stronger loose matches across cursor pages", async () => {
  const firstPage = await search();
  expect(firstPage.hits.map(({ id }) => id)).toEqual([
    `entity:${exactDocumentId}`,
    `entity:${prefixDocumentId}`,
  ]);
  expect(
    decodeGlobalSearchCursor(firstPage.nextCursor ?? undefined),
  ).toMatchObject({
    tier: 3,
    id: `entity:${prefixDocumentId}`,
  });

  const secondPage = await search({
    cursor: firstPage.nextCursor ?? undefined,
    limit: 30,
  });
  expect(secondPage.hits).toHaveLength(30);
  expect(new Set(secondPage.hits.map(({ id }) => id))).toEqual(
    new Set(matterIds.map((id) => `matter:${id}`)),
  );
  expect(
    decodeGlobalSearchCursor(secondPage.nextCursor ?? undefined),
  ).toBeNull();

  const expectedCursorTiers = [
    4,
    3,
    ...matterIds.slice(1).map(() => 1 as const),
  ] satisfies SearchRankingTier[];
  const seenIds: string[] = [];
  let cursor: string | undefined;
  for (const expectedTier of expectedCursorTiers) {
    const page = await search({ cursor, limit: 1 });
    expect(page.hits).toHaveLength(1);
    seenIds.push(page.hits[0]!.id);
    const decoded = decodeGlobalSearchCursor(page.nextCursor ?? undefined);
    expect(decoded?.tier).toBe(expectedTier);
    cursor = page.nextCursor ?? undefined;
  }
  const finalPage = await search({ cursor, limit: 1 });
  expect(finalPage.hits).toHaveLength(1);
  expect(finalPage.nextCursor).toBeNull();
  seenIds.push(finalPage.hits[0]!.id);
  expect(new Set(seenIds)).toEqual(
    new Set([
      `entity:${exactDocumentId}`,
      `entity:${prefixDocumentId}`,
      ...matterIds.map((id) => `matter:${id}`),
    ]),
  );
});
