import { describe, expect, test } from "bun:test";

import { MCP_APP_RESOURCE_MIME_TYPE } from "@stll/api-contract";
import { CHAT_UI_RESOURCE_MIME_TYPES } from "@stll/api-contract/chat-ui-resources";
import { GENERATED_VISUAL_MIME_TYPE } from "@stll/api-contract/generated-visual";

import {
  UI_RESOURCE_RENDERER,
  uiResourceRenderer,
} from "./ui-resource-renderer";

describe("chat UI resource rendering", () => {
  test("makes a renderer decision for every supported MIME", () => {
    expect(Object.keys(UI_RESOURCE_RENDERER).toSorted()).toEqual(
      [...CHAT_UI_RESOURCE_MIME_TYPES].toSorted(),
    );
    for (const mimeType of CHAT_UI_RESOURCE_MIME_TYPES) {
      expect(uiResourceRenderer(mimeType)).toBe(UI_RESOURCE_RENDERER[mimeType]);
    }
    expect(uiResourceRenderer(MCP_APP_RESOURCE_MIME_TYPE)).toBe("mcp-app");
    expect(uiResourceRenderer(GENERATED_VISUAL_MIME_TYPE)).toBe(
      "generated-visual",
    );
    for (const mimeType of [
      "text/html",
      "application/json",
      `${GENERATED_VISUAL_MIME_TYPE};extra=1`,
    ]) {
      expect(uiResourceRenderer(mimeType)).toBeNull();
    }
  });
});
