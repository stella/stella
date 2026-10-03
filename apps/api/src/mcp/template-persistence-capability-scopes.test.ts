import { describe, expect, test } from "bun:test";

import { readCapabilityCatalog } from "@stll/cli/capability-catalog-data";

import { isRecord } from "@/api/lib/type-guards";
import { DEFAULT_MCP_CLI_ANNOTATIONS } from "@/api/mcp/static-cli-metadata";
import { getStaticMcpToolDefinition } from "@/api/mcp/static-tool-definitions";

const capabilityCatalog = readCapabilityCatalog().map((entry) => {
  if (!isRecord(entry)) {
    throw new TypeError("Invalid capability catalog entry");
  }
  return entry;
});

describe("template persistence capability scope parity", () => {
  test("fill-to-workspace requires the same document-write consent as its covering tool", () => {
    const fillToWorkspace = capabilityCatalog.find(
      ({ id }) => id === "templates.fills.create",
    );

    expect(fillToWorkspace?.["scope"]).toBe("stella:documents_write");
    expect(fillToWorkspace?.["additionalScopes"]).toEqual(["stella:templates"]);
    expect(fillToWorkspace?.["mcp"]).toEqual({
      type: "covered",
      by: "save_filled_template",
    });
    expect(fillToWorkspace?.["permissions"]).toEqual({
      template: ["use"],
      entity: ["create"],
    });

    const saveFilledTemplate = getStaticMcpToolDefinition(
      "save_filled_template",
    );
    expect(saveFilledTemplate?.scope).toBe("stella:documents_write");
    expect(saveFilledTemplate?.additionalScopes).toEqual(["stella:templates"]);
    expect(DEFAULT_MCP_CLI_ANNOTATIONS.save_filled_template).toEqual(
      expect.objectContaining({
        scope: "documents_write",
        additionalScopes: ["templates"],
      }),
    );
  });
});
