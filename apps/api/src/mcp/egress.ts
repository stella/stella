import { panic } from "better-result";

import { loadAnonymizationAllowlistCanonicalsByWorkspace } from "@/api/lib/anonymization-allowlist";
import { loadAnonymizationGazetteerEntriesByWorkspace } from "@/api/lib/anonymization-blacklist";
import { anonymizeTextFields } from "@/api/mcp/anonymization";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import type {
  InternalToolResult,
  McpEgressPlan,
  McpStructuredTextField,
  McpToolResponse,
  TypedMcpToolResponse,
} from "@/api/mcp/tool-types";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import {
  isToolErrorResult,
  normalizeTextField,
  toolDataResult,
  windowTextByCursor,
} from "@/api/mcp/tool-utils";

const ANONYMIZED_FIELD_MISSING_FALLBACK = "[REDACTED]";

/**
 * Central egress pipeline. A handler never sees the request mode: it returns a
 * finished internal result (no tenant text, or its own windowing) or an egress
 * plan carrying the full pre-window payload. In anonymized mode this anonymizes
 * the plan's declared text fields on the whole payload, then windows, so an
 * entity name can never be split across a window edge and
 * placeholders stay stable across consecutive windows of one document.
 *
 * Deliberately out of scope: tenant/entity ids. This pipeline (and the
 * `textFields` a tool declares) anonymizes authored PII/tenant *text*, never
 * identifiers — an id is never a declared text field and this function never
 * touches one. MCP is a programmatic API surface for authenticated,
 * tenant-scoped callers (OAuth/machine-API-key external clients, and the chat
 * registry adapter in default mode) that need real ids back to make follow-up
 * calls (e.g. `read_document({ entity_id })`); redacting them would break the
 * surface's basic usability. Which ids a caller can even see is enforced
 * upstream, by each handler's own workspace-scoped query and
 * `McpRequestContext.accessibleWorkspaceIdSet` (`workspace-access-boundary.ts`),
 * not here. The chat registry adapter (`run-registry-tool.ts`) is the one
 * caller that also crosses into third-party model context: it runs this same
 * pipeline, then separately rewrites ids into opaque chat refs and fails
 * closed on any raw uuid that slips through (`projectForChat` in
 * `projection-schema.ts`). That backstop belongs there, not here, because
 * this pipeline itself never hands output to a model.
 */
type FinalizeToolEgressOptions<TResponse extends McpToolResponse> = {
  context: McpRequestContext;
  mode: McpMode;
  response: TResponse;
};

type EgressDependencies = {
  /** Provider boundary for anonymizing tenant-authored text. */
  anonymizeTextFields?: typeof anonymizeTextFields | undefined;
  loadAnonymizationAllowlistCanonicalsByWorkspace?:
    | typeof loadAnonymizationAllowlistCanonicalsByWorkspace
    | undefined;
  loadAnonymizationGazetteerEntriesByWorkspace?:
    | typeof loadAnonymizationGazetteerEntriesByWorkspace
    | undefined;
};

export function finalizeToolEgress<TData>(
  options: FinalizeToolEgressOptions<TypedMcpToolResponse<TData>>,
  dependencies?: EgressDependencies,
): Promise<InternalToolResult<TData>>;
export function finalizeToolEgress(
  options: FinalizeToolEgressOptions<McpToolResponse>,
  dependencies?: EgressDependencies,
): Promise<InternalToolResult>;
export async function finalizeToolEgress(
  { context, mode, response }: FinalizeToolEgressOptions<McpToolResponse>,
  {
    anonymizeTextFields: anonymize = anonymizeTextFields,
    loadAnonymizationAllowlistCanonicalsByWorkspace:
      loadAllowlist = loadAnonymizationAllowlistCanonicalsByWorkspace,
    loadAnonymizationGazetteerEntriesByWorkspace:
      loadGazetteer = loadAnonymizationGazetteerEntriesByWorkspace,
  }: EgressDependencies = {},
): Promise<InternalToolResult> {
  if (!isMcpEgressPlan(response)) {
    return response;
  }

  const anonymizer = { anonymize, loadAllowlist, loadGazetteer };

  if (response.egress === "compatSearch") {
    return await finalizeCompatSearch({
      anonymizer,
      context,
      mode,
      plan: response,
    });
  }

  if (response.egress === "compatFetch") {
    return await finalizeCompatFetch({
      anonymizer,
      context,
      mode,
      plan: response,
    });
  }

  return await finalizeStructured({
    anonymizer,
    context,
    mode,
    plan: response,
  });
}

type EgressAnonymizer = {
  anonymize: typeof anonymizeTextFields;
  loadAllowlist: typeof loadAnonymizationAllowlistCanonicalsByWorkspace;
  loadGazetteer: typeof loadAnonymizationGazetteerEntriesByWorkspace;
};

/** Both loaders answer for every id they are handed, so a miss is a defect. */
const catalogFor = <TCatalog>(
  catalogs: ReadonlyMap<string, TCatalog>,
  workspaceId: string,
): TCatalog => {
  const catalog = catalogs.get(workspaceId);
  if (catalog === undefined) {
    return panic(
      "Anonymization catalog missing for a workspace the payload names",
      { workspaceId },
    );
  }
  return catalog;
};

/**
 * Anonymize a flat list of text fields grouped by their `workspaceId` scope.
 * All fields sharing a scope are fed to `anonymizeTextFields` in one call so
 * placeholders stay consistent within that workspace. Each field's anonymized
 * value is written back through its `apply`; a field the redactor drops falls
 * back to `[REDACTED]` rather than leaking the original. Shared by
 * `compatSearch` and the generic `structured` variant.
 *
 * Both catalogs are read once here, for exactly the workspaces the payload
 * names, and handed to each call pre-resolved: two queries for the payload
 * rather than two per workspace. Each group still gets its own tier — org-wide
 * terms plus that workspace's own — so nothing is held to the firm-wide half
 * alone, and the per-workspace loop holds no database handle.
 */
const anonymizeTextFieldsByWorkspace = async ({
  anonymizer: { anonymize, loadAllowlist, loadGazetteer },
  context,
  fields,
}: {
  anonymizer: EgressAnonymizer;
  context: McpRequestContext;
  fields: readonly McpStructuredTextField[];
}): Promise<void> => {
  if (fields.length === 0) {
    return;
  }

  const byWorkspace = new Map<string, McpStructuredTextField[]>();
  for (const field of fields) {
    const group = byWorkspace.get(field.workspaceId);
    if (group) {
      group.push(field);
      continue;
    }
    byWorkspace.set(field.workspaceId, [field]);
  }

  // Exactly the workspaces the loop would have queried one by one: the
  // handlers established access to each of them when they attributed a field
  // to it, and nothing here widens that set.
  const workspaceIds = [...byWorkspace.keys()];
  const [gazetteerByWorkspace, excludedCanonicalsByWorkspace] =
    await Promise.all([
      loadGazetteer({
        organizationId: context.organizationId,
        scopedDb: context.scopedDb,
        workspaceIds,
      }),
      loadAllowlist({
        organizationId: context.organizationId,
        scopedDb: context.scopedDb,
        workspaceIds,
      }),
    ]);

  for (const [workspaceId, group] of byWorkspace) {
    const anonymized = await anonymize({
      catalogs: {
        type: "preloaded",
        excludedCanonicals: catalogFor(
          excludedCanonicalsByWorkspace,
          workspaceId,
        ),
        gazetteerEntries: catalogFor(gazetteerByWorkspace, workspaceId),
      },
      fields: group.map((field) => field.value),
      organizationId: context.organizationId,
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
  anonymizer,
  context,
  mode,
  plan,
}: {
  anonymizer: EgressAnonymizer;
  context: McpRequestContext;
  mode: McpMode;
  plan: Extract<McpEgressPlan, { egress: "structured" }>;
}): Promise<InternalToolResult> => {
  // Anonymize the declared text fields on the whole payload first (anonymized
  // mode only), THEN window, so an entity name can never straddle a window edge
  // and placeholders stay stable across windows of one field.
  if (mode === "anonymized") {
    await anonymizeTextFieldsByWorkspace({
      anonymizer,
      context,
      fields: plan.textFields,
    });
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

  return toolDataResult(plan.payload);
};

const finalizeCompatSearch = async ({
  anonymizer,
  context,
  mode,
  plan,
}: {
  anonymizer: EgressAnonymizer;
  context: McpRequestContext;
  mode: McpMode;
  plan: Extract<McpEgressPlan, { egress: "compatSearch" }>;
}): Promise<InternalToolResult> => {
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
      anonymizer,
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

  return toolDataResult({ nextCursor: plan.nextCursor, results });
};

const finalizeCompatFetch = async ({
  anonymizer,
  context,
  mode,
  plan,
}: {
  anonymizer: EgressAnonymizer;
  context: McpRequestContext;
  mode: McpMode;
  plan: Extract<McpEgressPlan, { egress: "compatFetch" }>;
}): Promise<InternalToolResult> => {
  if (mode === "anonymized") {
    // Same boundary as anonymized search: the user may fetch a raw document
    // internally, but the AI client receives only the anonymized title/body.
    // Anonymize the whole document first, then window the redacted text so no
    // entity name is split across a window edge.
    const anonymized = await anonymizeCompatFetchPayload({
      anonymize: anonymizer.anonymize,
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

    return toolDataResult({
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

  return toolDataResult({
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
  anonymize,
  context,
  text,
  title,
  workspaceId,
}: {
  anonymize: typeof anonymizeTextFields;
  context: McpRequestContext;
  text: string;
  title: string;
  workspaceId: string;
}) => {
  const anonymized = await anonymize({
    catalogs: { type: "database", scopedDb: context.scopedDb },
    fields: [title, text],
    organizationId: context.organizationId,
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
