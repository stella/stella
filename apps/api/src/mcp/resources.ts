import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type {
  ReadResourceResult,
  Resource,
} from "@modelcontextprotocol/server";

import { MCP_APP_RESOURCE_MIME_TYPE } from "@stll/api-contract";

import { envBase } from "@/api/env-base";
import documentUploadAppHtml from "@/api/mcp/apps/document-upload/generated/app.html.txt" with { type: "text" };
import type { McpMode } from "@/api/mcp/constants";
import { DOCUMENT_UPLOAD_APP_RESOURCE_URI } from "@/api/mcp/document-file-upload";
import {
  buildFieldReference,
  TEMPLATE_FIELD_REFERENCE_URI,
} from "@/api/mcp/template-field-reference";
import {
  buildMarkerReference,
  TEMPLATE_MARKER_REFERENCE_URI,
} from "@/api/mcp/template-marker-reference";
import {
  buildWorkflowReference,
  TEMPLATE_WORKFLOW_REFERENCE_URI,
} from "@/api/mcp/template-workflow-reference";

/**
 * MCP resources are static, no-argument documents (the textbook fit for a
 * resource rather than a tool). The product identity gives agents a canonical
 * source for stella's branding and URLs, while the template marker grammar was
 * previously a `passthrough` tool (`template_marker_reference`) that carried no
 * tenant data. Both belong off the tool ceiling.
 *
 * The set is identical across all MCP modes. `tools/list` projects a different
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
  listed: boolean;
  read: () => string | Promise<string>;
  resourceMeta?: () => Record<string, unknown>;
};

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
    listed: true,
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
    listed: true,
    read: buildMarkerReference,
  },
  {
    uri: TEMPLATE_FIELD_REFERENCE_URI,
    name: "template-fields",
    title: "Template field configuration",
    description:
      "How save_template's fields overlay configures each template field: " +
      "input types, validation, composite parts, registry lookups, contact " +
      "and matter bindings, and who fills the field. Read this before " +
      "passing fields.",
    mimeType: "text/markdown",
    listed: true,
    read: buildFieldReference,
  },
  {
    uri: TEMPLATE_WORKFLOW_REFERENCE_URI,
    name: "template-workflow",
    title: "Template workflow",
    description:
      "The order to drive stella's templates in: author markers, create the " +
      "template, read the discovered paths back, configure fields, preview " +
      "the fill, persist it into a matter. Read this before the first " +
      "save_template call.",
    mimeType: "text/markdown",
    listed: true,
    read: buildWorkflowReference,
  },
  {
    uri: DOCUMENT_UPLOAD_APP_RESOURCE_URI,
    name: "document-version-upload",
    title: "Upload document version",
    description:
      "Portable MCP App file picker for uploading a new version through stella's canonical file-transport capabilities.",
    mimeType: MCP_APP_RESOURCE_MIME_TYPE,
    listed: false,
    // A text import makes Bun embed the generated app in the compiled API
    // binary. Reading from the source tree at runtime would work in dev but
    // fail in the production image, which ships only the compiled server.
    read: () => documentUploadAppHtml,
    resourceMeta: () => documentUploadResourceMeta(),
  },
];

const uploadStorageOrigins = (): string[] => {
  const endpoint = new URL(envBase.S3_ENDPOINT);
  if (
    endpoint.hostname.includes("s3") &&
    endpoint.hostname.endsWith(".amazonaws.com") &&
    envBase.S3_BUCKET.length > 0
  ) {
    endpoint.hostname = `${envBase.S3_BUCKET}.${endpoint.hostname}`;
  }
  return [endpoint.origin];
};

const documentUploadResourceMeta = (): Record<string, unknown> => {
  const connectDomains = uploadStorageOrigins();
  return {
    ui: {
      csp: { connectDomains, resourceDomains: [] },
      prefersBorder: true,
    },
  };
};

export const listMcpResources = (_mode: McpMode): Resource[] =>
  STATIC_RESOURCES.filter(({ listed }) => listed).map(
    ({ description, mimeType, name, title, uri }) => ({
      uri,
      name,
      title,
      description,
      mimeType,
    }),
  );

export const readMcpResource = async (
  uri: string,
  _mode: McpMode,
): Promise<ReadResourceResult> => {
  const resource = STATIC_RESOURCES.find((entry) => entry.uri === uri);
  if (!resource) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Unknown resource: ${uri}`,
    );
  }
  return {
    contents: [
      {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: await resource.read(),
        ...(resource.resourceMeta === undefined
          ? {}
          : { _meta: resource.resourceMeta() }),
      },
    ],
  };
};
