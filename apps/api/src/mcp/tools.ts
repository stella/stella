import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolExecutionOptions } from "ai";
import { and, eq, inArray, sql } from "drizzle-orm";

import { entities, extractedContent, fields } from "@/api/db/schema";
import { env } from "@/api/env";
import { readEntityByIdHandler } from "@/api/handlers/entities/read-by-id";
import { createOrgTools } from "@/api/handlers/registry/actors/chat-tools";
import { readWorkspaceHandler } from "@/api/handlers/workspaces/read-by-id";
import { readOverviewHandler } from "@/api/handlers/workspaces/read-overview";
import { readWorkspaceContactsHandler } from "@/api/handlers/workspaces/workspace-contacts-read";
import { captureError } from "@/api/lib/analytics";
import { LIMITS } from "@/api/lib/limits";
import type { McpRequestContext } from "@/api/mcp/context";
import { getAccessibleWorkspaceId } from "@/api/mcp/context";

type JsonSchema = McpTool["inputSchema"];
type ToolScope = "stella:read" | "stella:search";

type McpToolDefinition = {
  annotations?: McpTool["annotations"];
  description: string;
  inputSchema: JsonSchema;
  name: string;
  scope: ToolScope;
};

const DEFAULT_LIST_LIMIT = 25;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_LIST_LIMIT = 100;
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_COMPAT_SEARCH_LIMIT = 8;
const MCP_TOOL_EXECUTION_OPTIONS: ToolExecutionOptions = {
  messages: [],
  toolCallId: "mcp",
};

const getAppBaseUrl = () => env.FRONTEND_URL.replace(/\/$/, "");

const stringProp = (description: string) =>
  ({ type: "string", description }) as const;

const intProp = (description: string, opts?: { max?: number; min?: number }) =>
  ({
    type: "integer",
    description,
    ...(opts?.min === undefined ? {} : { minimum: opts.min }),
    ...(opts?.max === undefined ? {} : { maximum: opts.max }),
  }) as const;

const enumProp = (description: string, values: readonly string[]) =>
  ({ type: "string", enum: values, description }) as const;

const textResult = (data: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});

const errorResult = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

const hasErrorMessage = (value: unknown): value is { error: string } => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("error" in value)) {
    return false;
  }

  return typeof value.error === "string" && value.error.length > 0;
};

const parseRequiredString = (
  args: Record<string, unknown>,
  key: string,
): string | CallToolResult => {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    return errorResult(`Missing required parameter: ${key}`);
  }
  return value;
};

const parseOptionalEnum = <TValues extends readonly string[]>({
  args,
  defaultValue,
  key,
  values,
}: {
  args: Record<string, unknown>;
  defaultValue: TValues[number];
  key: string;
  values: TValues;
}): TValues[number] | CallToolResult => {
  const value = args[key];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "string" || !values.includes(value)) {
    return errorResult(
      `Invalid parameter: ${key}. Expected one of ${values.join(", ")}`,
    );
  }
  return value;
};

const parseOptionalLimit = ({
  args,
  defaultValue,
  key,
  max,
}: {
  args: Record<string, unknown>;
  defaultValue: number;
  key: string;
  max: number;
}): number | CallToolResult => {
  const value = args[key];
  if (value === undefined) {
    return defaultValue;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  ) {
    return errorResult(
      `Invalid parameter: ${key}. Expected an integer between 1 and ${max}`,
    );
  }
  return value;
};

const ensureWorkspaceAccess = ({
  context,
  workspaceId,
}: {
  context: McpRequestContext;
  workspaceId: string;
}) =>
  getAccessibleWorkspaceId({
    accessibleWorkspaceIdSet: context.accessibleWorkspaceIdSet,
    workspaceId,
  });

const buildMatterUrl = (workspaceId: string) =>
  `${getAppBaseUrl()}/workspaces/${workspaceId}`;

const buildDocumentUrl = ({
  entityId,
  fieldId,
  workspaceId,
}: {
  entityId: string;
  fieldId: string;
  workspaceId: string;
}) =>
  `${getAppBaseUrl()}/workspaces/${workspaceId}/all/pdf?entity=${encodeURIComponent(entityId)}&field=${encodeURIComponent(fieldId)}`;

const getFetchableEntityMap = async ({
  context,
  entityIds,
}: {
  context: McpRequestContext;
  entityIds: string[];
}) => {
  if (entityIds.length === 0) {
    return new Map<
      string,
      { entityId: string; fieldId: string | null; workspaceId: string }
    >();
  }

  const rows = await context.scopedDb((tx) =>
    tx
      .select({
        entityId: extractedContent.entityId,
        workspaceId: extractedContent.workspaceId,
        fieldId: fields.id,
      })
      .from(extractedContent)
      .innerJoin(
        entities,
        and(
          eq(entities.id, extractedContent.entityId),
          eq(entities.workspaceId, extractedContent.workspaceId),
        ),
      )
      .leftJoin(
        fields,
        and(
          eq(fields.entityVersionId, entities.currentVersionId),
          sql`(${fields.content} ->> 'type') = 'file'`,
        ),
      )
      .where(
        and(
          eq(extractedContent.organizationId, context.organizationId),
          inArray(extractedContent.entityId, entityIds),
        ),
      ),
  );

  const fetchableEntityMap = new Map<
    string,
    { entityId: string; fieldId: string | null; workspaceId: string }
  >();

  for (const row of rows) {
    const existing = fetchableEntityMap.get(row.entityId);
    if (existing && existing.fieldId !== null) {
      continue;
    }

    fetchableEntityMap.set(row.entityId, row);
  }

  return fetchableEntityMap;
};

export const MCP_TOOL_DEFINITIONS = [
  {
    annotations: { readOnlyHint: true },
    description:
      "Search knowledge across accessible matters using the OpenAI-compatible " +
      "search tool shape. Returns results with id, title, and url for follow-up fetch calls.",
    inputSchema: {
      type: "object",
      properties: {
        query: stringProp("Search query"),
      },
      required: ["query"],
    },
    name: "search",
    scope: "stella:search",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Fetch a knowledge document by id using the OpenAI-compatible fetch " +
      "tool shape. Use ids returned by the search tool.",
    inputSchema: {
      type: "object",
      properties: {
        id: stringProp("Document/entity ID"),
      },
      required: ["id"],
    },
    name: "fetch",
    scope: "stella:read",
  },
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

const MCP_TOOL_DEFINITION_MAP = new Map(
  MCP_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]),
);

export const getMcpToolDefinition = (toolName: string) =>
  MCP_TOOL_DEFINITION_MAP.get(toolName);

export const listMcpTools = () =>
  MCP_TOOL_DEFINITIONS.map(
    ({ annotations, description, inputSchema, name }) => ({
      ...(annotations === undefined ? {} : { annotations }),
      description,
      inputSchema,
      name,
    }),
  );

const invokeAiTool = async <TArgs extends Record<string, unknown>>({
  args,
  tool,
}: {
  args: TArgs;
  tool: {
    execute?: (args: TArgs, options: ToolExecutionOptions) => unknown;
  };
}): Promise<CallToolResult> => {
  if (!tool.execute) {
    return errorResult("Tool is not executable");
  }

  const result = await tool.execute(args, MCP_TOOL_EXECUTION_OPTIONS);
  if (hasErrorMessage(result)) {
    return errorResult(result.error);
  }
  return textResult(result);
};

export const handleMcpToolCall = async ({
  args,
  context,
  toolName,
}: {
  args: Record<string, unknown>;
  context: McpRequestContext;
  toolName: string;
}): Promise<CallToolResult> => {
  const tool = getMcpToolDefinition(toolName);
  if (!tool) {
    return errorResult(`Unknown tool: ${toolName}`);
  }

  try {
    switch (toolName) {
      case "search": {
        const query = parseRequiredString(args, "query");
        if (typeof query !== "string") {
          return query;
        }

        const orgTools = createOrgTools({
          organizationId: context.organizationId,
          scopedDb: context.scopedDb,
        });
        const executeSearchAcrossMatters = orgTools.searchAcrossMatters.execute;
        if (!executeSearchAcrossMatters) {
          return errorResult("Tool is not executable");
        }

        const limit = DEFAULT_COMPAT_SEARCH_LIMIT;
        const compatLimit = Math.min(limit * 2, MAX_SEARCH_LIMIT);
        const result = await executeSearchAcrossMatters(
          { limit: compatLimit, query },
          MCP_TOOL_EXECUTION_OPTIONS,
        );
        if (hasErrorMessage(result)) {
          return errorResult(result.error);
        }

        const hits =
          typeof result === "object" &&
          result !== null &&
          "hits" in result &&
          Array.isArray(result.hits)
            ? result.hits
            : [];

        const fetchableMap = await getFetchableEntityMap({
          context,
          entityIds: hits.flatMap((hit) => {
            if (
              typeof hit !== "object" ||
              hit === null ||
              !("entityId" in hit)
            ) {
              return [];
            }
            return typeof hit.entityId === "string" ? [hit.entityId] : [];
          }),
        });

        const results = hits.flatMap((hit) => {
          if (typeof hit !== "object" || hit === null) {
            return [];
          }

          const entityId = "entityId" in hit ? hit.entityId : undefined;
          const title = "name" in hit ? hit.name : undefined;
          const workspaceId =
            "workspaceId" in hit ? hit.workspaceId : undefined;

          if (
            typeof entityId !== "string" ||
            typeof title !== "string" ||
            typeof workspaceId !== "string"
          ) {
            return [];
          }

          if (!fetchableMap.has(entityId)) {
            return [];
          }

          const fetchableEntity = fetchableMap.get(entityId);
          if (!fetchableEntity) {
            return [];
          }

          const url =
            fetchableEntity.fieldId === null
              ? buildMatterUrl(workspaceId)
              : buildDocumentUrl({
                  entityId,
                  fieldId: fetchableEntity.fieldId,
                  workspaceId,
                });

          return [
            {
              id: entityId,
              title,
              url,
            },
          ];
        });

        return textResult({
          results: results.slice(0, limit),
        });
      }

      case "fetch": {
        const entityId = parseRequiredString(args, "id");
        if (typeof entityId !== "string") {
          return entityId;
        }

        const orgTools = createOrgTools({
          organizationId: context.organizationId,
          scopedDb: context.scopedDb,
        });
        const executeReadContentAcrossMatters =
          orgTools.readContentAcrossMatters.execute;
        if (!executeReadContentAcrossMatters) {
          return errorResult("Tool is not executable");
        }

        const result = await executeReadContentAcrossMatters(
          { entityId },
          MCP_TOOL_EXECUTION_OPTIONS,
        );
        if (hasErrorMessage(result)) {
          return errorResult(result.error);
        }

        const workspaceId =
          typeof result === "object" &&
          result !== null &&
          "workspaceId" in result &&
          typeof result.workspaceId === "string"
            ? result.workspaceId
            : null;
        const title =
          typeof result === "object" &&
          result !== null &&
          "name" in result &&
          typeof result.name === "string" &&
          result.name.length > 0
            ? result.name
            : entityId;
        const text =
          typeof result === "object" &&
          result !== null &&
          "text" in result &&
          typeof result.text === "string"
            ? result.text
            : null;

        if (workspaceId === null || text === null) {
          return errorResult("Document content is unavailable");
        }

        const charCount =
          typeof result === "object" &&
          result !== null &&
          "charCount" in result &&
          typeof result.charCount === "number"
            ? result.charCount
            : null;
        const truncated =
          typeof result === "object" &&
          result !== null &&
          "truncated" in result &&
          typeof result.truncated === "boolean"
            ? result.truncated
            : false;

        const workspaceAccess = ensureWorkspaceAccess({
          context,
          workspaceId,
        });
        if (!workspaceAccess) {
          return errorResult("Matter not found or not accessible");
        }

        const entity = await readEntityByIdHandler({
          scopedDb: context.scopedDb,
          workspaceId: workspaceAccess,
          entityId,
        });

        let url = buildMatterUrl(workspaceId);
        if (
          typeof entity === "object" &&
          entity !== null &&
          "fields" in entity
        ) {
          const fileField = entity.fields.find(
            (field) => field.content.type === "file",
          );
          if (fileField) {
            url = buildDocumentUrl({
              entityId,
              fieldId: fileField.id,
              workspaceId,
            });
          }
        }

        return textResult({
          id: entityId,
          title,
          text,
          url,
          metadata: {
            charCount,
            source: "stella",
            truncated,
            workspaceId,
          },
        });
      }

      case "list_matters": {
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
      }

      case "get_matter_overview": {
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
      }

      case "search_across_matters": {
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

        const orgTools = createOrgTools({
          organizationId: context.organizationId,
          scopedDb: context.scopedDb,
        });

        return await invokeAiTool({
          args: { limit, query },
          tool: orgTools.searchAcrossMatters,
        });
      }

      case "read_content_across_matters": {
        const entityId = parseRequiredString(args, "entity_id");
        if (typeof entityId !== "string") {
          return entityId;
        }

        const orgTools = createOrgTools({
          organizationId: context.organizationId,
          scopedDb: context.scopedDb,
        });

        return await invokeAiTool({
          args: { entityId },
          tool: orgTools.readContentAcrossMatters,
        });
      }

      case "read_contact": {
        const contactId = parseRequiredString(args, "contact_id");
        if (typeof contactId !== "string") {
          return contactId;
        }

        const orgTools = createOrgTools({
          organizationId: context.organizationId,
          scopedDb: context.scopedDb,
        });

        return await invokeAiTool({
          args: { contactId },
          tool: orgTools.readContact,
        });
      }

      default:
        return errorResult(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    captureError(error, { source: "mcp", toolName });
    return errorResult("Tool execution failed");
  }
};
