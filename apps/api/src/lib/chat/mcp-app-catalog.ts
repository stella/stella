import { panic } from "better-result";

import { MCP_APPS } from "@stll/mcp-apps/manifest";
import type { PresentationApp } from "@stll/mcp-apps/manifest";

/**
 * The stella apps chat may show: the presentation apps of the MCP manifest.
 * A host-approved mutation app (an upload, a comparison picker) needs the
 * approval flow of an MCP host and is never shown in chat.
 */
export const CHAT_MCP_APPS: readonly PresentationApp[] = MCP_APPS.filter(
  (app): app is PresentationApp => app.type === "presentation",
);

export const chatMcpAppByUri = (uri: string): PresentationApp | undefined =>
  CHAT_MCP_APPS.find((app) => app.uri === uri);

export const chatMcpAppByDirectory = (
  directory: string,
): PresentationApp | undefined =>
  CHAT_MCP_APPS.find((app) => app.directory === directory);

/** The app presents this tool's result: the tool links the app's resource. */
export const appPresentsTool = (app: PresentationApp, toolName: string) =>
  app.linkedTools.some((name) => name === toolName);

/**
 * The manifest's `callableTools` is the whole of what an app may ask the host
 * to run. `app-contracts.ts` holds a presentation app's list to read tools and
 * app-only tools (the link handoff) at compile time.
 */
export const appMayCall = (app: PresentationApp, toolName: string) =>
  app.callableTools.some((name) => name === toolName);

const appByLinkedTool = new Map<string, PresentationApp>();
for (const app of CHAT_MCP_APPS) {
  for (const toolName of app.linkedTools) {
    if (appByLinkedTool.has(toolName)) {
      panic(`Two chat apps present ${toolName}`);
    }
    appByLinkedTool.set(toolName, app);
  }
}

/** The one chat app that presents this tool's result, if any. */
export const chatMcpAppForTool = (
  toolName: string,
): PresentationApp | undefined => appByLinkedTool.get(toolName);
