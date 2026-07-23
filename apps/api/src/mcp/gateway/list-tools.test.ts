import { describe, expect, test } from "bun:test";

import type { McpRequestContext } from "@/api/mcp/context";
import { listGatewayMcpToolDefinitions } from "@/api/mcp/gateway/list-tools";
import type { McpToolDefinition } from "@/api/mcp/tool-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// Only `enabledRegistrySlugs` drives the narrowing; the rest of the context is
// unused on this path. `scopes: ["stella:read"]` grants the read-scoped lookup
// tool while withholding stella:external_mcps / stella:skills, so the dynamic
// gateway loaders never run and no DB is touched.
const contextWith = (
  enabledRegistrySlugs: readonly string[] | undefined,
): McpRequestContext =>
  asTestRaw<McpRequestContext>({ enabledRegistrySlugs, grantedScopes: [] });

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
