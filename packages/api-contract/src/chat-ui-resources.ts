import { GENERATED_VISUAL_MIME_TYPE } from "./generated-visual";
import { STELLA_MCP_APP_MIME_TYPE } from "./stella-mcp-app";

export const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

export const CHAT_UI_RESOURCE_MIME_TYPES = [
  MCP_APP_RESOURCE_MIME_TYPE,
  GENERATED_VISUAL_MIME_TYPE,
  STELLA_MCP_APP_MIME_TYPE,
] as const;

export type ChatUiResourceMimeType =
  (typeof CHAT_UI_RESOURCE_MIME_TYPES)[number];
