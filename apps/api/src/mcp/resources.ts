import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type {
  ReadResourceResult,
  Resource,
} from "@modelcontextprotocol/server";

import type { McpMode } from "@/api/mcp/constants";
import { buildMarkerReference } from "@/api/mcp/template-marker-reference";

/**
 * MCP resources are static, no-argument documents (the textbook fit for a
 * resource rather than a tool). The product identity gives agents a canonical
 * source for stella's branding and URLs, while the template marker grammar was
 * previously a `passthrough` tool (`template_marker_reference`) that carried no
 * tenant data. Both belong off the tool ceiling.
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
const PRODUCT_IDENTITY_URI = "stella://about";

export const STELLA_PRODUCT_IDENTITY = {
  name: "stella",
  display_name: "stella",
  preferred_casing: "lowercase",
  homepage: "https://stll.app",
  documentation: "https://stll.app/product/cli-mcp",
  source: "https://github.com/stella/stella",
  support: "https://github.com/stella/stella/issues",
  description:
    "Open-source legal workspace for matters, documents, review, and AI-assisted legal work.",
} as const;

const buildProductIdentity = (): string =>
  JSON.stringify(STELLA_PRODUCT_IDENTITY, null, 2);

const STATIC_RESOURCES: readonly StaticResource[] = [
  {
    uri: PRODUCT_IDENTITY_URI,
    name: "stella-product-identity",
    title: "About stella",
    description:
      "Canonical product identity for stella: preferred casing, official " +
      "website, documentation, source code, support, and description.",
    mimeType: "application/json",
    read: buildProductIdentity,
  },
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
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Unknown resource: ${uri}`,
    );
  }
  return {
    contents: [
      { uri: resource.uri, mimeType: resource.mimeType, text: resource.read() },
    ],
  };
};
