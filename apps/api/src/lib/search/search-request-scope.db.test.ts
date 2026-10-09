import { panic, Result } from "better-result";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, organization, user } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  fields,
  featureEnrolments,
  flowRuns,
  flowRunSteps,
  properties,
  searchDocuments,
  workspaceMembers,
  workspaces,
  workspaceSearchDocuments,
} from "@/api/db/schema";
import { createMembershipScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { readEntityByIdHandler } from "@/api/handlers/entities/get";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { searchGlobal, searchGlobalFacet } from "@/api/lib/search/index-global";
import type {
  GlobalFacetSearchQuery,
  GlobalSearchQuery,
} from "@/api/lib/search/index-global";
import { createPgFtsSearchReader } from "@/api/lib/search/pg-fts-provider";
import { readSearchPreview } from "@/api/lib/search/preview";
import type { FacetBucket, GlobalSearchHit } from "@/api/lib/search/types";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { executeRowsScopedDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
import { createTestState } from "@/api/tests/helpers/test-state";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

const testState = createTestState({ file: import.meta.path, config: env });

let testDb: TestDatabase;

const organizationId = mintAuthProviderId<"organization">();
const otherOrganizationId = mintAuthProviderId<"organization">();

const viewer = mintAuthProviderId<"user">();
const colleague = mintAuthProviderId<"user">();
/** Live account whose membership in the organization has ended. */
const departed = mintAuthProviderId<"user">();
/** Live account with no tie to the organization. */
const unrelated = mintAuthProviderId<"user">();
const deletedContributor = mintAuthProviderId<"user">();
/** Organization member who belongs to no matter. */
const newcomer = mintAuthProviderId<"user">();

const openMatter = createSafeId<"workspace">();
const secondMatter = createSafeId<"workspace">();
/** Same organization, outside the viewer's matters. */
const closedMatter = createSafeId<"workspace">();

const documentBy = {
  self: createSafeId<"entity">(),
  colleague: createSafeId<"entity">(),
  departed: createSafeId<"entity">(),
  unrelated: createSafeId<"entity">(),
  deletedContributor: createSafeId<"entity">(),
  nobody: createSafeId<"entity">(),
  closedMatter: createSafeId<"entity">(),
};

const displayNames = new Map<string, string>([
  [viewer, "Viewer"],
  [colleague, "Colleague"],
  [departed, "Departed"],
  [unrelated, "Unrelated"],
  [deletedContributor, "Deleted contributor"],
  [newcomer, "Newcomer"],
]);

const displayName = (userId: string): string =>
  displayNames.get(userId) ?? panic(`No fixture name for ${userId}`);

const imageOf = (userId: string) => `https://example.test/${userId}.png`;

type DocumentFixture = {
  id: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  title: string;
  lastEditedBy: SafeId<"user"> | null;
};

const documentFixtures: DocumentFixture[] = [
  {
    id: documentBy.self,
    workspaceId: openMatter,
    title: "Self memo",
    lastEditedBy: viewer,
  },
  {
    id: documentBy.colleague,
    workspaceId: openMatter,
    title: "Colleague memo",
    lastEditedBy: colleague,
  },
  {
    id: documentBy.departed,
    workspaceId: openMatter,
    title: "Departed memo",
    lastEditedBy: departed,
  },
  {
    id: documentBy.unrelated,
    workspaceId: openMatter,
    title: "Unrelated memo",
    lastEditedBy: unrelated,
  },
  {
    id: documentBy.deletedContributor,
    workspaceId: openMatter,
    title: "Deleted contributor memo",
    lastEditedBy: deletedContributor,
  },
  {
    id: documentBy.nobody,
    workspaceId: secondMatter,
    title: "Unedited memo",
    lastEditedBy: null,
  },
  {
    id: documentBy.closedMatter,
    workspaceId: closedMatter,
    title: "Closed memo",
    lastEditedBy: colleague,
  },
];

const visibleDocumentIds = documentFixtures
  .filter((document) => document.workspaceId !== closedMatter)
  .map((document) => document.id)
  .toSorted();

/** The request handle production auth builds for a signed-in member. */
const requestScope = (userId: SafeId<"user">): ScopedDb =>
  executeRowsScopedDb(
    createMembershipScopedDb(testDb, {
      organizationId,
      serverValidatedWorkspaceIds: [],
      userId,
    }),
  );

/** The owner connection, which reads without the row policies. */
const ownerHandle = (): ScopedDb =>
  executeRowsScopedDb(async (fn) => await testDb.transaction(fn));

const documentQuery = (
  overrides: Partial<GlobalSearchQuery> = {},
): GlobalSearchQuery => ({
  query: "",
  organizationId,
  userId: viewer,
  accessibleWorkspaceIds: [openMatter, secondMatter],
  selectedWorkspaceIds: [],
  types: ["document"],
  editedByUserIds: [],
  mimeTypes: [],
  limit: 50,
  ...overrides,
});

const facetQuery = (
  facet: GlobalFacetSearchQuery["facet"],
  overrides: Partial<GlobalFacetSearchQuery> = {},
): GlobalFacetSearchQuery => ({
  facet,
  search: "",
  query: "",
  organizationId,
  userId: viewer,
  accessibleWorkspaceIds: [openMatter, secondMatter],
  selectedWorkspaceIds: [],
  types: ["document"],
  editedByUserIds: [],
  mimeTypes: [],
  limit: 50,
  ...overrides,
});

// Public case law is read by its own reader; these tests cover tenant rows.
const noLanguageAlternates = async () =>
  await Promise.resolve({ alternatesFor: () => [] });

const search = async (scopedDb: ScopedDb, query: GlobalSearchQuery) =>
  await searchGlobal(query, {
    scopedDb,
    readLanguageAlternates: noLanguageAlternates,
  });

const entityHitsById = (hits: readonly GlobalSearchHit[]) =>
  new Map(
    hits.flatMap((hit) =>
      "entityId" in hit && "lastEditedByName" in hit
        ? [[hit.entityId, hit] as const]
        : [],
    ),
  );

const bucketValues = (buckets: readonly FacetBucket[]) =>
  buckets.map((bucket) => bucket.value).toSorted();

testState.beforeAll(async () => {
  testDb = await getTestDb();

  await testDb.insert(user).values(
    [viewer, colleague, departed, unrelated, deletedContributor, newcomer].map(
      (id) => ({
        id,
        name: displayName(id),
        email: `${id}@test.local`,
        image: imageOf(id),
        deletedAt: id === deletedContributor ? new Date() : null,
      }),
    ),
  );
  await testDb.insert(organization).values([
    {
      id: organizationId,
      name: "Scope org",
      slug: `scope-${organizationId}`,
      createdAt: new Date(),
    },
    {
      id: otherOrganizationId,
      name: "Other org",
      slug: `other-${otherOrganizationId}`,
      createdAt: new Date(),
    },
  ]);
  await testDb.insert(member).values(
    (
      [
        [viewer, organizationId],
        [colleague, organizationId],
        [newcomer, organizationId],
        [departed, otherOrganizationId],
      ] as const
    ).map(([userId, memberOrganizationId]) => ({
      id: mintAuthProviderIdValue(),
      userId,
      organizationId: memberOrganizationId,
      role: "member",
      createdAt: new Date(),
    })),
  );
  await testDb.insert(workspaces).values(
    [openMatter, secondMatter, closedMatter].map((id, index) => ({
      id,
      organizationId,
      name: `Matter ${index}`,
      reference: `SCOPE-${index}-${id}`,
      status: "active" as const,
    })),
  );
  await testDb.insert(workspaceMembers).values(
    (
      [
        [openMatter, viewer],
        [secondMatter, viewer],
        [openMatter, colleague],
        [closedMatter, colleague],
      ] as const
    ).map(([workspaceId, userId]) => ({
      id: createSafeId<"workspaceMember">(),
      workspaceId,
      userId,
    })),
  );
  await testDb.insert(workspaceSearchDocuments).values(
    [openMatter, closedMatter].map((workspaceId) => ({
      workspaceId,
      organizationId,
      title: `Matter ${workspaceId}`,
    })),
  );

  await testDb.insert(entities).values(
    documentFixtures.map((document) => ({
      id: document.id,
      workspaceId: document.workspaceId,
      kind: "document" as const,
      name: document.title,
      lastEditedBy: document.lastEditedBy,
    })),
  );
  for (const document of documentFixtures) {
    const versionId = createSafeId<"entityVersion">();
    await testDb.insert(entityVersions).values({
      id: versionId,
      workspaceId: document.workspaceId,
      entityId: document.id,
    });
    await testDb
      .update(entities)
      .set({ currentVersionId: versionId })
      .where(sql`${entities.id} = ${document.id}`);
  }
  await testDb.insert(searchDocuments).values(
    documentFixtures.map((document) => ({
      entityId: document.id,
      organizationId,
      workspaceId: document.workspaceId,
      kind: "document" as const,
      title: document.title,
      searchableText: document.title.toLowerCase(),
      tsv: sql`to_tsvector('simple', ${document.title})`,
    })),
  );
});

afterAll(async () => {
  await releaseTestDb();
});

describe("search reads follow the request scope", () => {
  test("retained review tasks stay hidden across current reads, search, facets and previews before pagination", async () => {
    const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    testState.setConfig("FEATURE_FLOWS", true);
    const runId = createSafeId<"flowRun">();
    const ordinary = createSafeId<"entity">();
    const hidden = Array.from({ length: 32 }, () => createSafeId<"entity">());
    const hiddenId = hidden.at(0) ?? panic("Missing planted review task");
    const taskIds = [ordinary, ...hidden];
    const scopedDb = requestScope(viewer);
    try {
      await testDb.insert(entities).values(
        taskIds.map(
          (id) =>
            ({
              id,
              workspaceId: openMatter,
              kind: "task",
              name:
                id === ordinary
                  ? "Flowboundary ordinary"
                  : "Flowboundary review",
              lastEditedBy: id === ordinary ? viewer : colleague,
            }) satisfies typeof entities.$inferInsert,
        ),
      );
      const versions = taskIds.map((entityId) => ({
        id: createSafeId<"entityVersion">(),
        entityId,
        workspaceId: openMatter,
      }));
      await testDb.insert(entityVersions).values(versions);
      for (const version of versions) {
        // db-await-in-loop: each planted entity receives its own current-version pointer.
        await testDb
          .update(entities)
          .set({ currentVersionId: version.id })
          .where(eq(entities.id, version.entityId));
      }
      await testDb.insert(flowRuns).values({
        id: runId,
        workspaceId: openMatter,
        definitionSnapshot: { name: "Review boundary", steps: [] },
        triggerSource: { type: "manual", userId: viewer },
        status: "awaiting_review",
      });
      await testDb.insert(flowRunSteps).values(
        hidden.map(
          (reviewTaskEntityId, index) =>
            ({
              id: createSafeId<"flowRunStep">(),
              runId,
              workspaceId: openMatter,
              index,
              kind: "review-gate",
              status: "awaiting_review",
              reviewTaskEntityId,
            }) satisfies typeof flowRunSteps.$inferInsert,
        ),
      );
      await testDb.insert(searchDocuments).values(
        taskIds.map(
          (entityId) =>
            ({
              entityId,
              organizationId,
              workspaceId: openMatter,
              kind: "task",
              title:
                entityId === ordinary
                  ? "Flowboundary ordinary"
                  : "Flowboundary review",
              searchableText: "flowboundary",
              tsv: sql`to_tsvector('simple', 'flowboundary')`,
              updatedAt: new Date(
                entityId === ordinary
                  ? "2029-01-01T00:00:00Z"
                  : "2030-01-01T00:00:00Z",
              ),
            }) satisfies typeof searchDocuments.$inferInsert,
        ),
      );
      const query = documentQuery({
        query: "flowboundary",
        types: ["task"],
        limit: 1,
      });
      const page = await search(scopedDb, query);
      expect(page.hits.map((hit) => hit.id)).toEqual([`entity:${ordinary}`]);
      expect(page.totalCount).toBe(1);
      expect(page.nextCursor).toBeNull();
      const facets = await searchGlobalFacet(
        facetQuery("editor", { query: "flowboundary", types: ["task"] }),
        scopedDb,
      );
      expect(bucketValues(facets.buckets)).toEqual([viewer]);
      const native = await createPgFtsSearchReader(scopedDb).search({
        query: "flowboundary",
        organizationId,
        userId: viewer,
        workspaceId: openMatter,
        kinds: ["task"],
        limit: 1,
      });
      expect(native.hits.map((hit) => hit.entityId)).toEqual([ordinary]);
      expect(native.totalCount).toBe(1);
      const preview = await readSearchPreview(
        {
          query: "",
          resultId: hiddenId,
          type: "task",
          organizationId,
          userId: viewer,
          accessibleWorkspaceIds: [openMatter],
        },
        scopedDb,
      );
      expect(preview).toBeNull();
      const get = await Result.gen(() =>
        readEntityByIdHandler({
          safeDb: toSafeDbMock(scopedDb),
          workspaceId: openMatter,
          userId: viewer,
          entityId: hiddenId,
        }),
      );
      expect(get.isErr()).toBe(true);
      if (get.isErr()) {
        expect(get.error).toMatchObject({ status: 404 });
      }
      await testDb
        .update(user)
        .set({ emailVerified: true })
        .where(eq(user.id, viewer));
      await testDb
        .insert(featureEnrolments)
        .values({ organizationId, userId: viewer, featureId: "flows" });
      const granted = await search(
        scopedDb,
        documentQuery({ query: "flowboundary", types: ["task"], limit: 50 }),
      );
      expect(granted.totalCount).toBe(taskIds.length);
      expect(granted.hits).toHaveLength(taskIds.length);
      const grantedGet = await Result.gen(() =>
        readEntityByIdHandler({
          safeDb: toSafeDbMock(scopedDb),
          workspaceId: openMatter,
          userId: viewer,
          entityId: hiddenId,
        }),
      );
      expect(grantedGet.isOk()).toBe(true);
    } finally {
      await testDb
        .delete(featureEnrolments)
        .where(eq(featureEnrolments.userId, viewer));
      await testDb
        .update(user)
        .set({ emailVerified: false })
        .where(eq(user.id, viewer));
      await testDb.delete(flowRuns).where(eq(flowRuns.id, runId));
      await testDb.delete(entities).where(inArray(entities.id, taskIds));
      restore();
    }
  });
  test("search results show an editor profile only where the caller may see it", async () => {
    const [scoped, owner] = await Promise.all([
      search(requestScope(viewer), documentQuery()),
      search(ownerHandle(), documentQuery()),
    ]);
    const hits = entityHitsById(scoped.hits);
    const ownerHits = entityHitsById(owner.hits);
    const editorOf = (entityId: string) => {
      const hit = hits.get(entityId);
      return hit === undefined
        ? undefined
        : { name: hit.lastEditedByName, image: hit.lastEditedByImage };
    };

    // No document is dropped for its editor.
    expect([...hits.keys()].toSorted()).toEqual(visibleDocumentIds);
    expect(editorOf(documentBy.self)).toEqual({
      name: displayName(viewer),
      image: imageOf(viewer),
    });
    expect(editorOf(documentBy.colleague)).toEqual({
      name: displayName(colleague),
      image: imageOf(colleague),
    });
    expect(editorOf(documentBy.departed)).toEqual({ name: null, image: null });
    expect(editorOf(documentBy.unrelated)).toEqual({ name: null, image: null });
    expect(editorOf(documentBy.nobody)).toEqual({ name: null, image: null });
    const ownerDeleted = ownerHits.get(documentBy.deletedContributor);
    expect(editorOf(documentBy.deletedContributor)).toEqual({
      name: ownerDeleted?.lastEditedByName ?? null,
      image: ownerDeleted?.lastEditedByImage ?? null,
    });
    expect(ownerDeleted?.lastEditedByName).toBe(
      displayName(deletedContributor),
    );
  });

  test("search editor facets follow profile visibility", async () => {
    const scopedDb = requestScope(viewer);
    const [result, editorFacet, ownerResult] = await Promise.all([
      search(scopedDb, documentQuery()),
      searchGlobalFacet(facetQuery("editor"), scopedDb),
      search(ownerHandle(), documentQuery()),
    ]);
    const expectedEditors = [viewer, colleague, deletedContributor].toSorted();

    expect(bucketValues(result.facets.editor)).toEqual(expectedEditors);
    expect(bucketValues(editorFacet.buckets)).toEqual(expectedEditors);
    for (const bucket of [...result.facets.editor, ...editorFacet.buckets]) {
      expect(bucket.count).toBe(1);
    }
    // A deleted contributor's bucket is the one the owner connection builds.
    const deletedBucket = (buckets: readonly FacetBucket[]) =>
      buckets.find((bucket) => bucket.value === deletedContributor);
    expect(deletedBucket(editorFacet.buckets)).toEqual(
      deletedBucket(ownerResult.facets.editor),
    );
  });

  test("the editor facet search box matches visible profiles only", async () => {
    const scopedDb = requestScope(viewer);
    const [departedMatch, colleagueMatch] = await Promise.all([
      searchGlobalFacet(facetQuery("editor", { search: "Departed" }), scopedDb),
      searchGlobalFacet(
        facetQuery("editor", { search: "Colleague" }),
        scopedDb,
      ),
    ]);

    expect(departedMatch.buckets).toEqual([]);
    expect(bucketValues(colleagueMatch.buckets)).toEqual([colleague]);
  });

  test("a member's authorized document set matches the owner connection", async () => {
    const [scoped, owner] = await Promise.all([
      search(requestScope(viewer), documentQuery()),
      search(ownerHandle(), documentQuery()),
    ]);

    expect(scoped.hits.map((hit) => hit.id).toSorted()).toEqual(
      owner.hits.map((hit) => hit.id).toSorted(),
    );
    expect(scoped.totalCount).toBe(owner.totalCount);
    expect(scoped.totalCount).toBe(visibleDocumentIds.length);
    expect(scoped.facets.type).toEqual(owner.facets.type);
    expect(scoped.facets.workspace).toEqual(owner.facets.workspace);
    expect(scoped.facets.mimeType).toEqual(owner.facets.mimeType);
  });

  test("a matter outside the caller's access stays excluded", async () => {
    const scopedDb = requestScope(viewer);
    // Even a caller-side allowlist naming the matter cannot reach it.
    const widened = [openMatter, secondMatter, closedMatter];
    const [result, workspaceFacet, preview, ftsPage] = await Promise.all([
      search(
        scopedDb,
        documentQuery({ accessibleWorkspaceIds: widened, types: [] }),
      ),
      searchGlobalFacet(
        facetQuery("workspace", {
          accessibleWorkspaceIds: widened,
          types: [],
        }),
        scopedDb,
      ),
      readSearchPreview(
        {
          query: "",
          resultId: documentBy.closedMatter,
          type: "document",
          organizationId,
          userId: viewer,
          accessibleWorkspaceIds: widened,
        },
        scopedDb,
      ),
      createPgFtsSearchReader(scopedDb).search({
        query: "memo",
        organizationId,
        userId: viewer,
        workspaceIds: widened,
        limit: 50,
      }),
    ]);

    const hitIds = result.hits.map((hit) => hit.id);
    expect(hitIds).not.toContain(`entity:${documentBy.closedMatter}`);
    expect(hitIds).not.toContain(`matter:${closedMatter}`);
    expect(hitIds).toContain(`matter:${openMatter}`);
    expect(bucketValues(workspaceFacet.buckets)).toEqual(
      [openMatter, secondMatter].toSorted(),
    );
    expect(preview).toBeNull();
    expect(ftsPage.hits.map((hit) => hit.entityId).toSorted()).toEqual(
      visibleDocumentIds,
    );
  });

  test("previews and passage search read the caller's documents", async () => {
    const scopedDb = requestScope(viewer);
    const [preview, content] = await Promise.all([
      readSearchPreview(
        {
          query: "",
          resultId: documentBy.departed,
          type: "document",
          organizationId,
          userId: viewer,
          accessibleWorkspaceIds: [openMatter, secondMatter],
        },
        scopedDb,
      ),
      createPgFtsSearchReader(scopedDb).searchContent({
        query: "memo",
        organizationId,
        userId: viewer,
        workspaceId: openMatter,
        limit: 50,
      }),
    ]);

    expect(preview).not.toBeNull();
    expect(content.totalCount).toBe(5);
  });

  test("an empty scope fails closed", async () => {
    const [emptyAllowlist, noMatters, emptyFacet, emptyFts] = await Promise.all(
      [
        search(
          requestScope(viewer),
          documentQuery({ accessibleWorkspaceIds: [], types: [] }),
        ),
        // An organization member without matters: the policies hide every
        // matter row even when the caller-side allowlist names one.
        search(
          requestScope(newcomer),
          documentQuery({
            userId: newcomer,
            accessibleWorkspaceIds: [openMatter],
            types: [],
          }),
        ),
        searchGlobalFacet(
          facetQuery("editor", { accessibleWorkspaceIds: [openMatter] }),
          requestScope(newcomer),
        ),
        createPgFtsSearchReader(requestScope(newcomer)).search({
          query: "memo",
          organizationId,
          userId: newcomer,
          workspaceIds: [openMatter],
          limit: 50,
        }),
      ],
    );

    for (const result of [emptyAllowlist, noMatters]) {
      expect(result.hits.filter((hit) => hit.type !== "case-law")).toEqual([]);
      expect(result.facets.editor).toEqual([]);
      expect(result.facets.workspace).toEqual([]);
    }
    expect(emptyFacet.buckets).toEqual([]);
    expect(emptyFts.hits).toEqual([]);
    expect(emptyFts.totalCount).toBe(0);
  });

  test("file fields accept non-JSON string content", async () => {
    const [document] = await testDb
      .select({ versionId: entities.currentVersionId })
      .from(entities)
      .where(eq(entities.id, documentBy.self));
    const versionId = document?.versionId;
    if (!versionId) {
      panic("Expected the document's current version.");
    }

    const propertyId = createSafeId<"property">();
    const fieldId = createSafeId<"field">();
    await testDb.insert(properties).values({
      id: propertyId,
      workspaceId: openMatter,
      name: "Stored text",
      status: "fresh",
      content: { version: 1, type: "file" },
      tool: { version: 1, type: "manual-input" },
    });
    await testDb.insert(fields).values({
      id: fieldId,
      workspaceId: openMatter,
      propertyId,
      entityVersionId: versionId,
      content: sql`to_jsonb('not-json'::text)`,
    });
    await testDb
      .update(fields)
      .set({ content: sql`to_jsonb('still-not-json'::text)` })
      .where(eq(fields.id, fieldId));
    await testDb.delete(fields).where(eq(fields.id, fieldId));
    await testDb.delete(properties).where(eq(properties.id, propertyId));
  });
});
