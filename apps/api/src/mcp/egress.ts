import { panic, Result, TaggedError } from "better-result";

import { loadAnonymizationAllowlistCanonicalsByWorkspace } from "@/api/lib/anonymization-allowlist";
import { loadAnonymizationGazetteerEntriesByWorkspace } from "@/api/lib/anonymization-blacklist";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { emitAnonymizationRefusalMetric } from "@/api/lib/observability/request-metrics";
import { projectionPayload } from "@/api/lib/projection-totality";
import { anonymizeTextFields } from "@/api/mcp/anonymization";
import type { AnonymizedTextFields } from "@/api/mcp/anonymization-core";
import {
  COMPAT_SEARCH_OUTPUT_SCHEMA,
  COMPAT_FETCH_OUTPUT_SCHEMA,
} from "@/api/mcp/compat-contract";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import type { AnonymizedFieldBoundaryError } from "@/api/mcp/field-markers";
import type {
  InternalToolResult,
  McpCompatFetchSubject,
  McpEgressPlan,
  McpStructuredTextField,
  McpToolResponse,
  TypedMcpToolResponse,
} from "@/api/mcp/tool-types";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import {
  isToolErrorResult,
  MCP_INTERNAL_ERROR_HINT,
  normalizeTextField,
  structuredErrorResult,
  untypedToolDataResult,
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

  const anonymizer = {
    anonymize: countingRefusals(anonymize),
    loadAllowlist,
    loadGazetteer,
  };

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

const EGRESS_ANONYMIZER_FAILED_SINK = failureSink({
  event: "mcp.egress.anonymizer_failed",
  expected: [],
});

/** The anonymizer itself failed: nothing of the payload was anonymized. */
class EgressAnonymizerFailedError extends TaggedError(
  "EgressAnonymizerFailedError",
)<{ cause: unknown; message: string }> {}

/** Why a payload's anonymization did not complete. */
type EgressAnonymizationError =
  | AnonymizedFieldBoundaryError
  | EgressAnonymizerFailedError;

type EgressAnonymize = (
  input: Parameters<typeof anonymizeTextFields>[0],
) => Promise<Result<AnonymizedTextFields, EgressAnonymizationError>>;

/**
 * The anonymizer every egress variant calls, failing closed and counting each
 * call that fails: one that throws (`pipeline_error`) and one whose field
 * structure did not survive (`field_boundary`). Either way the caller returns
 * the anonymization-failed envelope, so without this an anonymized tool that
 * can no longer anonymize is indistinguishable from any other failing tool.
 * Wrapped once at the entry, so no variant reaches the anonymizer uncounted.
 */
const countingRefusals =
  (anonymize: typeof anonymizeTextFields): EgressAnonymize =>
  async (input) => {
    const called = await Result.tryPromise({
      try: async () => await anonymize(input),
      catch: (cause) =>
        new EgressAnonymizerFailedError({
          cause,
          message: "The anonymizer failed",
        }),
    });
    if (Result.isError(called)) {
      // The real failure stays observable; the caller only sees the envelope.
      observeFailure(called.error, { sink: EGRESS_ANONYMIZER_FAILED_SINK });
      emitAnonymizationRefusalMetric({
        reason: "pipeline_error",
        site: "mcp_egress",
      });
      return Result.err(called.error);
    }
    if (Result.isError(called.value)) {
      emitAnonymizationRefusalMetric({
        reason: "field_boundary",
        site: "mcp_egress",
      });
    }
    return called.value;
  };

type EgressAnonymizer = {
  anonymize: EgressAnonymize;
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
}): Promise<Result<void, EgressAnonymizationError>> => {
  if (fields.length === 0) {
    return Result.ok(undefined);
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
    // Fail closed: the caller discards the whole payload, so no field of this
    // or any other group leaves unanonymized.
    if (Result.isError(anonymized)) {
      return Result.err(anonymized.error);
    }

    for (const [index, field] of group.entries()) {
      field.apply(
        normalizeTextField({
          allowEmptyFallback: false,
          fallback: field.value,
          missingFallback: ANONYMIZED_FIELD_MISSING_FALLBACK,
          value: anonymized.value.fields[index],
        }),
      );
    }
  }
  return Result.ok(undefined);
};

/**
 * The refusal returned in place of a payload whose anonymization did not
 * complete. It carries no field text.
 */
const anonymizationFailedResult = (): InternalToolResult =>
  structuredErrorResult({
    code: "internal_error",
    message: "Tool output could not be anonymized",
    hint: MCP_INTERNAL_ERROR_HINT,
  });

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
    const anonymized = await anonymizeTextFieldsByWorkspace({
      anonymizer,
      context,
      fields: plan.textFields,
    });
    if (Result.isError(anonymized)) {
      return anonymizationFailedResult();
    }
    plan.redactInAnonymized?.();
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

  return untypedToolDataResult(plan.payload);
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
  // `kind` and `workspaceId` are per-hit egress attribution; both are stripped
  // before the result reaches the client.
  const results = plan.results.map((hit) => ({
    id: hit.id,
    title: hit.title,
    url: hit.url,
    ...(hit.kind === "corpus" && hit.source_url !== undefined
      ? { source_url: hit.source_url }
      : {}),
  }));

  // MCP access is for authorized Stella users only. In anonymized mode we still
  // search raw, non-anonymized indexed text so retrieval quality stays useful,
  // then anonymize the returned titles, grouped per workspace, before they
  // leave Stella for the AI client. A corpus hit is published law with no
  // tenant attribution to group by, so it leaves as written: the per-hit
  // `kind`, not the request mode alone, decides.
  if (mode === "anonymized") {
    const anonymized = await anonymizeTextFieldsByWorkspace({
      anonymizer,
      context,
      fields: plan.results.flatMap((hit, index) =>
        hit.kind === "corpus"
          ? []
          : [
              {
                apply: (value: string) => {
                  const target = results[index];
                  if (target) {
                    target.title = value;
                  }
                },
                value: hit.title,
                workspaceId: hit.workspaceId,
              },
            ],
      ),
    });
    if (Result.isError(anonymized)) {
      return anonymizationFailedResult();
    }
  }

  return untypedToolDataResult(
    projectionPayload(COMPAT_SEARCH_OUTPUT_SCHEMA, {
      nextCursor: plan.nextCursor,
      ...(plan.paginationOutcome === undefined
        ? {}
        : { paginationOutcome: plan.paginationOutcome }),
      results,
    }),
  );
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
  // The subject kind decides anonymization, not the request mode alone: a
  // matter document carries tenant-authored text, while a decision or a statute
  // is published law every reader may see as written.
  if (mode === "anonymized" && plan.subject.kind === "document") {
    const { workspaceId } = plan.subject;
    // Same boundary as anonymized search: the user may fetch a raw document
    // internally, but the AI client receives only the anonymized title/body.
    // Anonymize the whole document first, then window the redacted text so no
    // entity name is split across a window edge.
    const anonymizedPayload = await anonymizeCompatFetchPayload({
      anonymize: anonymizer.anonymize,
      context,
      text: plan.text,
      title: plan.title,
      workspaceId,
    });
    if (Result.isError(anonymizedPayload)) {
      return anonymizationFailedResult();
    }
    const anonymized = anonymizedPayload.value;

    const textWindow = windowTextByCursor({
      cursor: plan.cursor,
      maxChars: plan.maxChars,
      text: anonymized.text,
    });
    if (isToolErrorResult(textWindow)) {
      return textWindow;
    }

    return untypedToolDataResult(
      projectionPayload(COMPAT_FETCH_OUTPUT_SCHEMA, {
        id: plan.id,
        title: anonymized.title,
        text: textWindow.text,
        url: plan.url,
        ...(plan.source_url === undefined
          ? {}
          : { source_url: plan.source_url }),
        nextCursor: textWindow.nextCursor,
        metadata: {
          kind: "document",
          anonymized: true,
          anonymizedEntityCount: anonymized.anonymizedEntityCount,
          charCount: textWindow.charCount,
          source: "stella",
          truncated: textWindow.truncated,
          workspaceId,
        },
      }),
    );
  }

  const textWindow = windowTextByCursor({
    cursor: plan.cursor,
    maxChars: plan.maxChars,
    text: plan.text,
  });
  if (isToolErrorResult(textWindow)) {
    return textWindow;
  }

  return untypedToolDataResult(
    projectionPayload(COMPAT_FETCH_OUTPUT_SCHEMA, {
      id: plan.id,
      title: plan.title,
      text: textWindow.text,
      url: plan.url,
      ...(plan.source_url === undefined ? {} : { source_url: plan.source_url }),
      nextCursor: textWindow.nextCursor,
      metadata: {
        ...compatFetchSubjectMetadata(plan.subject),
        charCount: textWindow.charCount,
        source: "stella",
        truncated: textWindow.truncated,
      },
    }),
  );
};

/**
 * The subject's own half of `metadata`: its kind, plus the workspace a matter
 * document belongs to and the other kinds do not. A switch with an
 * exhaustiveness check, so a new compat subject cannot reach a client without
 * a decision here.
 */
const compatFetchSubjectMetadata = (subject: McpCompatFetchSubject) => {
  switch (subject.kind) {
    case "document":
      return { kind: subject.kind, workspaceId: subject.workspaceId };
    case "decision":
    case "statute":
      return { kind: subject.kind };
    default:
      subject satisfies never;
      return panic("Unhandled compat fetch subject");
  }
};

const anonymizeCompatFetchPayload = async ({
  anonymize,
  context,
  text,
  title,
  workspaceId,
}: {
  anonymize: EgressAnonymize;
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
  if (Result.isError(anonymized)) {
    return Result.err(anonymized.error);
  }

  return Result.ok({
    anonymizedEntityCount: anonymized.value.entityCount,
    text: normalizeTextField({
      allowEmptyFallback: false,
      fallback: text,
      missingFallback: ANONYMIZED_FIELD_MISSING_FALLBACK,
      value: anonymized.value.fields[1],
    }),
    title: normalizeTextField({
      allowEmptyFallback: false,
      fallback: title,
      missingFallback: ANONYMIZED_FIELD_MISSING_FALLBACK,
      value: anonymized.value.fields[0],
    }),
  });
};
