import {
  ErrorCode,
  McpError,
  type ReadResourceResult,
  type Resource,
} from "@modelcontextprotocol/sdk/types.js";

import type { McpMode } from "@/api/mcp/constants";
import { buildMarkerReference } from "@/api/mcp/template-marker-reference";

/**
 * MCP resources are static, no-argument documents (the textbook fit for a
 * resource rather than a tool). The template marker grammar is the first: it
 * was a `passthrough` tool (`template_marker_reference`) that carried no tenant
 * data, so it belongs off the tool ceiling. `save_template`'s description points
 * callers here.
 *
 * The set is identical across both MCP modes. `tools/list` projects a different
 * tool set per mode because tools touch tenant data under mode-specific scopes;
 * these resources are public, static, and tenant-independent, so there is
 * nothing to project — an anonymized-mode client that could previously call the
 * passthrough marker tool keeps the same reach through the resource. Each
 * accessor still takes the mode for symmetry with the tool surface and so a
 * future tenant-scoped resource can branch on it.
 */
type StaticResource = {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  read: () => string;
};

const TEMPLATE_MARKER_REFERENCE_URI = "stella://reference/template-markers";

const STATIC_RESOURCES: readonly StaticResource[] = [
  {
    uri: TEMPLATE_MARKER_REFERENCE_URI,
    name: "template-markers",
    title: "Template marker grammar",
    description:
      "stella's {{...}} template marker grammar: fillable values, conditional " +
      "and repeating blocks, clause slots, and numbering inside a DOCX. Read " +
      "this before authoring a DOCX for save_template.",
    mimeType: "text/markdown",
    read: buildMarkerReference,
  },
];

export const listMcpResources = (_mode: McpMode): Resource[] =>
  STATIC_RESOURCES.map(({ description, mimeType, name, title, uri }) => ({
    uri,
    name,
    title,
    description,
    mimeType,
  }));

export const readMcpResource = (
  uri: string,
  _mode: McpMode,
): ReadResourceResult => {
  const resource = STATIC_RESOURCES.find((entry) => entry.uri === uri);
  if (!resource) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
  }
  return {
    contents: [
      { uri: resource.uri, mimeType: resource.mimeType, text: resource.read() },
    ],
  };
};
