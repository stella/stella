import { describe, expect, test } from "bun:test";

import { parseAppToolPayload } from "./bridge";

describe("MCP app tool payloads", () => {
  test("structured content takes precedence over text", () => {
    const payload = { result: { id: "123" } };
    expect(
      parseAppToolPayload({
        structuredContent: payload,
        content: [{ type: "text", text: '{"result":null}' }],
      }),
    ).toBe(payload);
  });

  test("text-only replies parse JSON and absent or malformed payloads stay absent", () => {
    expect(
      parseAppToolPayload({
        content: [{ type: "text", text: '{"result":123}' }],
      }),
    ).toEqual({ result: 123 });
    expect(parseAppToolPayload({ content: [] })).toBeUndefined();
    expect(
      parseAppToolPayload({
        content: [{ type: "text", text: "invalid JSON" }],
      }),
    ).toBeUndefined();
  });
});
