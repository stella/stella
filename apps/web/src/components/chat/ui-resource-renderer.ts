import { MCP_APP_RESOURCE_MIME_TYPE } from "@stll/api-contract";
import type { ChatUiResourceMimeType } from "@stll/api-contract/chat-ui-resources";
import { GENERATED_VISUAL_MIME_TYPE } from "@stll/api-contract/generated-visual";
import { STELLA_MCP_APP_MIME_TYPE } from "@stll/api-contract/stella-mcp-app";

export const UI_RESOURCE_RENDERER = {
  [MCP_APP_RESOURCE_MIME_TYPE]: "mcp-app",
  [GENERATED_VISUAL_MIME_TYPE]: "generated-visual",
  [STELLA_MCP_APP_MIME_TYPE]: "stella-app",
} as const satisfies Record<
  ChatUiResourceMimeType,
  "mcp-app" | "generated-visual" | "stella-app"
>;

const isSupportedResourceMime = (
  mimeType: string,
): mimeType is ChatUiResourceMimeType =>
  Object.hasOwn(UI_RESOURCE_RENDERER, mimeType);

export const uiResourceRenderer = (mimeType: string) =>
  isSupportedResourceMime(mimeType) ? UI_RESOURCE_RENDERER[mimeType] : null;
