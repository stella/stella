import { Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import { entities, extractedContent, fields } from "@/api/db/schema";
import { readEntityByIdHandler } from "@/api/handlers/entities/read-by-id";
import { loadAnonymizationGazetteerEntries } from "@/api/lib/anonymization-blacklist";
import { decryptContent } from "@/api/lib/content-encryption";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";
import { getSearchProvider } from "@/api/lib/search/provider";
import { anonymizeTextFields } from "@/api/mcp/anonymization";
import type { McpRequestContext } from "@/api/mcp/context";
import type { McpToolDefinition, McpToolHandler } from "@/api/mcp/tool-types";
import {
  buildDocumentUrl,
  buildMatterUrl,
  DEFAULT_COMPAT_SEARCH_LIMIT,
  ensureWorkspaceAccess,
  errorResult,
  MAX_SEARCH_LIMIT,
  normalizeTextField,
  parseRequiredString,
  stringProp,
  textResult,
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
const COMPAT_FETCH_CONTENT_MAX_CHARS = 8000;

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

  const safeEntityIds = entityIds.map(brandPersistedEntityId);

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
          inArray(extractedContent.entityId, safeEntityIds),
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
  context,
  results,
}: {
  context: McpRequestContext;
  results: CompatSearchResult[];
}) => {
  if (results.length === 0) {
    return [];
  }

  const gazetteerEntries = await loadAnonymizationGazetteerEntries({
    organizationId: context.organizationId,
    scopedDb: context.scopedDb,
  });

  const byWorkspace = new Map<
    string,
    { indexes: number[]; titles: string[] }
  >();
  for (const [index, result] of results.entries()) {
    const group = byWorkspace.get(result.workspaceId);
    if (group) {
      group.indexes.push(index);
      group.titles.push(result.title);
      continue;
    }
    byWorkspace.set(result.workspaceId, {
      indexes: [index],
      titles: [result.title],
    });
  }

  const output: (Omit<CompatSearchResult, "workspaceId"> | undefined)[] =
    Array.from({ length: results.length });

  for (const [workspaceId, group] of byWorkspace) {
    const anonymized = await anonymizeTextFields({
      fields: group.titles,
      gazetteerEntries,
      organizationId: context.organizationId,
      scopedDb: context.scopedDb,
      workspaceId,
    });

    for (const [groupIndex, resultIndex] of group.indexes.entries()) {
      const result = results[resultIndex];
      if (result === undefined) {
        continue;
      }
      output[resultIndex] = {
        id: result.id,
        title: normalizeTextField({
          allowEmptyFallback: false,
          fallback: result.title,
          missingFallback: ANONYMIZED_FIELD_MISSING_FALLBACK,
          value: anonymized.fields[groupIndex],
        }),
        url: result.url,
      };
    }
  }

  const normalizedResults: Omit<CompatSearchResult, "workspaceId">[] = [];
  for (const result of output) {
    if (result === undefined) {
      continue;
    }
    normalizedResults.push(result);
  }

  return normalizedResults;
};

const anonymizeCompatFetchPayload = async ({
  context,
  text,
  title,
  workspaceId,
}: {
  context: McpRequestContext;
  text: string;
  title: string;
  workspaceId: string;
}) => {
  const anonymized = await anonymizeTextFields({
    fields: [title, text],
    organizationId: context.organizationId,
    scopedDb: context.scopedDb,
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

const getCompatSearchEntityIds = (hits: readonly unknown[]) =>
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
        query: stringProp("Search query", {
          maxLength: LIMITS.searchQueryMaxLength,
        }),
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
] as const satisfies readonly McpToolDefinition[];

export const ANONYMIZED_COMPAT_TOOL_DEFINITIONS = [
  {
    annotations: { readOnlyHint: true },
    description:
      "Search anonymized knowledge across accessible matters using the " +
      "OpenAI-compatible search tool shape. Returns anonymized titles with ids and urls for follow-up fetch calls.",
    inputSchema: {
      type: "object",
      properties: {
        query: stringProp("Search query", {
          maxLength: LIMITS.searchQueryMaxLength,
        }),
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
] as const satisfies readonly McpToolDefinition[];

const handleCompatSearchTool: McpToolHandler = async ({
  args,
  context,
  mode,
}) => {
  const query = parseRequiredString(args, "query", {
    maxLength: LIMITS.searchQueryMaxLength,
  });
  if (typeof query !== "string") {
    return query;
  }

  const limit = DEFAULT_COMPAT_SEARCH_LIMIT;
  const compatLimit = Math.min(limit * 2, MAX_SEARCH_LIMIT);
  const result = await getSearchProvider().search({
    query,
    organizationId: context.organizationId,
    workspaceIds: context.accessibleWorkspaceIds,
    limit: compatLimit,
  });

  const hits = getCompatSearchHits({
    hits: result.hits.map((hit) => ({
      entityId: hit.entityId,
      workspaceId: hit.workspaceId,
      name: hit.title,
    })),
  });
  const fetchableMap = await getFetchableEntityMap({
    context,
    entityIds: getCompatSearchEntityIds(hits),
  });
  const limitedResults = mapCompatSearchResults({
    fetchableMap,
    hits,
  }).slice(0, limit);

  if (mode === "anonymized") {
    // MCP access is for authorized Stella users only. In anonymized
    // mode we still search raw, non-anonymized indexed text so
    // retrieval quality stays useful, then anonymize all returned
    // corpus text before it leaves Stella for the AI client.
    return textResult({
      results: await anonymizeCompatSearchResults({
        context,
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
  const rawEntityId = parseRequiredString(args, "id");
  if (typeof rawEntityId !== "string") {
    return rawEntityId;
  }
  const entityId = brandPersistedEntityId(rawEntityId);

  if (context.accessibleWorkspaceIds.length === 0) {
    return errorResult("Document content is unavailable");
  }

  const row = await context.scopedDb((tx) =>
    tx.query.extractedContent.findFirst({
      where: {
        entityId: { eq: entityId },
        organizationId: { eq: context.organizationId },
        workspaceId: { in: context.accessibleWorkspaceIds },
      },
      with: {
        entity: {
          columns: {
            name: true,
            workspaceId: true,
          },
        },
      },
    }),
  );

  if (!row?.entity) {
    return errorResult("Document content is unavailable");
  }

  const text = await decryptContent(
    context.organizationId,
    row.ciphertext,
    row.iv,
  );
  const truncated = text.length > COMPAT_FETCH_CONTENT_MAX_CHARS;
  const result = {
    charCount: row.charCount,
    name: row.entity.name,
    text: truncated ? text.slice(0, COMPAT_FETCH_CONTENT_MAX_CHARS) : text,
    truncated,
    workspaceId: row.entity.workspaceId,
  };

  const fetchPayload = getCompatFetchPayload({ entityId: rawEntityId, result });
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
        entityId: rawEntityId,
        fieldId: fileField.id,
        workspaceId: fetchPayload.workspaceId,
      });
    }
  }

  if (mode === "anonymized") {
    // Same boundary as anonymized search: the user may fetch a raw
    // document internally, but the AI client receives only the
    // anonymized title/body generated below.
    const anonymized = await anonymizeCompatFetchPayload({
      context,
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
    id: rawEntityId,
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
