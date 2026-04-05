import { readWorkspaceHandler } from "@/api/handlers/workspaces/read-by-id";
import { readOverviewHandler } from "@/api/handlers/workspaces/read-overview";
import { readWorkspaceContactsHandler } from "@/api/handlers/workspaces/workspace-contacts-read";
import { LIMITS } from "@/api/lib/limits";
import type { McpToolDefinition, McpToolHandler } from "@/api/mcp/tool-types";
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  ensureWorkspaceAccess,
  enumProp,
  errorResult,
  getOrgTools,
  intProp,
  invokeAiTool,
  MAX_LIST_LIMIT,
  MAX_SEARCH_LIMIT,
  parseOptionalEnum,
  parseOptionalLimit,
  parseRequiredString,
  stringProp,
  textResult,
} from "@/api/mcp/tool-utils";

type StellaToolName =
  | "get_matter_overview"
  | "list_matters"
  | "read_contact"
  | "read_content_across_matters"
  | "search_across_matters";

export const STELLA_TOOL_DEFINITIONS = [
  {
    annotations: { readOnlyHint: true },
    description:
      "List the matters you can access. Use this first when the user does not " +
      "name a matter explicitly or when you need matter IDs for follow-up tools.",
    inputSchema: {
      type: "object",
      properties: {
        status: enumProp("Filter by matter status", ["active", "all"]),
        limit: intProp("Max matters to return", {
          min: 1,
          max: MAX_LIST_LIMIT,
        }),
      },
    },
    name: "list_matters",
    scope: "stella:read",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Get a compact overview of a matter including counts, recent entities, " +
      "and linked contacts. Use this to orient yourself before drilling in.",
    inputSchema: {
      type: "object",
      properties: {
        matter_id: stringProp("Matter/workspace ID"),
      },
      required: ["matter_id"],
    },
    name: "get_matter_overview",
    scope: "stella:read",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Search across all accessible matters. Use this when the user explicitly " +
      "asks to search outside a single matter or you do not yet know the right matter.",
    inputSchema: {
      type: "object",
      properties: {
        query: stringProp("Search query"),
        limit: intProp("Max results to return", {
          min: 1,
          max: MAX_SEARCH_LIMIT,
        }),
      },
      required: ["query"],
    },
    name: "search_across_matters",
    scope: "stella:search",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Read extracted text from a document found anywhere in your accessible " +
      "matters. Use after search_across_matters.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: stringProp("Entity ID"),
      },
      required: ["entity_id"],
    },
    name: "read_content_across_matters",
    scope: "stella:read",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Read a contact by ID. Use this after matter overview or entity metadata " +
      "surfaces a contact the user wants to inspect more closely.",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: stringProp("Contact ID"),
      },
      required: ["contact_id"],
    },
    name: "read_contact",
    scope: "stella:read",
  },
] satisfies McpToolDefinition[];

const handleListMattersTool: McpToolHandler = async ({ args, context }) => {
  const status = parseOptionalEnum({
    args,
    defaultValue: "active",
    key: "status",
    values: ["active", "all"] as const,
  });
  if (typeof status !== "string") {
    return status;
  }

  const limit = parseOptionalLimit({
    args,
    defaultValue: DEFAULT_LIST_LIMIT,
    key: "limit",
    max: MAX_LIST_LIMIT,
  });
  if (typeof limit !== "number") {
    return limit;
  }

  const matters = await context.scopedDb((tx) =>
    tx.query.workspaces.findMany({
      where: {
        organizationId: { eq: context.organizationId },
        ...(status === "all" ? {} : { status }),
      },
      columns: {
        id: true,
        name: true,
        reference: true,
        status: true,
        lastActivityAt: true,
        createdAt: true,
      },
      orderBy: { lastActivityAt: "desc" },
      limit,
    }),
  );

  return textResult({
    matters: matters.map((matter) => ({
      id: matter.id,
      name: matter.name,
      reference: matter.reference,
      status: matter.status,
      lastActivityAt: matter.lastActivityAt?.toISOString() ?? null,
      createdAt: matter.createdAt.toISOString(),
    })),
    totalCountLimit: LIMITS.workspacesCount,
  });
};

const handleGetMatterOverviewTool: McpToolHandler = async ({
  args,
  context,
}) => {
  const matterId = parseRequiredString(args, "matter_id");
  if (typeof matterId !== "string") {
    return matterId;
  }

  const workspaceId = ensureWorkspaceAccess({
    context,
    workspaceId: matterId,
  });
  if (!workspaceId) {
    return errorResult("Matter not found or not accessible");
  }

  const [workspace, overview, contacts] = await Promise.all([
    readWorkspaceHandler({
      organizationId: context.organizationId,
      scopedDb: context.scopedDb,
      workspaceId,
    }),
    readOverviewHandler({
      scopedDb: context.scopedDb,
      workspaceId,
    }),
    readWorkspaceContactsHandler({
      scopedDb: context.scopedDb,
      workspaceId,
    }),
  ]);

  if (
    typeof workspace !== "object" ||
    workspace === null ||
    !("name" in workspace)
  ) {
    return errorResult("Matter not found or not accessible");
  }

  return textResult({
    matter: {
      id: workspace.id,
      name: workspace.name,
      reference: workspace.reference,
      status: workspace.status,
      clientName: workspace.client?.displayName ?? null,
    },
    overview,
    contacts: contacts.flatMap((workspaceContact) => {
      if (!workspaceContact.contact) {
        return [];
      }
      return [
        {
          contactId: workspaceContact.contact.id,
          displayName: workspaceContact.contact.displayName,
          role: workspaceContact.role,
          type: workspaceContact.contact.type,
        },
      ];
    }),
  });
};

const handleSearchAcrossMattersTool: McpToolHandler = async ({
  args,
  context,
}) => {
  const query = parseRequiredString(args, "query");
  if (typeof query !== "string") {
    return query;
  }

  const limit = parseOptionalLimit({
    args,
    defaultValue: DEFAULT_SEARCH_LIMIT,
    key: "limit",
    max: MAX_SEARCH_LIMIT,
  });
  if (typeof limit !== "number") {
    return limit;
  }

  return await invokeAiTool({
    args: { limit, query },
    tool: getOrgTools(context).searchAcrossMatters,
  });
};

const handleReadContentAcrossMattersTool: McpToolHandler = async ({
  args,
  context,
}) => {
  const entityId = parseRequiredString(args, "entity_id");
  if (typeof entityId !== "string") {
    return entityId;
  }

  return await invokeAiTool({
    args: { entityId },
    tool: getOrgTools(context).readContentAcrossMatters,
  });
};

const handleReadContactTool: McpToolHandler = async ({ args, context }) => {
  const contactId = parseRequiredString(args, "contact_id");
  if (typeof contactId !== "string") {
    return contactId;
  }

  return await invokeAiTool({
    args: { contactId },
    tool: getOrgTools(context).readContact,
  });
};

export const STELLA_TOOL_HANDLERS = {
  get_matter_overview: handleGetMatterOverviewTool,
  list_matters: handleListMattersTool,
  read_contact: handleReadContactTool,
  read_content_across_matters: handleReadContentAcrossMattersTool,
  search_across_matters: handleSearchAcrossMattersTool,
} satisfies Record<StellaToolName, McpToolHandler>;
