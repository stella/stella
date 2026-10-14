import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type {
  ReadResourceResult,
  Resource,
} from "@modelcontextprotocol/server";
import { panic } from "better-result";

import {
  FILE_COMPARISON_TRANSPORT,
  MCP_APP_RESOURCE_MIME_TYPE,
} from "@stll/api-contract";
import { MCP_APP_BUNDLES } from "@stll/mcp-apps/bundles";
import {
  CASE_LAW_RESULTS_APP,
  DECISION_READER_APP,
  DOCUMENT_UPLOAD_APP,
  FILE_COMPARISON_APP,
  STATUTE_TIMELINE_APP,
} from "@stll/mcp-apps/manifest";
import {
  listSkillMetadata,
  loadSkill,
  readSkillDisplayName,
  readSkillRequiredTools,
  readSkillResource,
} from "@stll/skills";

import type { SafeDb } from "@/api/db/safe-db";
import { envBase } from "@/api/env-base";
import {
  CHAT_SKILL_SOURCE,
  listAvailableChatSkillMetadata,
} from "@/api/lib/agent-skills/skills";
import type { McpToolName } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import type { DeploymentFeatureFlag } from "@/api/lib/deployment-feature";
import type { FeatureId } from "@/api/lib/feature-access/registry";
import type { McpMode } from "@/api/mcp/constants";
import { DOCUMENT_UPLOAD_APP_RESOURCE_URI } from "@/api/mcp/document-file-upload";
import { isMcpDescriptorFeatureEnabled } from "@/api/mcp/feature-access";
import type { McpFeatureAccessContext } from "@/api/mcp/feature-access";
import {
  buildFeedbackWorkflowReference,
  FEEDBACK_WORKFLOW_REFERENCE_URI,
  FEEDBACK_WORKFLOW_TOOL_NAMES,
} from "@/api/mcp/feedback-workflow-reference";
import {
  buildLegislationWorkflowReference,
  legislationWorkflowToolNames,
  LEGISLATION_WORKFLOW_REFERENCE_URI,
} from "@/api/mcp/legislation-workflow-reference";
import { getStaticMcpToolDefinition } from "@/api/mcp/static-tool-definitions";
import { surfaceToolVocabulary } from "@/api/mcp/surface-tool-mentions";
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
  TEMPLATE_WORKFLOW_TOOL_NAMES,
} from "@/api/mcp/template-workflow-reference";
import { isMcpToolFeatureEnabled } from "@/api/mcp/tool-feature";

/**
 * MCP resources are static, no-argument documents (the textbook fit for a
 * resource rather than a tool). The product identity gives agents a canonical
 * source for stella's branding and URLs, while the template marker grammar was
 * previously a `passthrough` tool (`template_marker_reference`) that carried no
 * tenant data. Both belong off the tool ceiling.
 *
 * Every resource is static guidance or a bundled application. A mode projects
 * the set to keep it answerable: every declared tool dependency must be in the
 * same caller's tool vocabulary. Shipped skills also follow catalog precedence,
 * so an enabled tenant skill shadows the shipped resource with the same slug.
 */
export type ResourceContext = McpFeatureAccessContext & {
  organizationId?: SafeId<"organization"> | undefined;
  safeDb?: SafeDb | undefined;
  userId?: SafeId<"user"> | undefined;
};

type StaticResource = {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  listed: boolean;
  feature?: DeploymentFeatureFlag;
  featureId?: FeatureId;
  requiredTools: (mode: McpMode) => readonly string[];
  read: (mode: McpMode) => string | Promise<string>;
  resourceMeta?: () => Record<string, unknown>;
};

const noRequiredTools = (): readonly string[] => [];
const sameRequiredTools = (tools: readonly string[]) => () => tools;

const TEMPLATE_MARKER_REQUIRED_TOOLS = [
  "create_template",
] as const satisfies readonly McpToolName[];
const TEMPLATE_FIELD_REQUIRED_TOOLS = [
  "configure_template_fields",
] as const satisfies readonly McpToolName[];

const PRODUCT_IDENTITY_URI = "stella://about";

const STELLA_PRODUCT_IDENTITY = {
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
    uri: STATUTE_TIMELINE_APP.uri,
    name: "statute-timeline",
    title: "Provision history",
    description: "View provision version windows and compare adjacent wording.",
    mimeType: MCP_APP_RESOURCE_MIME_TYPE,
    listed: false,
    requiredTools: sameRequiredTools(STATUTE_TIMELINE_APP.linkedTools),
    read: () => MCP_APP_BUNDLES["statute-timeline"],
    resourceMeta: () => ({
      ui: {
        csp: { connectDomains: [], resourceDomains: [] },
        prefersBorder: true,
      },
    }),
  },
  {
    uri: DECISION_READER_APP.uri,
    name: "decision-reader",
    title: "Decision reader",
    description: "Read a case-law decision and its cited provisions.",
    mimeType: MCP_APP_RESOURCE_MIME_TYPE,
    listed: false,
    requiredTools: sameRequiredTools(DECISION_READER_APP.linkedTools),
    read: () => MCP_APP_BUNDLES["decision-reader"],
    resourceMeta: () => ({
      ui: {
        csp: { connectDomains: [], resourceDomains: [] },
        prefersBorder: true,
      },
    }),
  },
  {
    uri: CASE_LAW_RESULTS_APP.uri,
    name: "case-law-results",
    title: "Case-law results",
    description:
      "Interactive results for case-law searches and identifier lookups.",
    mimeType: MCP_APP_RESOURCE_MIME_TYPE,
    listed: false,
    requiredTools: sameRequiredTools(CASE_LAW_RESULTS_APP.linkedTools),
    read: () => MCP_APP_BUNDLES["case-law-results"],
    resourceMeta: () => ({
      ui: {
        csp: { connectDomains: [], resourceDomains: [] },
        prefersBorder: true,
      },
    }),
  },
  {
    uri: PRODUCT_IDENTITY_URI,
    name: "stella-product-identity",
    title: "About stella",
    description:
      "Canonical product identity for stella: preferred casing, official " +
      "website, documentation, source code, support, and description.",
    mimeType: "application/json",
    listed: true,
    requiredTools: noRequiredTools,
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
    requiredTools: sameRequiredTools(TEMPLATE_MARKER_REQUIRED_TOOLS),
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
    requiredTools: sameRequiredTools(TEMPLATE_FIELD_REQUIRED_TOOLS),
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
    requiredTools: sameRequiredTools(TEMPLATE_WORKFLOW_TOOL_NAMES),
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
    requiredTools: legislationWorkflowToolNames,
    read: buildLegislationWorkflowReference,
  },
  {
    uri: FEEDBACK_WORKFLOW_REFERENCE_URI,
    name: "feedback-workflow",
    title: "Feedback workflow",
    description:
      "How to report a stella bug or gap: when it is worth filing, what a " +
      "report must never contain, the field-by-field schema, and the two " +
      "calls with a human approval between them. Read this before the first " +
      "prepare_feedback call.",
    mimeType: "text/markdown",
    listed: true,
    requiredTools: sameRequiredTools(FEEDBACK_WORKFLOW_TOOL_NAMES),
    read: buildFeedbackWorkflowReference,
  },
  {
    uri: DOCUMENT_UPLOAD_APP_RESOURCE_URI,
    name: "document-version-upload",
    title: "Upload document version",
    description:
      "Portable MCP App file picker for uploading a new version through stella's canonical file-transport capabilities.",
    mimeType: MCP_APP_RESOURCE_MIME_TYPE,
    listed: false,
    requiredTools: sameRequiredTools(DOCUMENT_UPLOAD_APP.linkedTools),
    // A text import makes Bun embed the generated app in the compiled API
    // binary. Reading from the source tree at runtime would work in dev but
    // fail in the production image, which ships only the compiled server.
    read: () => MCP_APP_BUNDLES["document-upload"],
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
    requiredTools: sameRequiredTools(FILE_COMPARISON_APP.linkedTools),
    read: () => MCP_APP_BUNDLES["file-comparison"],
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

type ResourceServingOptions = {
  resource: StaticResource;
  mode: McpMode;
  context?: ResourceContext | undefined;
  isFeatureEnabled?: typeof isMcpToolFeatureEnabled | undefined;
};

const isResourceServedInMode = ({
  resource,
  mode,
  context,
  isFeatureEnabled = isMcpToolFeatureEnabled,
}: ResourceServingOptions): boolean => {
  if (
    !isFeatureEnabled(resource.feature) ||
    !isMcpDescriptorFeatureEnabled({
      context,
      kind: "resources",
      id: resource.uri,
      featureId: resource.featureId,
    })
  ) {
    return false;
  }

  const vocabulary = surfaceToolVocabulary(mode, context);
  return resource.requiredTools(mode).every((name) => {
    if (!vocabulary.listed.has(name)) {
      return false;
    }
    const tool = getStaticMcpToolDefinition(name, mode);
    return tool !== undefined && isFeatureEnabled(tool.feature);
  });
};

const shippedSkillResources = (
  visibleNames: ReadonlySet<string>,
): StaticResource[] =>
  listSkillMetadata().flatMap((metadata) => {
    if (!visibleNames.has(metadata.name)) {
      return [];
    }
    const skill = loadSkill(metadata.name);
    const rootUri = `stella://skills/${skill.name}`;
    const requiredTools = sameRequiredTools(
      readSkillRequiredTools(skill.metadata),
    );
    return [
      {
        uri: rootUri,
        name: skill.name,
        title: readSkillDisplayName(skill),
        description: skill.description,
        mimeType: "text/markdown",
        listed: true,
        requiredTools,
        read: () => skill.body,
      },
      ...skill.resources.map(({ path }) => {
        const resource = readSkillResource({
          skillId: skill.name,
          resourcePath: path,
        });
        if (resource === null) {
          return panic(`Missing shipped skill resource: ${skill.name}/${path}`);
        }
        return {
          uri: `${rootUri}/${path}`,
          name: `${skill.name}/${path}`,
          title: `${readSkillDisplayName(skill)}: ${path}`,
          description: `Reference file for the ${skill.name} shipped skill.`,
          mimeType: "text/plain",
          listed: true,
          requiredTools,
          read: () => resource.content,
        };
      }),
    ];
  });

const visibleShippedSkillNames = async (
  context: ResourceContext | undefined,
): Promise<ReadonlySet<string>> => {
  if (
    context?.safeDb === undefined ||
    context.organizationId === undefined ||
    context.userId === undefined
  ) {
    return new Set(listSkillMetadata().map(({ name }) => name));
  }
  const catalog = await listAvailableChatSkillMetadata({
    organizationId: context.organizationId,
    safeDb: context.safeDb,
    userId: context.userId,
  });
  const skills = catalog.unwrap("Failed to load shipped skill resources");
  return new Set(
    skills
      .filter(({ source }) => source === CHAT_SKILL_SOURCE.builtIn)
      .map(({ name }) => name),
  );
};

const resourcesFor = async (context: ResourceContext | undefined) => [
  ...STATIC_RESOURCES,
  ...shippedSkillResources(await visibleShippedSkillNames(context)),
];

type ListMcpResourcesOptions = Pick<
  ResourceServingOptions,
  "context" | "isFeatureEnabled"
>;

export const listMcpResources = async (
  mode: McpMode,
  { context, isFeatureEnabled }: ListMcpResourcesOptions = {},
): Promise<Resource[]> =>
  (await resourcesFor(context))
    .filter(
      (resource) =>
        resource.listed &&
        isResourceServedInMode({ resource, mode, context, isFeatureEnabled }),
    )
    .map(({ description, mimeType, name, title, uri }) => ({
      uri,
      name,
      title,
      description,
      mimeType,
    }));

export const readMcpResource = async (
  uri: string,
  mode: McpMode,
  context?: ResourceContext,
): Promise<ReadResourceResult> => {
  const resource = (await resourcesFor(context)).find(
    (entry) => entry.uri === uri,
  );
  if (!resource || !isResourceServedInMode({ resource, mode, context })) {
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

export const scopeMcpResourceReferences = async (
  text: string,
  {
    mode,
    context,
  }: {
    mode: McpMode;
    context?: McpFeatureAccessContext | undefined;
  },
): Promise<string> => {
  const hiddenUris = (await resourcesFor(context))
    .filter((resource) => !isResourceServedInMode({ resource, mode, context }))
    .map((resource) => resource.uri);
  if (!hiddenUris.some((uri) => text.includes(uri))) {
    return text;
  }
  return text
    .split(/(?<=[.!?])\s+/u)
    .filter((sentence) => !hiddenUris.some((uri) => sentence.includes(uri)))
    .join(" ");
};
