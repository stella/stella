import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolOutputContract,
} from "./static-tool-definitions";
import { isMcpToolVisibleTo } from "./tool-visibility";
import { handoffLinkResult, webHandoffPaths } from "./web-handoff-links-core";

const collectUrlFields = (schema: unknown, fields: Set<string>) => {
  if (schema === null || typeof schema !== "object") {
    return;
  }
  if (
    "properties" in schema &&
    schema.properties !== null &&
    typeof schema.properties === "object"
  ) {
    for (const [key, field] of Object.entries(schema.properties)) {
      if (/(?:url|uri|href)$/iu.test(key)) {
        fields.add(key);
      }
      collectUrlFields(field, fields);
    }
  }
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        collectUrlFields(item, fields);
      }
    } else if (value !== null && typeof value === "object") {
      collectUrlFields(value, fields);
    }
  }
};

describe("MCP web link census", () => {
  test("handoff creation is an app-only write under its live read grant", () => {
    const definition = DEFAULT_MCP_TOOL_DEFINITIONS.find(
      ({ name }) => name === "mint_web_handoff",
    );
    expect(definition).toBeDefined();
    if (definition === undefined) {
      return;
    }

    expect(definition.access).toBe("write");
    expect(definition.scope).toBe("stella:read");
    expect(definition.annotations.readOnlyHint).toBe(false);
    expect(isMcpToolVisibleTo(definition, "app")).toBe(true);
    expect(isMcpToolVisibleTo(definition, "model")).toBe(false);
  });

  test("every registry link field reaches the shared result wrapper", async () => {
    const fields = new Set<string>();
    for (const definition of DEFAULT_MCP_TOOL_DEFINITIONS) {
      collectUrlFields(
        getStaticMcpToolOutputContract(definition.name)?.outputSchema,
        fields,
      );
    }
    // Reader outputs carry one `url` field (the app link); it must be covered.
    expect(fields.has("url")).toBe(true);
    const links = Object.fromEntries(
      [...fields].map((field, index) => [
        field,
        `https://app.example/law/cz/2020/${index + 1}`,
      ]),
    );
    const result = { content: [], structuredContent: { rows: [links] } };
    const paths = webHandoffPaths(result, "https://app.example");
    expect(paths.size).toBe(fields.size);
    const decorated = await handoffLinkResult({
      result,
      appBaseUrl: "https://app.example",
      mint: async (allowedPaths) => {
        expect(new Set(allowedPaths)).toEqual(new Set(paths.values()));
        return "sh1_example";
      },
    });
    expect(webHandoffPaths(decorated, "https://app.example").size).toBe(
      fields.size,
    );
    expect(
      JSON.stringify(decorated.structuredContent).match(/sh=sh1_example/gu)
        ?.length,
    ).toBe(fields.size);
  });
});
