import { Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import { entities, extractedContent, fields } from "@/api/db/schema";
import { readEntityByIdHandler } from "@/api/handlers/entities/read-by-id";
import { anonymizeTextFields } from "@/api/mcp/anonymization";
import type { McpRequestContext } from "@/api/mcp/context";
import type { McpToolDefinition, McpToolHandler } from "@/api/mcp/tool-types";
import {
  buildDocumentUrl,
  buildMatterUrl,
  DEFAULT_COMPAT_SEARCH_LIMIT,
  ensureWorkspaceAccess,
  errorResult,
  getOrgTools,
  hasErrorMessage,
  MAX_SEARCH_LIMIT,
  MCP_TOOL_EXECUTION_OPTIONS,
  normalizeTextField,
  parseRequiredString,
  stringProp,
  textResult,
  toolThrownErrorToMcpResult,
} from "@/api/mcp/tool-utils";

type CompatToolName = "fetch" | "search";

type FetchableEntity = {
  entityId: string;
  fieldId: string | null;
  workspaceId: string;
};

type CompatSearchResult = {
  id: string;
  title: string;
  url: string;
  workspaceId: string;
};

type CompatFetchPayload = {
  charCount: number | null;
  text: string;
  title: string;
  truncated: boolean;
  workspaceId: string;
};

const ANONYMIZED_FIELD_MISSING_FALLBACK = "[REDACTED]";

const getFetchableEntityMap = async ({
  context,
  entityIds,
}: {
  context: McpRequestContext;
  entityIds: string[];
}) => {
  if (entityIds.length === 0) {
    return new Map<string, FetchableEntity>();
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

  const fetchableEntityMap = new Map<string, FetchableEntity>();

  for (const row of rows) {
    const existing = fetchableEntityMap.get(row.entityId);
    if (existing && existing.fieldId !== null) {
      continue;
    }

    fetchableEntityMap.set(row.entityId, row);
  }

  return fetchableEntityMap;
};

const anonymizeCompatSearchResults = async ({
  results,
}: {
  results: CompatSearchResult[];
}) =>
  await Promise.all(
    results.map(async ({ workspaceId, ...result }) => {
      const anonymized = await anonymizeTextFields({
        fields: [result.title],
        workspaceId,
      });

      return {
        ...result,
        title: normalizeTextField({
          allowEmptyFallback: false,
          fallback: result.title,
          missingFallback: ANONYMIZED_FIELD_MISSING_FALLBACK,
          value: anonymized.fields[0],
        }),
      };
    }),
  );

const anonymizeCompatFetchPayload = async ({
  text,
  title,
  workspaceId,
}: {
  text: string;
  title: string;
  workspaceId: string;
}) => {
  const anonymized = await anonymizeTextFields({
    fields: [title, text],
    workspaceId,
  });

  return {
    anonymizedEntityCount: anonymized.entityCount,
    text: normalizeTextField({
      allowEmptyFallback: false,
      fallback: text,
      missingFallback: ANONYMIZED_FIELD_MISSING_FALLBACK,
      value: anonymized.fields[1],
    }),
    title: normalizeTextField({
      allowEmptyFallback: false,
      fallback: title,
      missingFallback: ANONYMIZED_FIELD_MISSING_FALLBACK,
      value: anonymized.fields[0],
    }),
  };
};

const getCompatSearchHits = (result: unknown): unknown[] => {
  if (typeof result !== "object" || result === null || !("hits" in result)) {
    return [];
  }

  const { hits } = result;
  return Array.isArray(hits) ? hits : [];
};

const getCompatSearchEntityIds = (hits: unknown[]) =>
  hits.flatMap((hit) => {
    if (typeof hit !== "object" || hit === null || !("entityId" in hit)) {
      return [];
    }

    return typeof hit.entityId === "string" ? [hit.entityId] : [];
  });

const mapCompatSearchResults = ({
  fetchableMap,
  hits,
}: {
  fetchableMap: Map<string, FetchableEntity>;
  hits: unknown[];
}) =>
  hits.flatMap((hit): CompatSearchResult[] => {
    if (typeof hit !== "object" || hit === null) {
      return [];
    }

    const entityId = "entityId" in hit ? hit.entityId : undefined;
    const title = "name" in hit ? hit.name : undefined;
    const workspaceId = "workspaceId" in hit ? hit.workspaceId : undefined;

    if (
      typeof entityId !== "string" ||
      typeof title !== "string" ||
      typeof workspaceId !== "string"
    ) {
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
        workspaceId,
      },
    ];
  });

const getCompatFetchPayload = ({
  entityId,
  result,
}: {
  entityId: string;
  result: unknown;
}): CompatFetchPayload | null => {
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
    return null;
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

  return {
    charCount,
    text,
    title,
    truncated,
    workspaceId,
  };
};

export const COMPAT_TOOL_DEFINITIONS = [
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
] satisfies McpToolDefinition[];

export const ANONYMIZED_COMPAT_TOOL_DEFINITIONS = [
  {
    annotations: { readOnlyHint: true },
    description:
      "Search anonymized knowledge across accessible matters using the " +
      "OpenAI-compatible search tool shape. Returns anonymized titles with ids and urls for follow-up fetch calls.",
    inputSchema: {
      type: "object",
      properties: {
        query: stringProp("Search query"),
      },
      required: ["query"],
    },
    name: "search",
    scope: "stella:search_anonymized",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Fetch anonymized document text by id using the OpenAI-compatible fetch " +
      "tool shape. Use ids returned by the anonymized search tool.",
    inputSchema: {
      type: "object",
      properties: {
        id: stringProp("Document/entity ID"),
      },
      required: ["id"],
    },
    name: "fetch",
    scope: "stella:read_anonymized",
  },
] satisfies McpToolDefinition[];

const handleCompatSearchTool: McpToolHandler = async ({
  args,
  context,
  mode,
}) => {
  const query = parseRequiredString(args, "query");
  if (typeof query !== "string") {
    return query;
  }

  const executeSearchAcrossMatters =
    getOrgTools(context)["search-across-matters"].execute;
  if (!executeSearchAcrossMatters) {
    return errorResult("Tool is not executable");
  }

  const limit = DEFAULT_COMPAT_SEARCH_LIMIT;
  const compatLimit = Math.min(limit * 2, MAX_SEARCH_LIMIT);
  let result: Awaited<ReturnType<typeof executeSearchAcrossMatters>>;
  try {
    result = await executeSearchAcrossMatters(
      { limit: compatLimit, query },
      MCP_TOOL_EXECUTION_OPTIONS,
    );
  } catch (error) {
    const mapped = toolThrownErrorToMcpResult(error);
    if (mapped) {
      return mapped;
    }
    throw error;
  }
  if (hasErrorMessage(result)) {
    return errorResult(result.error);
  }

  const hits = getCompatSearchHits(result);
  const fetchableMap = await getFetchableEntityMap({
    context,
    entityIds: getCompatSearchEntityIds(hits),
  });
  const limitedResults = mapCompatSearchResults({
    fetchableMap,
    hits,
  }).slice(0, limit);

  if (mode === "anonymized") {
    return textResult({
      results: await anonymizeCompatSearchResults({
        results: limitedResults,
      }),
    });
  }

  return textResult({
    results: limitedResults.map(({ workspaceId: _workspaceId, ...hit }) => hit),
  });
};

const handleCompatFetchTool: McpToolHandler = async ({
  args,
  context,
  mode,
}) => {
  const entityId = parseRequiredString(args, "id");
  if (typeof entityId !== "string") {
    return entityId;
  }

  const executeReadContentAcrossMatters =
    getOrgTools(context)["read-content-across-matters"].execute;
  if (!executeReadContentAcrossMatters) {
    return errorResult("Tool is not executable");
  }

  let result: Awaited<ReturnType<typeof executeReadContentAcrossMatters>>;
  try {
    result = await executeReadContentAcrossMatters(
      { entityId },
      MCP_TOOL_EXECUTION_OPTIONS,
    );
  } catch (error) {
    const mapped = toolThrownErrorToMcpResult(error);
    if (mapped) {
      return mapped;
    }
    throw error;
  }
  if (hasErrorMessage(result)) {
    return errorResult(result.error);
  }

  const fetchPayload = getCompatFetchPayload({ entityId, result });
  if (!fetchPayload) {
    return errorResult("Document content is unavailable");
  }

  const workspaceAccess = ensureWorkspaceAccess({
    context,
    workspaceId: fetchPayload.workspaceId,
  });
  if (!workspaceAccess) {
    return errorResult("Matter not found or not accessible");
  }

  const entityResult = await Result.gen(() =>
    readEntityByIdHandler({
      safeDb: context.safeDb,
      workspaceId: workspaceAccess,
      entityId,
    }),
  );

  let url = buildMatterUrl(fetchPayload.workspaceId);
  if (Result.isOk(entityResult)) {
    const entity = entityResult.value;
    const fileField = entity.fields.find(
      (field: { content: { type: string } }) => field.content.type === "file",
    );
    if (fileField) {
      url = buildDocumentUrl({
        entityId,
        fieldId: fileField.id,
        workspaceId: fetchPayload.workspaceId,
      });
    }
  }

  if (mode === "anonymized") {
    const anonymized = await anonymizeCompatFetchPayload({
      text: fetchPayload.text,
      title: fetchPayload.title,
      workspaceId: fetchPayload.workspaceId,
    });

    return textResult({
      id: entityId,
      title: anonymized.title,
      text: anonymized.text,
      url,
      metadata: {
        anonymized: true,
        anonymizedEntityCount: anonymized.anonymizedEntityCount,
        charCount: fetchPayload.charCount,
        source: "stella",
        truncated: fetchPayload.truncated,
        workspaceId: fetchPayload.workspaceId,
      },
    });
  }

  return textResult({
    id: entityId,
    title: fetchPayload.title,
    text: fetchPayload.text,
    url,
    metadata: {
      charCount: fetchPayload.charCount,
      source: "stella",
      truncated: fetchPayload.truncated,
      workspaceId: fetchPayload.workspaceId,
    },
  });
};

export const COMPAT_TOOL_HANDLERS = {
  fetch: handleCompatFetchTool,
  search: handleCompatSearchTool,
} satisfies Record<CompatToolName, McpToolHandler>;
