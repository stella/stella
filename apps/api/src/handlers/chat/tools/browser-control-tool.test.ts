import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

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

    const schema = convertSchemaToJsonSchema(tool.inputSchema);
    if (
      schema === undefined ||
      !("anyOf" in schema) ||
      !Array.isArray(schema.anyOf)
    ) {
      throw new TypeError("Expected the browser action union in JSON Schema");
    }
    expect(schema.anyOf).toHaveLength(7);
    for (const branch of schema.anyOf) {
      expect(branch).toMatchObject({ additionalProperties: false });
    }
  });
});
