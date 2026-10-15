import { MCP_APP_RESOURCE_MIME_TYPE } from "@stll/api-contract";
import type { ChatUiResourceMimeType } from "@stll/api-contract/chat-ui-resources";
import { GENERATED_VISUAL_MIME_TYPE } from "@stll/api-contract/generated-visual";

export const UI_RESOURCE_RENDERER = {
  [MCP_APP_RESOURCE_MIME_TYPE]: "mcp-app",
  [GENERATED_VISUAL_MIME_TYPE]: "generated-visual",
} as const satisfies Record<
  ChatUiResourceMimeType,
  "mcp-app" | "generated-visual"
>;

const isSupportedResourceMime = (
  mimeType: string,
): mimeType is ChatUiResourceMimeType =>
  Object.hasOwn(UI_RESOURCE_RENDERER, mimeType);

export const uiResourceRenderer = (mimeType: string) =>
  isSupportedResourceMime(mimeType) ? UI_RESOURCE_RENDERER[mimeType] : null;
