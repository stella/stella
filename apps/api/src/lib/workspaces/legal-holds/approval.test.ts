import { expect, test } from "bun:test";

import { readCapabilityCatalog } from "@stll/cli/capability-catalog-data";

import {
  loadCapabilityEndpoint,
  parseCatalog,
} from "@/api/mcp/capability-tools";
import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";

test("legal hold approval contracts match the live capability dispatch", async () => {
  const catalog = parseCatalog(readCapabilityCatalog());
  const holds = catalog.filter((entry) => entry.id.includes(".legal-holds."));
  expect(holds.map(({ id }) => id).toSorted()).toEqual([
    "entities.legal-holds.place",
    "entities.legal-holds.release",
    "matters.legal-holds.place",
    "matters.legal-holds.release",
  ]);
  const deletion = catalog.find(({ id }) => id === "matters.delete");
  expect(deletion?.destructive).toBe(true);
  for (const entry of holds) {
    expect(entry.confirmation, entry.id).toBe("required");
    const endpoint = await loadCapabilityEndpoint(entry.id);
    expect(endpoint?.config.mcp, entry.id).toMatchObject({
      type: "capability",
      confirmation: "required",
    });
  }
  const matterDeletion = await loadCapabilityEndpoint("matters.delete");
  expect(matterDeletion?.config.mcp).toMatchObject({
    type: "tool",
    name: "delete_matter",
  });
  expect(
    DEFAULT_MCP_TOOL_DEFINITIONS.find(({ name }) => name === "delete_matter"),
  ).toMatchObject({ destructiveBehavior: { type: "always" } });
});
