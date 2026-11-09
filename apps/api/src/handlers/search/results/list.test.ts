import { panic } from "better-result";
import { beforeEach, describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";

import searchFacets from "@/api/handlers/search/facets/list";
import searchResults from "@/api/handlers/search/results/list";
import { toSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { GlobalSearchResultType } from "@/api/lib/search/types";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { authorizedMcpContextForTest } from "@/api/tests/helpers/authorized-mcp-context";
import { modelViewOf } from "@/api/tests/helpers/mcp-model-view";
import {
  clearRootDbMocks,
  rootDbExecuteMock,
  rootDbTestDouble,
} from "@/api/tests/helpers/mock-root-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const organizationId = toSafeId<"organization">("org_1");
const userId = toSafeId<"user">("user_1");
const workspaceId = toSafeId<"workspace">(
  "a1111111-1111-4111-8111-111111111111",
);
const { scopedDb, safeDb } = createScopedDbMock(rootDbTestDouble);

const dialect = new PgDialect();
const executedSql = () =>
  rootDbExecuteMock.mock.calls.map(([query]) => dialect.sqlToQuery(query).sql);
// The one source chat hits and chat counts are read from.
const readChat = () =>
  executedSql().some((sql) =>
    sql.includes("FROM chat_thread_search_documents cst"),
  );

const filters = (types: GlobalSearchResultType[]) => ({
  query: "lease",
  types,
  kinds: [],
  editedByUserIds: [],
  mimeTypes: [],
});

const callers = [
  { name: "a stella:read token", scopes: ["stella:read"], seesChat: false },
  {
    name: "a stella:read and stella:chat token",
    scopes: ["stella:read", "stella:chat"],
    seesChat: true,
  },
  { name: "a browser session", scopes: undefined, seesChat: true },
] as const;

// Every type, chat alone, and another type whose text search also counts
// the types it left out.
const typeSelections: { types: GlobalSearchResultType[] }[] = [
  { types: [] },
  { types: ["chat"] },
  { types: ["document"] },
];

const restContext = (
  grantedScopes: readonly string[] | undefined,
  body: Record<string, unknown>,
) => ({
  body,
  request: new Request("https://example.test/v1/search", { method: "POST" }),
  route: "/v1/search",
  getActiveWorkspaceIds: async () => await Promise.resolve([workspaceId]),
  scopedDb,
  safeDb,
  memberRole: sessionMemberRole("owner"),
  session: {
    activeOrganizationId: organizationId,
    ...(grantedScopes === undefined ? {} : { grantedScopes }),
  },
  user: { id: userId },
  orgAIConfig: null,
});

const mcpContext = (grantedScopes: readonly string[]) =>
  authorizedMcpContextForTest({
    organizationId,
    userId,
    userEmail: "member@example.test",
    memberRole: "owner",
    request: new Request("http://localhost/mcp"),
    grantedScopes,
    accessibleWorkspaceIds: [workspaceId],
    accessibleWorkspaceIdSet: new Set([workspaceId]),
    accessibleWorkspaceStatusById: new Map([[workspaceId, "active"]]),
    accessibleWorkspaces: [{ id: workspaceId, status: "active" }],
    scopedDb,
    safeDb,
    createOperationDatabaseScope: () => ({
      scopedDb,
      safeDb,
      pinServerValidatedWorkspaceId: (id: string) => id === workspaceId,
    }),
    recordAuditEvent: async () =>
      panic("Unexpected audit mutation in a search read"),
    testDependencies: {
      isCapabilityFeatureEnabled: () => true,
      consumeInvokeCapabilityRateLimit: async () => ({
        ok: true,
        retryAfterSeconds: 60,
      }),
      loadOrgSettingsForAuth: async () => ({
        orgAIConfig: null,
        orgAIConfigStatus: "ok",
        managedAIResidency: "eu",
        promptCachingEnabled: false,
      }),
    },
  });

beforeEach(() => {
  clearRootDbMocks();
});

describe("search results follow the caller's granted scopes", () => {
  for (const { name, scopes, seesChat } of callers) {
    test.each(typeSelections)(
      `REST: ${name} ${seesChat ? "reads" : "never reads"} chat (types $types)`,
      async ({ types }) => {
        const result = await searchResults.handler(
          asTestRaw<Parameters<typeof searchResults.handler>[0]>(
            restContext(scopes, {
              ...filters(types),
              workspaceIds: [],
              limit: LIMITS.searchPageSizeDefault,
            }),
          ),
        );

        expect(result).toMatchObject({ hits: [] });
        expect(readChat()).toBe(seesChat);
      },
    );
  }

  for (const { name, scopes, seesChat } of callers) {
    if (scopes === undefined) {
      continue;
    }
    test.each(typeSelections)(
      `MCP read_capability: ${name} ${seesChat ? "reads" : "never reads"} chat (types $types)`,
      async ({ types }) => {
        const result = modelViewOf(
          await handleMcpToolCall({
            mode: "advanced",
            context: mcpContext(scopes),
            toolName: MCP_CAPABILITY_EXECUTORS.read,
            args: {
              capability: "search.results.list",
              // An MCP caller names matters `matterIds`.
              input: {
                body: { ...filters(types), matterIds: [] },
                params: {},
                query: {},
              },
            },
          }),
        );

        expect(result["result"]).toMatchObject({ hits: [] });
        expect(readChat()).toBe(seesChat);
      },
    );
  }
});

describe("the type facet follows the caller's granted scopes", () => {
  for (const { name, scopes, seesChat } of callers) {
    test(`${name} ${seesChat ? "gets" : "never gets"} a chat bucket`, async () => {
      // Every source finds two matches, so each permitted type has a bucket.
      rootDbExecuteMock.mockImplementation(async (query) =>
        dialect.sqlToQuery(query).sql.includes("AS total")
          ? await Promise.resolve([{ total: 2 }])
          : await Promise.resolve([]),
      );

      const result = await searchResults.handler(
        asTestRaw<Parameters<typeof searchResults.handler>[0]>(
          restContext(scopes, {
            ...filters([]),
            workspaceIds: [],
            limit: LIMITS.searchPageSizeDefault,
          }),
        ),
      );

      const visibleTypes: GlobalSearchResultType[] = seesChat
        ? ["case-law", "chat", "contact", "matter"]
        : ["case-law", "contact", "matter"];
      expect(result).toMatchObject({
        facets: { type: visibleTypes.map((value) => ({ value, count: 2 })) },
      });
      expect(readChat()).toBe(seesChat);
    });
  }
});

describe("search facets follow the caller's granted scopes", () => {
  const facetBody = (types: GlobalSearchResultType[]) => ({
    facet: "workspace",
    search: "",
    ...filters(types),
    workspaceIds: [],
    limit: 20,
  });

  test("a stella:read token asking only for chat gets no buckets and reads nothing", async () => {
    const result = await searchFacets.handler(
      asTestRaw<Parameters<typeof searchFacets.handler>[0]>(
        restContext(["stella:read"], facetBody(["chat"])),
      ),
    );

    expect(result).toEqual({ buckets: [] });
    expect(executedSql()).toEqual([]);
  });

  test("a stella:read token still reads the buckets of the types it may see", async () => {
    const result = await searchFacets.handler(
      asTestRaw<Parameters<typeof searchFacets.handler>[0]>(
        restContext(["stella:read"], facetBody([])),
      ),
    );

    expect(result).toEqual({ buckets: [] });
    expect(executedSql()).toHaveLength(1);
    expect(readChat()).toBe(false);
  });
});
