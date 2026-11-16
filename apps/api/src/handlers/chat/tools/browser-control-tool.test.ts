import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { BROWSER_CONTROL_ACTION } from "@stll/api-contract/browser-control";

import {
  BROWSER_CONTROL_TOOL_NAME,
  createBrowserControlTool,
} from "./browser-control-tool";

describe("browser control chat tool", () => {
  test("is client-executed and keeps every action in one strict union", () => {
    const tool = createBrowserControlTool()[BROWSER_CONTROL_TOOL_NAME];
    expect(tool.execute).toBeUndefined();
    expect(tool.description).toContain("untrusted-web-content");
    expect(tool.description).toContain(
      "Passwords, login, and MFA remain manual",
    );
    expect(tool.description).toContain("including `absent`");

    const schema = convertSchemaToJsonSchema(tool.inputSchema);
    if (
      schema === undefined ||
      !("anyOf" in schema) ||
      !Array.isArray(schema.anyOf)
    ) {
      throw new TypeError("Expected the browser action union in JSON Schema");
    }
    expect(schema.anyOf).toHaveLength(
      Object.values(BROWSER_CONTROL_ACTION).length,
    );
    for (const branch of schema.anyOf) {
      expect(branch).toMatchObject({ additionalProperties: false });
    }
  });

  test("tells the model how to reach and recover its other tabs", () => {
    const { description } =
      createBrowserControlTool()[BROWSER_CONTROL_TOOL_NAME];
    for (const term of [
      "`switch-tab`",
      "`newTab: true`",
      "`tabs`",
      "`tab-limit-reached`",
      "`no-controlled-tab`",
    ]) {
      expect(description).toContain(term);
    }
  });
});
