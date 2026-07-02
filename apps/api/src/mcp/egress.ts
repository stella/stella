import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { loadAnonymizationGazetteerEntries } from "@/api/lib/anonymization-blacklist";
import { anonymizeTextFields } from "@/api/mcp/anonymization";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import type {
  McpCompatSearchResult,
  McpEgressPlan,
  McpToolResponse,
} from "@/api/mcp/tool-types";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import {
  isToolErrorResult,
  normalizeTextField,
  textResult,
  windowTextByCursor,
} from "@/api/mcp/tool-utils";

const ANONYMIZED_FIELD_MISSING_FALLBACK = "[REDACTED]";

/**
 * Central egress pipeline. A handler never sees the request mode: it returns a
 * finished `CallToolResult` (no tenant text, or its own windowing) or an egress
 * plan carrying the full pre-window payload. In anonymized mode this anonymizes
 * the plan's declared text fields on the whole payload, THEN windows, THEN
 * serializes, so an entity name can never be split across a window edge and
 * placeholders stay stable across consecutive windows of one document.
 */
export const finalizeMcpEgress = async ({
  context,
  mode,
  response,
}: {
  context: McpRequestContext;
  mode: McpMode;
  response: McpToolResponse;
}): Promise<CallToolResult> => {
  if (!isMcpEgressPlan(response)) {
    return response;
  }

  if (response.egress === "compatSearch") {
    return await finalizeCompatSearch({ context, mode, plan: response });
  }

  return await finalizeCompatFetch({ context, mode, plan: response });
};

const finalizeCompatSearch = async ({
  context,
  mode,
  plan,
}: {
  context: McpRequestContext;
  mode: McpMode;
  plan: Extract<McpEgressPlan, { egress: "compatSearch" }>;
}): Promise<CallToolResult> => {
  if (mode === "anonymized") {
    // MCP access is for authorized Stella users only. In anonymized mode we
    // still search raw, non-anonymized indexed text so retrieval quality stays
    // useful, then anonymize all returned corpus text before it leaves Stella
    // for the AI client.
    return textResult({
      nextCursor: plan.nextCursor,
      results: await anonymizeCompatSearchResults({
        context,
        results: [...plan.results],
      }),
    });
  }

  return textResult({
    nextCursor: plan.nextCursor,
    results: plan.results.map(({ workspaceId: _workspaceId, ...hit }) => hit),
  });
};

const finalizeCompatFetch = async ({
  context,
  mode,
  plan,
}: {
  context: McpRequestContext;
  mode: McpMode;
  plan: Extract<McpEgressPlan, { egress: "compatFetch" }>;
}): Promise<CallToolResult> => {
  if (mode === "anonymized") {
    // Same boundary as anonymized search: the user may fetch a raw document
    // internally, but the AI client receives only the anonymized title/body.
    // Anonymize the whole document first, then window the redacted text so no
    // entity name is split across a window edge.
    const anonymized = await anonymizeCompatFetchPayload({
      context,
      text: plan.text,
      title: plan.title,
      workspaceId: plan.workspaceId,
    });

    const textWindow = windowTextByCursor({
      cursor: plan.cursor,
      maxChars: plan.maxChars,
      text: anonymized.text,
    });
    if (isToolErrorResult(textWindow)) {
      return textWindow;
    }

    return textResult({
      id: plan.id,
      title: anonymized.title,
      text: textWindow.text,
      url: plan.url,
      nextCursor: textWindow.nextCursor,
      metadata: {
        anonymized: true,
        anonymizedEntityCount: anonymized.anonymizedEntityCount,
        charCount: textWindow.charCount,
        source: "stella",
        truncated: textWindow.truncated,
        workspaceId: plan.workspaceId,
      },
    });
  }

  const textWindow = windowTextByCursor({
    cursor: plan.cursor,
    maxChars: plan.maxChars,
    text: plan.text,
  });
  if (isToolErrorResult(textWindow)) {
    return textWindow;
  }

  return textResult({
    id: plan.id,
    title: plan.title,
    text: textWindow.text,
    url: plan.url,
    nextCursor: textWindow.nextCursor,
    metadata: {
      charCount: textWindow.charCount,
      source: "stella",
      truncated: textWindow.truncated,
      workspaceId: plan.workspaceId,
    },
  });
};

const anonymizeCompatSearchResults = async ({
  context,
  results,
}: {
  context: McpRequestContext;
  results: McpCompatSearchResult[];
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

  const output: (Omit<McpCompatSearchResult, "workspaceId"> | undefined)[] =
    Array.from({ length: results.length });

  for (const [workspaceId, group] of byWorkspace) {
    // oxlint-disable-next-line no-await-in-loop -- per-workspace anonymization bounds gazetteer/DB load across tenants
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

  const normalizedResults: Omit<McpCompatSearchResult, "workspaceId">[] = [];
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
