import { assembleMcpAppDocument } from "./app-document";
import { MCP_APP_DOCUMENT_PARTS } from "./generated/bundles";
import type { McpAppDirectory } from "./manifest";

const assembled = new Map<McpAppDirectory, string>();

/**
 * The app's HTML document, assembled from its parts on first read and kept
 * for the life of the process.
 */
export const readMcpAppBundle = (directory: McpAppDirectory): string => {
  const cached = assembled.get(directory);
  if (cached !== undefined) {
    return cached;
  }
  const html = assembleMcpAppDocument(MCP_APP_DOCUMENT_PARTS[directory]);
  assembled.set(directory, html);
  return html;
};
