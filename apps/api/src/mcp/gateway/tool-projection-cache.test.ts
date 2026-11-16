import type { Tool as McpTool } from "@modelcontextprotocol/server";
import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { readPresent, readUnavailable } from "@/api/lib/errors/read-outcome";
import { createFeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import { MCP_DEFAULT_RESOURCE_SCOPES, type McpMode } from "@/api/mcp/constants";
import type { McpRequestResources } from "@/api/mcp/context";
import {
  hiddenMcpDescriptorIds,
  scopeMcpDescriptorProse,
  scopeSchemaAnnotations,
} from "@/api/mcp/feature-access-prose";
import {
  listGatewayMcpToolDefinitions,
  resolveMcpToolOutputContract,
  toMcpTools,
} from "@/api/mcp/gateway/list-tools";
import {
  hasGrantedScope,
  resolveOfferedRegistrySlugs,
} from "@/api/mcp/gateway/static-tool-visibility";
import { listMcpResources } from "@/api/mcp/resources";
import { createMcpHttpRequestHandler } from "@/api/mcp/server-core";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  listStaticMcpToolDefinitions,
  REGISTERED_MCP_TOOL_NAMES,
} from "@/api/mcp/static-tool-definitions";
import { TEMPLATE_WORKFLOW_REFERENCE_URI } from "@/api/mcp/template-workflow-reference";
import type { McpToolDefinition } from "@/api/mcp/tool-types";
import {
  getMcpToolDefinition,
  getMcpToolRequiredScopesHint,
  handleMcpToolCall,
  listMcpTools,
} from "@/api/mcp/tools";
import { asTestRaw, readTestJson } from "@/api/tests/helpers/test-tool-set";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";

// Hidden when bound: nobody in these tests is enrolled in it.
const UNENROLLED_FEATURE_ID = "legal-lists";

type PrincipalOptions = {
  id: string;
  enrolment: "time-billing" | "none";
  /** Extra descriptors bound to an unenrolled feature, so they are hidden. */
  hiddenDescriptors?: readonly string[];
  grantedScopes?: readonly string[];
};

const principal = ({
  id,
  enrolment,
  hiddenDescriptors = [],
  grantedScopes = [],
}: PrincipalOptions): McpRequestResources => {
  const organizationId = `org_${id}`;
  const userId = `user_${id}`;
  const hiddenBindings = new Map(
    hiddenDescriptors.map((descriptor) => [descriptor, UNENROLLED_FEATURE_ID]),
  );
  return asTestRaw<McpRequestResources>({
    accessibleWorkspaceIds: [],
    organizationId,
    userId,
    memberRole: "owner",
    grantedScopes,
    featureAccessSnapshot:
      enrolment === "time-billing"
        ? enrolledTimeBillingSnapshot({ organizationId, userId })
        : createFeatureAccessSnapshot({
            organizationId,
            userId,
            decisions: new Map(),
          }),
    ...(hiddenBindings.size === 0
      ? {}
      : {
          testDependencies: {
            featureAccessBindings: {
              capabilities: hiddenBindings,
              resources: new Map(),
              tools: hiddenBindings,
            },
          },
        }),
  });
};

type ServedShape = Pick<
  McpTool,
  "description" | "inputSchema" | "name" | "outputSchema"
>;

const servedShape = (tools: readonly McpTool[]): unknown =>
  structuredClone(
    tools.map(
      ({ description, inputSchema, name, outputSchema }): ServedShape => ({
        description,
        inputSchema,
        name,
        outputSchema,
      }),
    ),
  );

/**
 * The projection recomputed from the scoping primitives with no cache in the
 * way: what a cold process serves this principal.
 */
const uncachedShape = (
  definitions: readonly McpToolDefinition[],
  mode: McpMode,
  context: McpRequestResources,
): unknown => {
  const hidden = hiddenMcpDescriptorIds(context, DEFAULT_MCP_TOOL_DEFINITIONS);
  const scope = (schema: Record<string, unknown>) =>
    hidden.size === 0
      ? schema
      : { ...scopeSchemaAnnotations(schema, hidden), type: "object" };
  return structuredClone(
    definitions.map(({ description, inputSchema, name }) => {
      const outputSchema = resolveMcpToolOutputContract(
        name,
        mode,
      )?.outputSchema;
      return {
        description: scopeMcpDescriptorProse(description, hidden),
        inputSchema: { ...scope(inputSchema), type: "object" },
        name,
        outputSchema:
          outputSchema === undefined ? undefined : scope(outputSchema),
      };
    }),
  );
};

const ADVANCED_DEFINITIONS = listStaticMcpToolDefinitions("advanced");

describe("tools/list projection cache", () => {
  test("interleaved principals each get their own feature scoping from a warm cache", () => {
    const enrolled = principal({ id: "enrolled", enrolment: "time-billing" });
    const unenrolled = principal({ id: "unenrolled", enrolment: "none" });
    expect(
      hiddenMcpDescriptorIds(enrolled, DEFAULT_MCP_TOOL_DEFINITIONS),
    ).not.toEqual(
      hiddenMcpDescriptorIds(unenrolled, DEFAULT_MCP_TOOL_DEFINITIONS),
    );

    const expected = new Map([
      [enrolled, uncachedShape(ADVANCED_DEFINITIONS, "advanced", enrolled)],
      [unenrolled, uncachedShape(ADVANCED_DEFINITIONS, "advanced", unenrolled)],
    ]);
    expect(expected.get(enrolled)).not.toEqual(expected.get(unenrolled));

    for (const context of [enrolled, unenrolled, enrolled, unenrolled]) {
      expect(
        servedShape(
          toMcpTools(ADVANCED_DEFINITIONS, { mode: "advanced", context }),
        ),
      ).toEqual(expected.get(context));
    }
  });

  test("any sequence of hidden sets is served exactly as a cold process would serve it", () => {
    const descriptor = fc.constantFrom(...REGISTERED_MCP_TOOL_NAMES);
    assertProperty(
      "any sequence of hidden sets is served exactly as a cold process would serve it",
      fc.property(
        fc.array(fc.uniqueArray(descriptor, { maxLength: 6 }), {
          minLength: 1,
          maxLength: 4,
        }),
        (hiddenSets) => {
          for (const [index, hiddenDescriptors] of hiddenSets.entries()) {
            const context = principal({
              id: `p${index}`,
              enrolment: "none",
              hiddenDescriptors,
            });
            expect(
              servedShape(
                toMcpTools(ADVANCED_DEFINITIONS, { mode: "advanced", context }),
              ),
            ).toEqual(uncachedShape(ADVANCED_DEFINITIONS, "advanced", context));
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe("tools/list scope isolation over HTTP", () => {
  const READ_ONLY_SCOPES = ["stella:read", "stella:search"] as const;
  // Grants neither dynamic family, so no gateway loader reads the database.
  const WIDE_SCOPES = MCP_DEFAULT_RESOURCE_SCOPES;
  const contexts = new Map([
    [
      "reader",
      principal({
        id: "reader",
        enrolment: "none",
        grantedScopes: READ_ONLY_SCOPES,
      }),
    ],
    [
      "writer",
      principal({
        id: "writer",
        enrolment: "none",
        grantedScopes: WIDE_SCOPES,
      }),
    ],
  ]);
  const scopesFor = (token: string): readonly string[] =>
    token === "writer" ? WIDE_SCOPES : READ_ONLY_SCOPES;

  const handler = createMcpHttpRequestHandler({
    authenticateMcpRequest: async (token) => {
      const scopes = scopesFor(token);
      return await Promise.resolve(
        Result.ok({
          organizationId: `org_${token}`,
          scopes: [...scopes],
          userId: `user_${token}`,
        }),
      );
    },
    captureError: (error) => {
      throw error;
    },
    getMcpToolDefinition,
    getMcpToolRequiredScopesHint,
    handleMcpToolCall,
    listMcpResources: async () => [],
    listMcpTools,
    readMcpResource: () => ({ contents: [] }),
    recordMcpSessionInitialized: () => undefined,
    resolveMcpSessionContext: async (session) =>
      await Promise.resolve(
        contexts.get(session.userId.replace("user_", "")) ??
          asTestRaw<McpRequestResources>({}),
      ),
  });

  const listToolNames = async (token: string): Promise<string[]> => {
    const response = await handler(
      new Request("http://localhost/mcp", {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
        }),
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    const body = await readTestJson<{ result: { tools: McpTool[] } }>(response);
    return body.result.tools.map(({ name }) => name).toSorted();
  };

  test("a warm process never serves one session's tool list to another", async () => {
    const offeredTo = (scopes: readonly string[]) =>
      listStaticMcpToolDefinitions("default").filter(({ scope }) =>
        hasGrantedScope(scopes, scope),
      );
    const reader = await listToolNames("reader");
    const writer = await listToolNames("writer");

    expect(reader.length).toBeGreaterThan(0);
    expect(writer.length).toBeGreaterThan(reader.length);
    expect(
      reader.every((name) =>
        offeredTo(READ_ONLY_SCOPES).some(
          (definition) => definition.name === name,
        ),
      ),
    ).toBe(true);
    expect(await listToolNames("reader")).toEqual(reader);
    expect(await listToolNames("writer")).toEqual(writer);
    expect(await listToolNames("reader")).toEqual(reader);
  });
});

describe("registry narrowing is resolved only for discovery", () => {
  test("only the default surface resolves the reachable registries", async () => {
    const resolve = mock(
      async () => await Promise.resolve(readPresent(["ares" as const])),
    );
    const context = asTestRaw<McpRequestResources>({
      loadEnabledRegistrySlugs: resolve,
    });

    for (const mode of [
      "advanced",
      "anonymized",
      "documents",
      "law",
    ] as const) {
      expect(await resolveOfferedRegistrySlugs(context, mode)).toBeUndefined();
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(await resolveOfferedRegistrySlugs(context, "default")).toEqual([
      "ares",
    ]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test("an unavailable read leaves the full enum advertised", async () => {
    const context = asTestRaw<McpRequestResources>({
      loadEnabledRegistrySlugs: async () =>
        await Promise.resolve(
          readUnavailable({ kind: "thrown", error: new Error("read failed") }),
        ),
    });

    expect(
      await resolveOfferedRegistrySlugs(context, "default"),
    ).toBeUndefined();
  });

  test("a tools/call does not resolve them; tools/list does", async () => {
    const resolve = mock(
      async () => await Promise.resolve(readPresent(["ares" as const])),
    );
    const context = {
      ...principal({
        id: "registry",
        enrolment: "none",
        grantedScopes: ["stella:read"],
      }),
      loadEnabledRegistrySlugs: resolve,
    };

    // Refused at the argument boundary, so no register is contacted.
    const call = await handleMcpToolCall({
      args: { registry: "ares", unexpected: true },
      context,
      toolName: "lookup_business_registry",
    });
    expect(call.isError).toBe(true);
    expect(resolve).not.toHaveBeenCalled();

    const definitions = await listGatewayMcpToolDefinitions({
      context,
      mode: "default",
      scopes: ["stella:read"],
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    const definition = definitions.find(
      ({ name }) => name === "lookup_business_registry",
    );
    expect(
      structuredClone(definition?.inputSchema.properties?.["registry"]),
    ).toMatchObject({ enum: ["ares"] });
  });

  test("cached narrowed definitions are deeply frozen", async () => {
    const context = {
      ...principal({
        id: "frozen-registry",
        enrolment: "none",
        grantedScopes: ["stella:read"],
      }),
      loadEnabledRegistrySlugs: async () =>
        await Promise.resolve(readPresent(["ares" as const])),
    };
    const listDefinitions = async () =>
      await listGatewayMcpToolDefinitions({
        context,
        mode: "default",
        scopes: ["stella:read"],
      });

    await listDefinitions();
    const definition = (await listDefinitions()).find(
      ({ name }) => name === "lookup_business_registry",
    );

    expect(Object.isFrozen(definition)).toBe(true);
    expect(
      Object.isFrozen(definition?.inputSchema.properties?.["registry"]),
    ).toBe(true);
  });
});

describe("reference visibility per request", () => {
  test("each request's own tool vocabulary still decides whether a reference is served", async () => {
    const served = async (context: McpRequestResources) =>
      (await listMcpResources("default", { context })).some(
        ({ uri }) => uri === TEMPLATE_WORKFLOW_REFERENCE_URI,
      );
    const everyTool = principal({
      id: "all",
      enrolment: "none",
      grantedScopes: MCP_DEFAULT_RESOURCE_SCOPES,
    });
    const withoutTemplates = principal({
      id: "no-templates",
      enrolment: "none",
      hiddenDescriptors: ["create_template"],
      grantedScopes: MCP_DEFAULT_RESOURCE_SCOPES,
    });
    const readOnly = principal({
      id: "read-only",
      enrolment: "none",
      grantedScopes: ["stella:read", "stella:search"],
    });

    expect(await served(everyTool)).toBe(true);
    expect(await served(withoutTemplates)).toBe(false);
    // The session's own tools/list decides, scopes included: a session that
    // cannot create a template is not pointed at the template workflow.
    expect(await served(readOnly)).toBe(false);
    expect(await served(everyTool)).toBe(true);
  });

  test("a shipped skill is served only where the session can call the tools it needs", async () => {
    const PLAYBOOK_SKILL_URI = "stella://skills/playbook-builder";
    const servedTo = async (id: string, grantedScopes: readonly string[]) =>
      (
        await listMcpResources("default", {
          context: principal({ id, enrolment: "none", grantedScopes }),
        })
      ).map(({ uri }) => uri);

    // save_playbook is the skill's last step; a read-only session lists the
    // skill's reads but not that write, so it is never offered the skill.
    expect(
      await servedTo("reader", ["stella:read", "stella:search"]),
    ).not.toContain(PLAYBOOK_SKILL_URI);
    expect(
      await servedTo("knowledge-writer", [
        "stella:read",
        "stella:search",
        "stella:knowledge_write",
      ]),
    ).toContain(PLAYBOOK_SKILL_URI);
  });
});
