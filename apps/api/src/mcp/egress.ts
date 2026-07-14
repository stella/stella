import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { loadAnonymizationGazetteerEntries } from "@/api/lib/anonymization-blacklist";
import { anonymizeTextFields } from "@/api/mcp/anonymization";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import type {
  McpEgressPlan,
  McpStructuredTextField,
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

  if (response.egress === "compatFetch") {
    return await finalizeCompatFetch({ context, mode, plan: response });
  }

  return await finalizeStructured({ context, mode, plan: response });
};

/**
 * Anonymize a flat list of text fields grouped by their `workspaceId` scope.
 * All fields sharing a scope are fed to `anonymizeTextFields` in one call so
 * placeholders stay consistent within a workspace (and, via the shared
 * gazetteer, across the whole payload). Each field's anonymized value is
 * written back through its `apply`; a field the redactor drops falls back to
 * `[REDACTED]` rather than leaking the original. Shared by `compatSearch` and
 * the generic `structured` variant.
 */
const anonymizeTextFieldsByWorkspace = async ({
  context,
  fields,
}: {
  context: McpRequestContext;
  fields: readonly McpStructuredTextField[];
}): Promise<void> => {
  if (fields.length === 0) {
    return;
  }

  const gazetteerEntries = await loadAnonymizationGazetteerEntries({
    organizationId: context.organizationId,
    scopedDb: context.scopedDb,
  });

  const byWorkspace = new Map<string, McpStructuredTextField[]>();
  for (const field of fields) {
    const group = byWorkspace.get(field.workspaceId);
    if (group) {
      group.push(field);
      continue;
    }
    byWorkspace.set(field.workspaceId, [field]);
  }

  for (const [workspaceId, group] of byWorkspace) {
    // oxlint-disable-next-line no-await-in-loop -- per-workspace anonymization bounds gazetteer/DB load across tenants
    const anonymized = await anonymizeTextFields({
      fields: group.map((field) => field.value),
      gazetteerEntries,
      organizationId: context.organizationId,
      scopedDb: context.scopedDb,
      workspaceId,
    });

    for (const [index, field] of group.entries()) {
      field.apply(
        normalizeTextField({
          allowEmptyFallback: false,
          fallback: field.value,
          missingFallback: ANONYMIZED_FIELD_MISSING_FALLBACK,
          value: anonymized.fields[index],
        }),
      );
    }
  }
};

const finalizeStructured = async ({
  context,
  mode,
  plan,
}: {
  context: McpRequestContext;
  mode: McpMode;
  plan: Extract<McpEgressPlan, { egress: "structured" }>;
}): Promise<CallToolResult> => {
  // Anonymize the declared text fields on the whole payload first (anonymized
  // mode only), THEN window, so an entity name can never straddle a window edge
  // and placeholders stay stable across windows of one field.
  if (mode === "anonymized") {
    await anonymizeTextFieldsByWorkspace({ context, fields: plan.textFields });
  }

  if (plan.window) {
    const textWindow = windowTextByCursor({
      cursor: plan.window.cursor,
      maxChars: plan.window.maxChars,
      text: plan.window.read(),
    });
    if (isToolErrorResult(textWindow)) {
      return textWindow;
    }
    plan.window.apply(textWindow);
  }

  return textResult(plan.payload);
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
  // `workspaceId` is per-hit attribution the egress pipeline uses to group
  // anonymization; it is stripped before the result reaches the client.
  const results = plan.results.map(
    ({ workspaceId: _workspaceId, ...hit }) => hit,
  );

  // MCP access is for authorized Stella users only. In anonymized mode we still
  // search raw, non-anonymized indexed text so retrieval quality stays useful,
  // then anonymize the returned titles, grouped per workspace, before they
  // leave Stella for the AI client.
  if (mode === "anonymized") {
    await anonymizeTextFieldsByWorkspace({
      context,
      fields: plan.results.map((hit, index) => ({
        apply: (value) => {
          const target = results[index];
          if (target) {
            target.title = value;
          }
        },
        value: hit.title,
        workspaceId: hit.workspaceId,
      })),
    });
  }

  return textResult({ nextCursor: plan.nextCursor, results });
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
