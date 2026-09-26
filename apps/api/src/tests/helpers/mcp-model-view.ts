import type { CallToolResult } from "@modelcontextprotocol/server";
import { panic } from "better-result";
import { expect } from "bun:test";

/**
 * A successful tool result as the model reads it. Hosts show the model either
 * the text block or `structuredContent`, so a success must carry exactly one
 * text block whose JSON is the structured object; this asserts that and
 * returns the object both views share.
 */
export const modelViewOf = (
  result: CallToolResult,
): Record<string, unknown> => {
  expect(result.isError).toBeUndefined();
  const { structuredContent } = result;
  if (structuredContent === undefined) {
    return panic("Expected structuredContent on a successful tool result");
  }
  expect(result.content).toHaveLength(1);
  const [block] = result.content;
  if (block?.type !== "text") {
    return panic("Expected a single text block");
  }
  expect(block.text).toBe(JSON.stringify(structuredContent));
  return structuredContent;
};
