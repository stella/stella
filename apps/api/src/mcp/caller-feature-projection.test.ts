import { panic } from "better-result";
import { expect, test } from "bun:test";
import { Elysia } from "elysia";

import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";
import { readCapabilityCatalog } from "@stll/cli/capability-catalog-data";

import type {
  legalListFactDetails,
  legalListItemSources,
} from "@/api/db/schema";
import readItems from "@/api/handlers/lists/items/list";
import readSources from "@/api/handlers/lists/items/sources/list";
import { toSafeId } from "@/api/lib/branded-types";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { isRecord } from "@/api/lib/type-guards";
import { synthesizeCapabilityContext } from "@/api/mcp/capability-context";
import { parseCatalog } from "@/api/mcp/capability-tools";
import type { McpRequestContext } from "@/api/mcp/context";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { modelViewOf } from "@/api/tests/helpers/mcp-model-view";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const matterId = "a1111111-1111-4111-8111-111111111111";
const listId = "a2222222-2222-4222-8222-222222222222";
const itemId = "a3333333-3333-4333-8333-333333333333";
const source = {
  id: toSafeId<"legalListItemSource">(itemId),
  sourceEntityId: toSafeId<"entity">(itemId),
  sourceEntityVersionId: toSafeId<"entityVersion">(itemId),
  locator: { type: "document" },
  quote: "Passage",
  verificationStatus: "verified",
  verifiedBy: "user_fixture",
  verifiedAt: new Date("2026-01-02T00:00:00Z"),
  createdAt: new Date("2026-01-01T00:00:00Z"),
} satisfies Pick<
  typeof legalListItemSources.$inferSelect,
  | "id"
  | "sourceEntityId"
  | "sourceEntityVersionId"
  | "locator"
  | "quote"
  | "verificationStatus"
  | "verifiedBy"
  | "verifiedAt"
  | "createdAt"
>;
const factDetails = {
  confidence: "high",
  occurredOn: null,
  occurredOnPrecision: null,
  evidenceKind: null,
  medium: null,
  interpretationNote: "Detail",
  scoring: "included",
} satisfies Pick<
  typeof legalListFactDetails.$inferSelect,
  | "confidence"
  | "occurredOn"
  | "occurredOnPrecision"
  | "evidenceKind"
  | "medium"
  | "interpretationNote"
  | "scoring"
>;
const contextFor = (granted: boolean, capability: string) => {
  const rows =
    capability === "lists.items.sources.list"
      ? [source]
      : [
          {
            id: itemId,
            name: "Fact item",
            position: "a",
            factDetails,
            firstSource: null,
          },
        ];
  const query = (selectedRows: unknown[]) => {
    const builder = {
      from: () => builder,
      where: () => builder,
      innerJoin: () => builder,
      leftJoin: () => builder,
      leftJoinLateral: () => builder,
      orderBy: () => builder,
      // oxlint-disable-next-line typescript/promise-function-async -- the builder double must return the Promise itself with its subquery .as(); async would wrap it
      limit: () =>
        Object.assign(Promise.resolve(selectedRows), {
          as: () => ({ documentId: null, documentName: null, locator: null }),
        }),
    };
    return builder;
  };
  const database = createScopedDbMock({
    select: (selection: Record<string, unknown>) =>
      query("propertyId" in selection ? [] : rows),
    query: {
      legalLists: { findFirst: async () => ({ id: listId }) },
      legalListItems: { findFirst: async () => ({ entityId: itemId }) },
    },
  });
  const organizationId = toSafeId<"organization">("org_fixture");
  const userId = toSafeId<"user">("user_fixture");
  const memberGrant = {
    type: "member",
    organizationId,
    email: "member@example.test",
  } as const;
  const context = {
    organizationId,
    userId,
    userEmail: "member@example.test",
    memberRole: "owner",
    request: new Request("http://localhost/mcp"),
    grantedScopes: ["stella:read"],
    accessibleWorkspaceIds: [toSafeId<"workspace">(matterId)],
    accessibleWorkspaceIdSet: new Set([matterId]),
    accessibleWorkspaceStatusById: new Map([[matterId, "active"]]),
    accessibleWorkspaces: [
      { id: toSafeId<"workspace">(matterId), status: "active" },
    ],
    scopedDb: database.scopedDb,
    safeDb: database.safeDb,
    createOperationDatabaseScope: () => ({
      scopedDb: database.scopedDb,
      safeDb: database.safeDb,
      pinServerValidatedWorkspaceId: (id: string) => id === matterId,
    }),
    recordAuditEvent: async () =>
      panic("Unexpected audit mutation in read fixture"),
    featureAccessSnapshot: createFeatureAccessSnapshot({
      organizationId,
      userId,
      decisions: new Map(
        [LEGAL_LISTS_FEATURE_ID, LIST_VERIFICATION_FEATURE_ID].map(
          (featureId) => [
            featureId,
            decideFeatureAccess({
              registry: FEATURE_REGISTRY,
              grants: {
                [LEGAL_LISTS_FEATURE_ID]: [memberGrant],
                ...(granted
                  ? { [LIST_VERIFICATION_FEATURE_ID]: [memberGrant] }
                  : {}),
              },
              featureId,
              organizationId,
              userId,
              user: { email: "member@example.test", emailVerified: true },
              membership: true,
            }),
          ],
        ),
      ),
    }),
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
  } satisfies McpRequestContext;
  return { context, database };
};
for (const transport of [
  "shared handler",
  "REST HTTP",
  "MCP capability",
] as const) {
  for (const capability of [
    "lists.items.sources.list",
    "lists.items.list",
  ] as const) {
    test.each([false, true])(
      `${transport} ${capability} projects caller fields (grant=%s)`,
      async (granted) => {
        const { context } = contextFor(granted, capability);
        const input = {
          body: {},
          params: {
            matterId,
            listId,
            ...(capability === "lists.items.sources.list"
              ? { itemEntityId: itemId }
              : {}),
          },
          query: {},
        };
        let result: unknown;
        if (transport === "MCP capability") {
          result = modelViewOf(
            await handleMcpToolCall({
              context,
              toolName: MCP_CAPABILITY_EXECUTORS.read,
              args: { capability, input },
            }),
          )["result"];
        } else {
          const synthesized = await synthesizeCapabilityContext({
            context,
            capabilityId: capability,
            request: context.request,
            workspaceId: toSafeId<"workspace">(matterId),
            input: {
              ...input,
              params: { ...input.params, workspaceId: matterId },
            },
          });
          const execute = async () => {
            switch (capability) {
              case "lists.items.sources.list":
                return await readSources.handler(
                  asTestRaw<Parameters<typeof readSources.handler>[0]>(
                    synthesized,
                  ),
                );
              case "lists.items.list":
                return await readItems.handler(
                  asTestRaw<Parameters<typeof readItems.handler>[0]>(
                    synthesized,
                  ),
                );
              default:
                capability satisfies never;
                return panic("Unexpected list capability");
            }
          };
          if (transport === "REST HTTP") {
            const featureAccessSnapshot = synthesized.featureAccessSnapshot;
            if (featureAccessSnapshot === undefined) {
              panic("Missing feature access snapshot in HTTP fixture");
            }
            const app = new Elysia().resolve(() => ({
              workspaceId: toSafeId<"workspace">(matterId),
              user: synthesized.user,
              session: synthesized.session,
              featureAccessSnapshot,
              safeDb: synthesized.safeDb,
              scopedDb: synthesized.scopedDb,
              getActiveWorkspaceIds: synthesized.getActiveWorkspaceIds,
              getAccessibleWorkspaces: synthesized.getAccessibleWorkspaces,
              getWorkspaceAccess: synthesized.getWorkspaceAccess,
              pinServerValidatedWorkspaceId:
                synthesized.pinServerValidatedWorkspaceId,
              memberRole: synthesized.memberRole,
              orgAIConfig: synthesized.orgAIConfig,
              orgAIConfigStatus: synthesized.orgAIConfigStatus,
              promptCachingEnabled: synthesized.promptCachingEnabled,
              managedAIResidency: synthesized.managedAIResidency,
              recordAuditEvent: synthesized.recordAuditEvent,
              createAuditRecorder: synthesized.createAuditRecorder,
            }));
            const route =
              capability === "lists.items.sources.list"
                ? app.get(
                    "/lists/:workspaceId/:listId/items/:itemEntityId/sources",
                    readSources.handler,
                    {
                      params: readSources.config.params,
                      query: readSources.config.query,
                    },
                  )
                : app.get(
                    "/lists/:workspaceId/:listId/items",
                    readItems.handler,
                    {
                      params: readItems.config.params,
                      query: readItems.config.query,
                    },
                  );
            const url = `http://localhost/lists/${matterId}/${listId}/items${
              capability === "lists.items.sources.list"
                ? `/${itemId}/sources`
                : ""
            }`;
            const response = await route.handle(new Request(url));
            expect(response.status).toBe(200);
            result = await response.json();
          } else {
            result = await execute();
          }
        }
        const serialized = JSON.stringify(result);
        const wireResult: unknown = JSON.parse(serialized);
        expect(wireResult).toMatchObject({
          items: [
            capability === "lists.items.sources.list"
              ? {
                  id: source.id,
                  quote: source.quote,
                  sourceEntityId: source.sourceEntityId,
                }
              : {
                  id: itemId,
                  name: "Fact item",
                  factDetails: {
                    confidence: factDetails.confidence,
                    interpretationNote: factDetails.interpretationNote,
                  },
                },
          ],
        });
        for (const field of capability === "lists.items.sources.list"
          ? ["verificationStatus", "verifiedBy", "verifiedAt"]
          : ["scoring"]) {
          expect(serialized.includes(`"${field}":`)).toBe(granted);
        }
        if (granted) {
          expect(wireResult).toMatchObject({
            items: [
              capability === "lists.items.sources.list"
                ? {
                    ...source,
                    createdAt: source.createdAt.toISOString(),
                    verifiedAt: source.verifiedAt.toISOString(),
                  }
                : { factDetails },
            ],
          });
        }
      },
    );
  }
}
const requiredCapabilities = parseCatalog(readCapabilityCatalog()).filter(
  (entry) =>
    "featureId" in entry &&
    entry.featureId === LIST_VERIFICATION_FEATURE_ID &&
    "featureAccess" in entry &&
    entry.featureAccess === "required",
);
for (const { id, access } of requiredCapabilities) {
  test(`${id} uses the unknown-id contract for hidden capability meta calls`, async () => {
    const { context, database } = contextFor(false, id);
    const results = [];
    const executor = MCP_CAPABILITY_EXECUTORS[access];
    for (const toolName of ["describe_capability", executor] as const) {
      const result = await handleMcpToolCall({
        context,
        toolName,
        args: {
          capability: id,
          ...(toolName === executor ? { input: {} } : {}),
        },
      });
      expect(result.isError).toBe(true);
      const block = result.content.at(0);
      expect(block?.type).toBe("text");
      if (block?.type !== "text") {
        panic("Expected a text error envelope");
      }
      const payload: unknown = JSON.parse(block.text);
      if (!isRecord(payload) || !isRecord(payload["error"])) {
        panic("Expected an error object");
      }
      expect(payload["error"]).toEqual({
        code: "not_found",
        message: `No capability with id "${id}"`,
        hint: expect.any(String),
      });
      for (const hidden of requiredCapabilities) {
        expect(payload["error"]["hint"]).not.toContain(`"${hidden.id}"`);
      }
      results.push(result);
    }
    expect(results.at(0)).toEqual(results.at(1));
    expect(database.getCallCount()).toBe(0);
  });
}

test("shared list descriptions follow caller discovery", async () => {
  const granted = contextFor(true, "lists.items.list").context;
  const hidden = contextFor(false, "lists.items.list").context;
  for (const capability of ["lists.items.list", "lists.items.sources.list"]) {
    const descriptions = [];
    for (const context of [granted, hidden]) {
      const described = modelViewOf(
        await handleMcpToolCall({
          context,
          toolName: "describe_capability",
          args: { capability },
        }),
      );
      descriptions.push(described["description"]);
      expect(JSON.stringify(described)).not.toMatch(
        /scoring|verification status|verifiedBy|verifiedAt/iu,
      );
    }
    expect(descriptions.at(0)).toEqual(descriptions.at(1));
  }
});

test("conditional view schemas follow caller discovery", async () => {
  const granted = contextFor(true, "lists.items.list").context;
  const hidden = contextFor(false, "lists.items.list").context;
  let projected = 0;
  for (const { id } of parseCatalog(readCapabilityCatalog()).filter(
    (entry) =>
      "featureId" in entry &&
      entry.featureId === LIST_VERIFICATION_FEATURE_ID &&
      "featureAccess" in entry &&
      entry.featureAccess === "conditional",
  )) {
    const enabled = modelViewOf(
      await handleMcpToolCall({
        context: granted,
        toolName: "describe_capability",
        args: { capability: id },
      }),
    );
    const denied = modelViewOf(
      await handleMcpToolCall({
        context: hidden,
        toolName: "describe_capability",
        args: { capability: id },
      }),
    );
    if (JSON.stringify(enabled).includes('"avt"')) {
      projected += 1;
    }
    expect(JSON.stringify(denied)).not.toContain('"avt"');
  }
  expect(projected).toBeGreaterThan(0);
});
