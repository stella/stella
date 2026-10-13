import path from "node:path";

import { MCP_APPS } from "./manifest";

export type McpAppDirectory = (typeof MCP_APPS)[number]["directory"];

const relativeBundlePath = (directory: McpAppDirectory) =>
  `packages/mcp-apps/src/${directory}/generated/app.html.txt`;

export const MCP_APP_BUNDLE_PATHS = MCP_APPS.map(({ directory }) =>
  relativeBundlePath(directory),
);

export const mcpAppBundlePath = (
  directory: McpAppDirectory,
  root = path.resolve(import.meta.dirname, "../../.."),
) => path.join(root, relativeBundlePath(directory));
