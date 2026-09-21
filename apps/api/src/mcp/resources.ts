import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type {
  ReadResourceResult,
  Resource,
} from "@modelcontextprotocol/server";

import {
  FILE_COMPARISON_TRANSPORT,
  MCP_APP_RESOURCE_MIME_TYPE,
} from "@stll/api-contract";

import { envBase } from "@/api/env-base";
import documentUploadAppHtml from "@/api/mcp/apps/document-upload/generated/app.html.txt" with { type: "text" };
import fileComparisonAppHtml from "@/api/mcp/apps/file-comparison/generated/app.html.txt" with { type: "text" };
import type { McpMode } from "@/api/mcp/constants";
import { DOCUMENT_UPLOAD_APP_RESOURCE_URI } from "@/api/mcp/document-file-upload";
import {
  buildLegislationWorkflowReference,
  hasLegislationWorkflowContent,
  LEGISLATION_WORKFLOW_REFERENCE_URI,
} from "@/api/mcp/legislation-workflow-reference";
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
import { isMcpToolFeatureEnabled } from "@/api/mcp/tool-feature";
import type { McpToolFeatureFlag } from "@/api/mcp/tool-types";

/**
 * MCP resources are static, no-argument documents (the textbook fit for a
 * resource rather than a tool). The product identity gives agents a canonical
 * source for stella's branding and URLs, while the template marker grammar was
 * previously a `passthrough` tool (`template_marker_reference`) that carried no
 * tenant data. Both belong off the tool ceiling.
 *
 * Every resource is public, static and tenant-independent, so a mode projects
 * the set only to keep it answerable: the law audience carries the corpus
 * tools and no template or upload tool, and a reference for a workflow it
 * cannot drive is context an agent pays for and cannot use.
 */
type StaticResource = {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  listed: boolean;
  /**
   * The deployment gate this resource rides, when it documents a gated tool
   * family. A reference whose tools are filtered out of `tools/list` would
   * otherwise hand a client a procedure it has no advertised schema for, so
   * it is neither listed nor readable while the gate is closed: the same
   * predicate, on both surfaces.
   */
  feature?: McpToolFeatureFlag;
  /**
   * Whether this audience serves the resource at all, beyond the deployment
   * gate and the per-mode URI allowlist below. A reference that renders to
   * nothing on a surface is not a reference there.
   */
  isServedInMode?: (mode: McpMode) => boolean;
  /** Rendered for one audience; a reference may omit what that surface lacks. */
  read: (mode: McpMode) => string | Promise<string>;
  resourceMeta?: () => Record<string, unknown>;
};

const isAvailable = (resource: StaticResource): boolean =>
  isMcpToolFeatureEnabled(resource.feature);

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
      "this before authoring a DOCX for create_template.",
    mimeType: "text/markdown",
    listed: true,
    read: buildMarkerReference,
  },
  {
    uri: TEMPLATE_FIELD_REFERENCE_URI,
    name: "template-fields",
    title: "Template field configuration",
    description:
      "How configure_template_fields configures each template field: " +
      "input types, validation, registry lookups, contact " +
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
      "create_template call.",
    mimeType: "text/markdown",
    listed: true,
    read: buildWorkflowReference,
  },
  {
    uri: LEGISLATION_WORKFLOW_REFERENCE_URI,
    name: "legislation-workflow",
    title: "Legislation workflow",
    description:
      "The order to read the stella legislation corpus in: find an act, read " +
      "the consolidation in force on a date, read named provisions in bulk, " +
      "follow one provision across amendments. Read this before the first " +
      "search_legislation call.",
    mimeType: "text/markdown",
    listed: true,
    feature: "FEATURE_PUBLIC_LAW",
    isServedInMode: hasLegislationWorkflowContent,
    read: buildLegislationWorkflowReference,
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
    resourceMeta: () => uploadAppResourceMeta(),
  },
  {
    uri: FILE_COMPARISON_TRANSPORT.resourceUri,
    name: "file-comparison",
    title: "Compare two files",
    description:
      "Portable MCP App picker that uploads two .docx files from the user's browser for compare_documents to redline.",
    mimeType: MCP_APP_RESOURCE_MIME_TYPE,
    listed: false,
    read: () => fileComparisonAppHtml,
    resourceMeta: () => uploadAppResourceMeta(),
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

const uploadAppResourceMeta = (): Record<string, unknown> => {
  const connectDomains = uploadStorageOrigins();
  return {
    ui: {
      csp: { connectDomains, resourceDomains: [] },
      prefersBorder: true,
    },
  };
};

/**
 * Which resources an audience serves, for both `resources/list` and
 * `resources/read`, so a listing and a read can never disagree about what the
 * surface has. Total over `McpMode`: `"all"` is a decision a new audience
 * states, not a default it inherits.
 */
const MCP_RESOURCE_URIS_BY_MODE = {
  default: "all",
  documents: "all",
  anonymized: "all",
  law: [PRODUCT_IDENTITY_URI, LEGISLATION_WORKFLOW_REFERENCE_URI],
} as const satisfies Record<McpMode, "all" | readonly string[]>;

/**
 * Three independent reasons a resource is absent, all applied in one place so
 * a listing and a read cannot disagree: the deployment gate is closed, this
 * audience does not carry the resource, or the resource renders to nothing
 * here.
 */
const isResourceServedInMode = (
  resource: StaticResource,
  mode: McpMode,
): boolean => {
  if (!isAvailable(resource)) {
    return false;
  }
  const served = MCP_RESOURCE_URIS_BY_MODE[mode];
  if (served !== "all" && !served.some((entry) => entry === resource.uri)) {
    return false;
  }
  const { isServedInMode } = resource;
  return isServedInMode === undefined || isServedInMode(mode);
};

export const listMcpResources = (mode: McpMode): Resource[] =>
  STATIC_RESOURCES.filter(
    (resource) => resource.listed && isResourceServedInMode(resource, mode),
  ).map(({ description, mimeType, name, title, uri }) => ({
    uri,
    name,
    title,
    description,
    mimeType,
  }));

export const readMcpResource = async (
  uri: string,
  mode: McpMode,
): Promise<ReadResourceResult> => {
  const resource = STATIC_RESOURCES.find((entry) => entry.uri === uri);
  if (!resource || !isResourceServedInMode(resource, mode)) {
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
        text: await resource.read(mode),
        ...(resource.resourceMeta === undefined
          ? {}
          : { _meta: resource.resourceMeta() }),
      },
    ],
  };
};
