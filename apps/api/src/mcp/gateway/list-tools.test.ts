import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { CachedMcpToolDefinition } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { LoadedMcpConnection } from "@/api/lib/mcp-upstream/connections";
import type { McpRequestContext } from "@/api/mcp/context";
import type { ExternalGatewayDependencies } from "@/api/mcp/gateway/external-tools";
import {
  getGatewayMcpToolDefinition,
  listGatewayMcpToolDefinitions,
  toMcpTools,
} from "@/api/mcp/gateway/list-tools";
import { DOCUMENTS_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import type { McpToolDefinition } from "@/api/mcp/tool-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";

// Only `enabledRegistrySlugs` and `memberRole` drive static visibility here.
// `scopes: ["stella:read"]` grants the read-scoped lookup tool while
// withholding stella:external_mcps / stella:skills, so the dynamic gateway
// loaders never run and no DB is touched.
const contextWith = (
  enabledRegistrySlugs: readonly string[] | undefined,
  memberRole: McpRequestContext["memberRole"] = "owner",
): McpRequestContext =>
  asTestRaw<McpRequestContext>({
    enabledRegistrySlugs,
    grantedScopes: [],
    memberRole,
    // Billing tools are gated by enrolment; this caller is enrolled so role
    // visibility is what the tests observe.
    organizationId: "org_test",
    userId: "user_test",
    featureAccessSnapshot: enrolledTimeBillingSnapshot({
      organizationId: "org_test",
      userId: "user_test",
    }),
  });

// Snapshot the advertised registry enum into a fresh array. The unresolved and
// anonymized paths return the shared static definition by reference (correct:
// they must not narrow), so callers must never hand that object to a mutating
// matcher — copy the enum out and assert on the copy.
const registryEnumOf = (
  definitions: readonly McpToolDefinition[],
): string[] => {
  const registry = definitions.find(
    (definition) => definition.name === "lookup_business_registry",
  )?.inputSchema.properties?.["registry"];
  if (
    registry !== undefined &&
    registry !== null &&
    typeof registry === "object" &&
    "enum" in registry &&
    Array.isArray(registry.enum)
  ) {
    return [...registry.enum];
  }
  return [];
};

const hasLookupTool = (definitions: readonly McpToolDefinition[]): boolean =>
  definitions.some(
    (definition) => definition.name === "lookup_business_registry",
  );

const definitionWithSchema = (
  inputSchema: McpToolDefinition["inputSchema"],
): McpToolDefinition => ({
  access: "read",
  readClass: "tenant",
  annotations: {
    title: "Test tool",
    destructiveHint: false,
    openWorldHint: false,
    readOnlyHint: true,
  },
  annotationReasons: {
    readOnlyHint: "Reads fixture data without modifying it.",
    destructiveHint: "The fixture changes no existing data.",
    openWorldHint: "The fixture reads local data only.",
  },
  anonymized: { exposure: "passthrough" },
  consumesServices: true,
  description: "Test schema conversion",
  inputSchema,
  name: "test_schema_conversion",
  scope: "stella:read",
});

const externalToolName = "mcp__registry__lookup";
const externalCachedTool = {
  exposedName: externalToolName,
  inputSchema: { type: "object", properties: {} },
  rawName: "lookup",
  readOnlyHint: true,
} satisfies CachedMcpToolDefinition;
const externalConnection = {
  responseDisposition: "normal",
  allowedTools: null,
  connectorId: toSafeId<"mcpConnector">("connector_1"),
  description: "Registry connector",
  displayName: "Registry",
  slug: "registry",
  type: "none",
  url: "https://mcp.example.test",
  userConnectionId: toSafeId<"mcpUserConnection">("connection_1"),
} satisfies LoadedMcpConnection;
const externalGatewayDependencies = {
  loadActiveMcpConnectionsForUser: async () => [externalConnection],
  proxyMcpToolCall: async () => ({ content: [] }),
  refreshCachedMcpToolsForConnection: async () => undefined,
} satisfies ExternalGatewayDependencies;

const contextWithExternalServer = (
  grantedScopes: readonly string[],
): McpRequestContext => {
  const builder = {
    from: () => builder,
    innerJoin: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: async () => [
      {
        allowedTools: null,
        cachedTools: [externalCachedTool],
        connectorId: externalConnection.connectorId,
        displayName: externalConnection.displayName,
        slug: externalConnection.slug,
        userConnectionId: externalConnection.userConnectionId,
      },
    ],
  };
  const safeDb: McpRequestContext["safeDb"] = async (callback) =>
    Result.ok(
      await callback(asTestRaw<Transaction>({ select: () => builder })),
    );
  return asTestRaw<McpRequestContext>({
    ...contextWith(undefined),
    grantedScopes: [...grantedScopes],
    safeDb,
  });
};

describe("external gateway mode boundary", () => {
  for (const scopes of [[], ["stella:external_mcps"]] as const) {
    const scopeLabel = scopes.length === 0 ? "without scope" : "with scope";

    test(`default mode exposes no external gateway tools ${scopeLabel}`, async () => {
      const context = contextWithExternalServer(scopes);
      const definitions = await listGatewayMcpToolDefinitions({
        context,
        mode: "default",
        scopes,
        externalGatewayDependencies,
      });
      const exact = await getGatewayMcpToolDefinition({
        context,
        mode: "default",
        toolName: externalToolName,
        externalGatewayDependencies,
      });

      expect(definitions.some(({ name }) => name === externalToolName)).toBe(
        false,
      );
      expect(exact).toBeUndefined();
    });

    test(`advanced mode applies the external gateway scope ${scopeLabel}`, async () => {
      const context = contextWithExternalServer(scopes);
      const definitions = await listGatewayMcpToolDefinitions({
        context,
        mode: "advanced",
        scopes,
        externalGatewayDependencies,
      });
      const exact = await getGatewayMcpToolDefinition({
        context: contextWithExternalServer(scopes),
        mode: "advanced",
        toolName: externalToolName,
        externalGatewayDependencies,
      });
      const expected = scopes.length > 0;

      expect(definitions.some(({ name }) => name === externalToolName)).toBe(
        expected,
      );
      expect(exact?.name === externalToolName).toBe(expected);
    });
  }
});

describe("listGatewayMcpToolDefinitions business-registry narrowing", () => {
  test("narrows the default-surface enum to the org's enabled registries", async () => {
    const definitions = await listGatewayMcpToolDefinitions({
      context: contextWith(["orsr", "vies"]),
      mode: "default",
      scopes: ["stella:read"],
    });

    expect(registryEnumOf(definitions)).toEqual(["orsr", "vies"]);
  });

  test("drops the tool on the default surface when no registry is enabled", async () => {
    const definitions = await listGatewayMcpToolDefinitions({
      context: contextWith([]),
      mode: "default",
      scopes: ["stella:read"],
    });

    expect(hasLookupTool(definitions)).toBe(false);
  });

  test("keeps the full enum when the enabled set is unresolved", async () => {
    const definitions = await listGatewayMcpToolDefinitions({
      context: contextWith(undefined),
      mode: "default",
      scopes: ["stella:read"],
    });

    const registryEnum = registryEnumOf(definitions);
    expect(registryEnum).toContain("ares");
    expect(registryEnum).toContain("vies");
  });

  test("never narrows the tenant-neutral anonymized projection", async () => {
    // The anonymized tools/list must stay tenant-neutral: even when the context
    // resolved a subset, the anonymized schema keeps the full enum so it cannot
    // leak the org's practice-jurisdiction / native-tool settings.
    const definitions = await listGatewayMcpToolDefinitions({
      context: contextWith(["orsr", "vies"]),
      mode: "anonymized",
    });

    const registryEnum = registryEnumOf(definitions);
    expect(registryEnum).toContain("ares");
    expect(registryEnum).toContain("vies");
  });
});

describe("listGatewayMcpToolDefinitions restricted surfaces", () => {
  test("keeps documents discovery static even when dynamic scopes are granted", async () => {
    const definitions = await listGatewayMcpToolDefinitions({
      context: contextWith(undefined),
      mode: "documents",
      scopes: [
        "stella:read",
        "stella:documents_write",
        "stella:matters_write",
        "stella:external_mcps",
        "stella:skills",
      ],
    });

    expect(definitions.map(({ name }) => name)).toEqual(
      DOCUMENTS_MCP_TOOL_DEFINITIONS.map(({ name }) => name),
    );
  });
});

describe("listGatewayMcpToolDefinitions compound scope discovery", () => {
  test("keeps compound tools discoverable when an additional grant is missing", async () => {
    const withoutTemplateConsent = await listGatewayMcpToolDefinitions({
      context: contextWith(undefined),
      mode: "default",
      scopes: ["stella:documents_write"],
    });
    const withoutPrimaryConsent = await listGatewayMcpToolDefinitions({
      context: contextWith(undefined),
      mode: "default",
      scopes: ["stella:templates"],
    });
    const withBothConsents = await listGatewayMcpToolDefinitions({
      context: contextWith(undefined),
      mode: "default",
      scopes: ["stella:documents_write", "stella:templates"],
    });

    expect(
      withoutTemplateConsent.some(
        (definition) => definition.name === "save_filled_template",
      ),
    ).toBe(true);
    expect(
      withoutPrimaryConsent.some(
        (definition) => definition.name === "save_filled_template",
      ),
    ).toBe(false);
    expect(
      withBothConsents.some(
        (definition) => definition.name === "save_filled_template",
      ),
    ).toBe(true);
  });
});

describe("listGatewayMcpToolDefinitions role visibility", () => {
  test("hides rate resolution from roles that cannot read billing rates", async () => {
    const ownerDefinitions = await listGatewayMcpToolDefinitions({
      context: contextWith(undefined, "owner"),
      mode: "default",
      scopes: ["stella:read"],
    });
    const memberDefinitions = await listGatewayMcpToolDefinitions({
      context: contextWith(undefined, "member"),
      mode: "default",
      scopes: ["stella:read"],
    });

    expect(ownerDefinitions.some(({ name }) => name === "resolve_rate")).toBe(
      true,
    );
    expect(memberDefinitions.some(({ name }) => name === "resolve_rate")).toBe(
      false,
    );
  });

  test("rejects exact-name resolution when the role cannot read rates", async () => {
    const ownerDefinition = await getGatewayMcpToolDefinition({
      context: contextWith(undefined, "owner"),
      mode: "default",
      toolName: "resolve_rate",
    });
    const memberDefinition = await getGatewayMcpToolDefinition({
      context: contextWith(undefined, "member"),
      mode: "default",
      toolName: "resolve_rate",
    });

    expect(ownerDefinition?.name).toBe("resolve_rate");
    expect(memberDefinition).toBeUndefined();
  });

  test("hides time-entry lists from external roles", async () => {
    const ownerDefinitions = await listGatewayMcpToolDefinitions({
      context: contextWith(undefined, "owner"),
      mode: "default",
      scopes: ["stella:read"],
    });
    const externalDefinitions = await listGatewayMcpToolDefinitions({
      context: contextWith(undefined, "external"),
      mode: "default",
      scopes: ["stella:read"],
    });
    const guessedDefinition = await getGatewayMcpToolDefinition({
      context: contextWith(undefined, "external"),
      mode: "default",
      toolName: "list_time_entries",
    });

    expect(
      ownerDefinitions.some(({ name }) => name === "list_time_entries"),
    ).toBe(true);
    expect(
      externalDefinitions.some(({ name }) => name === "list_time_entries"),
    ).toBe(false);
    expect(guessedDefinition).toBeUndefined();
  });

  test("hides every time-entry mutation from external roles", async () => {
    const ownerDefinitions = await listGatewayMcpToolDefinitions({
      context: contextWith(undefined, "owner"),
      mode: "default",
      scopes: ["stella:billing_write"],
    });
    const externalDefinitions = await listGatewayMcpToolDefinitions({
      context: contextWith(undefined, "external"),
      mode: "default",
      scopes: ["stella:billing_write"],
    });

    expect(
      ownerDefinitions.some(({ name }) => name === "save_time_entry"),
    ).toBe(true);
    expect(
      ownerDefinitions.some(({ name }) => name === "delete_time_entry"),
    ).toBe(true);
    expect(
      externalDefinitions.some(({ name }) => name === "save_time_entry"),
    ).toBe(false);
    expect(
      externalDefinitions.some(({ name }) => name === "delete_time_entry"),
    ).toBe(false);
  });
});

describe("toMcpTools input schema conversion", () => {
  const unsupportedValues = [
    ["undefined", undefined],
    ["function", () => null],
    ["symbol", Symbol("schema")],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ] as const;

  for (const [label, value] of unsupportedValues) {
    test(`rejects ${label} instead of changing it to null`, () => {
      const inputSchema = asTestRaw<McpToolDefinition["inputSchema"]>({
        properties: {
          value: { description: value, type: "string" },
        },
        type: "object",
      });

      expect(() => toMcpTools([definitionWithSchema(inputSchema)])).toThrow(
        "MCP tool input schema contains a non-JSON value",
      );
    });
  }

  test("preserves valid null and boolean schema literals", () => {
    const inputSchema = {
      properties: {
        value: { anyOf: [false, { const: null }, { type: "string" }] },
      },
      type: "object",
    } as const satisfies McpToolDefinition["inputSchema"];

    expect(
      JSON.stringify(
        toMcpTools([definitionWithSchema(inputSchema)]).at(0)?.inputSchema,
      ),
    ).toBe(JSON.stringify(inputSchema));
  });
});

describe("MCP app-only discovery", () => {
  test("host discovery preserves app-only metadata", () => {
    const definition = {
      ...definitionWithSchema({ type: "object" }),
      _meta: { ui: { visibility: ["app"] } },
    };
    const wire = toMcpTools([definition]);
    expect(wire.map(({ name }) => name)).toEqual([definition.name]);
    expect(wire.at(0)?._meta).toEqual(definition._meta);
  });
});
