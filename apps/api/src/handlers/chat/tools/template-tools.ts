import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";
import * as v from "valibot";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  holdsUnrestoredPlaceholder,
  prepareTextForThirdParty,
  restoreTextFromBoundary,
} from "@/api/handlers/chat/third-party-boundary";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { templateAiCollaboratorsForBoundary } from "@/api/handlers/chat/tools/template-ai-boundary";
import { raiseChatToolError } from "@/api/handlers/chat/tools/tool-failure";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/lib/docx/ai-field-generator";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  requireChatToolModelAdmission,
  type ModelDispatchAdmission,
} from "@/api/lib/rate-limit/model-dispatch-admission";
import { brandPersistedTemplateId } from "@/api/lib/safe-id-boundaries";
import { recordTemplateExecution } from "@/api/lib/templates/record-use";
import { suggestTemplateFields } from "@/api/lib/templates/suggest-template-fields";
import type { SuggestedTemplateField } from "@/api/lib/templates/suggest-template-fields";
import {
  decideTemplateFillCompletion,
  fillDiagnosticsOf,
  fillShortfallIssues,
} from "@/api/lib/templates/template-fill-completion";
import {
  describeStoredTemplate,
  fillStoredTemplate,
} from "@/api/lib/templates/template-fill-service";

const LIST_TEMPLATES_TOOL_NAME = "list_templates" as const;
const DESCRIBE_TEMPLATE_TOOL_NAME = "describe_template" as const;
const FILL_TEMPLATE_TOOL_NAME = "fill_template" as const;
export const SUGGEST_TEMPLATE_FIELDS_TOOL_NAME =
  "suggest_template_fields" as const;

const RECORD_FILL_FAILED_SINK = failureSink({
  event: "templates.fill.record_failed",
  expected: [],
});

// Exported so the playbook eval offers the tool as chat does, answered by a
// stub, instead of a copy that can drift from it.
export const LIST_TEMPLATES_TOOL_DEFINITION = toolDefinition({
  name: LIST_TEMPLATES_TOOL_NAME,
  description:
    "List the document templates in this organization (NDAs, powers of " +
    "attorney, leases, and so on). Returns each template's id, name, " +
    "number of fillable fields, tags, and usage guidance (whenToUse / " +
    "whenNotToUse). Call this first so you know which templates exist " +
    "and their ids before describing or filling one. When picking a " +
    "template, prefer one whose whenToUse matches the request and skip " +
    "any whose whenNotToUse applies.",
  inputSchema: toTanStackToolSchema(v.strictObject({})),
});

// Exported so the fill_template eval can register the exact wording
// production sends, instead of a copy that can drift from it.
export const DESCRIBE_TEMPLATE_DESCRIPTION =
  "Describe a template's fillable fields (with any named conditions and " +
  "computed fields) so you know what values to provide before filling " +
  "it. Each field's 'required' flag marks values fill_template rejects " +
  "when omitted (unless the field is AI-fillable); 'arrays' lists any " +
  "{% for %} loops, so a path grouped there is an array of objects in " +
  "'values', not a dotted key. Pass the template id from list_templates.";
export const FILL_TEMPLATE_DESCRIPTION =
  "Fill a template with values and return the assembled document text. " +
  "Call describe_template first to learn the field paths and which are " +
  "required; when a manifest field is grouped under 'arrays' there, " +
  "submit its array root as a list of objects (one per item), not " +
  "dotted keys. 'values' maps each field path to its value, e.g. " +
  '{"tenant.name": "ACME Sp. z o.o.", "signing_date": "2026-06-08"}. ' +
  "Fields configured as AI-fillable are drafted automatically when you " +
  "omit them. A required field that is not AI-fillable must be provided: " +
  "omitting or emptying it rejects the fill with the exact missing " +
  "fields instead of guessing a value or leaving a placeholder unfilled " +
  "— ask the user for those values and retry. Returns the rendered text " +
  "plus any placeholders left unfilled, `completionStatus` (`partial` " +
  "with a `shortfall` list when a placeholder, an AI draft or an " +
  "AI-decided condition was left open; supply those and retry), and " +
  "`unrestoredFields` naming any field whose value could not be filled " +
  "with real values; ask the user to review those.";

type CreateTemplateToolsArgs = {
  /** The turn's admission; the nested AI-field steps are steps of the turn. */
  modelAdmission: ModelDispatchAdmission | undefined;
  scopedDb: ScopedDb;
  /** Org-scoped DB used to meter the nested AI-field generation steps. */
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  /** Acting user for the consumption ledger row. */
  userId: SafeId<"user">;
  /**
   * Org AI config from the chat turn. Required (not optional): the fill tools
   * eagerly resolve an AI model for metering, which needs this on BYOK-only
   * deployments. Callers must pass it (use `null` when there is genuinely none).
   */
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  /** Records the EXECUTE audit event for a fill when present. */
  recordAuditEvent?: AuditRecorder | undefined;
  /** The chat turn's boundary, which prepares the nested AI-field requests. */
  thirdPartyBoundary: ChatThirdPartyBoundary;
  dependencies?: TemplateToolDependencies | undefined;
};

type TemplateToolDependencies = {
  fillStoredTemplate: typeof fillStoredTemplate;
};

const defaultTemplateToolDependencies = {
  fillStoredTemplate,
} satisfies TemplateToolDependencies;

type TemplateAiAnalyticsArgs = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  orgAIConfig: OrgAIConfig | null;
  feature: string;
};

// Meter a template tool's nested AI steps alongside the rest of the chat turn.
// workspaceId is null: a chat-driven template action is org-scoped, not bound to
// a matter.
const buildTemplateAiAnalytics = ({
  safeDb,
  organizationId,
  userId,
  orgAIConfig,
  feature,
}: TemplateAiAnalyticsArgs) =>
  createTanStackAIAnalyticsCallbacks({
    dataClass: "customer",
    usageMetering: {
      actionType: "chat",
      organizationId,
      safeDb,
      serviceTier: "standard",
      userId,
      workspaceId: null,
    },
    feature,
    modelRole: "fast",
    orgAIConfig: orgAIConfig ?? null,
    properties: { organization_id: organizationId },
    traceId: Bun.randomUUIDv7(),
  });

/**
 * Chat (MCP) tools for using the document-template library: discover templates
 * (`list_templates`), learn a template's fields (`describe_template`), and fill
 * one (`fill_template`), including AI-fillable fields drafted from the org's
 * model. Org-scoped via RLS on `scopedDb`. These map to the `template: ["use"]`
 * grant; the authoring-only `suggest_template_fields` tool lives in
 * `createTemplateAuthoringTools`.
 */
export const createTemplateTools = ({
  modelAdmission,
  scopedDb,
  safeDb,
  organizationId,
  userId,
  orgAIConfig,
  managedAIResidency,
  recordAuditEvent,
  thirdPartyBoundary,
  dependencies = defaultTemplateToolDependencies,
}: CreateTemplateToolsArgs) => {
  // Model-backed collaborators for the manifest's AI fields, shared with the
  // web fill routes so AI placeholders behave identically: a generator for
  // AI-fillable fields (FieldMeta.aiPrompt), a decider for AI-decided boolean
  // conditions, and a per-occurrence adapter for aiAdapt stubs. A failed or
  // unavailable model just leaves the field unfilled rather than erroring.
  // The fill service builds these only when the manifest declares an AI field.
  // tenantWorkspaceIds is empty: a chat-driven template action is org-scoped,
  // not bound to a matter (see buildTemplateAiAnalytics below).
  const aiCollaborators = (unrestoredFields: Set<string>) => {
    const shared = {
      admission: requireChatToolModelAdmission(modelAdmission),
      orgAIConfig: orgAIConfig ?? null,
      managedAIResidency,
      organizationId,
      aiAnalytics: buildTemplateAiAnalytics({
        safeDb,
        organizationId,
        userId,
        orgAIConfig,
        feature: "templates.fill",
      }),
      tenantWorkspaceIds: [],
    };
    return templateAiCollaboratorsForBoundary({
      boundary: thirdPartyBoundary,
      collaborators: {
        generateAiValue: buildAiFieldGenerator(shared),
        decideAiCondition: buildAiConditionDecider(shared),
        adaptAiValue: buildAiOccurrenceAdapter(shared),
      },
      unrestoredFields,
    });
  };

  return {
    [LIST_TEMPLATES_TOOL_NAME]: LIST_TEMPLATES_TOOL_DEFINITION.server(
      async () => {
        const rows = await scopedDb((tx) =>
          tx.query.templates.findMany({
            columns: {
              id: true,
              name: true,
              fieldCount: true,
              tags: true,
              whenToUse: true,
              whenNotToUse: true,
            },
            where: { organizationId: { eq: organizationId } },
            orderBy: { createdAt: "desc" },
            limit: LIMITS.templatesCount,
          }),
        );
        return { templates: rows };
      },
    ),

    [DESCRIBE_TEMPLATE_TOOL_NAME]: toolDefinition({
      name: DESCRIBE_TEMPLATE_TOOL_NAME,
      description: DESCRIBE_TEMPLATE_DESCRIPTION,
      inputSchema: toTanStackToolSchema(
        v.strictObject({
          templateId: v.pipe(
            v.string(),
            v.description("Template id, as returned by list_templates."),
          ),
        }),
      ),
    }).server(
      async ({ templateId }) =>
        await describeStoredTemplate({
          templateId: brandPersistedTemplateId(templateId),
          organizationId,
          scopedDb,
        }),
    ),

    [FILL_TEMPLATE_TOOL_NAME]: toolDefinition({
      name: FILL_TEMPLATE_TOOL_NAME,
      description: FILL_TEMPLATE_DESCRIPTION,
      inputSchema: toTanStackToolSchema(
        v.strictObject({
          templateId: v.pipe(
            v.string(),
            v.description("Template id, as returned by list_templates."),
          ),
          values: v.pipe(
            v.record(v.string(), v.unknown()),
            v.description("Map of field path to value."),
          ),
        }),
      ),
    }).server(async ({ templateId, values }) => {
      const branded = brandPersistedTemplateId(templateId);
      // In anonymized mode the values arrive restored from the model's
      // placeholders; one it made up stays a placeholder, and so does one in
      // an AI draft. Both are reported instead of passing as filled.
      const unrestoredFields = new Set(
        Object.entries(values)
          .filter(([, value]) =>
            holdsUnrestoredPlaceholder(thirdPartyBoundary, value),
          )
          .map(([fieldPath]) => fieldPath),
      );
      const result = await dependencies.fillStoredTemplate({
        templateId: branded,
        values,
        scopedDb,
        organizationId,
        thirdPartyOutboundPermit: grantThirdPartyOutboundPermit(),
        requiredFields: "enforce",
        useRecording: "caller",
        aiCollaborators: () => aiCollaborators(unrestoredFields),
      });
      if ("requiredFieldsRejection" in result) {
        // A required, non-AI-fillable field was omitted or empty: reject
        // instead of inventing a value or leaving a raw {{marker}} in the
        // document, and name exactly which fields are still needed.
        return {
          error: "missing_required_fields",
          missingFields: result.requiredFieldsRejection,
        };
      }
      if ("error" in result) {
        return result;
      }
      // A value or AI draft that kept a placeholder put the placeholder into
      // the document: a blocking diagnostic, so the fill is partial.
      const diagnostics = fillDiagnosticsOf(result, {
        unrestoredFields: [...unrestoredFields].toSorted(),
      });
      const recorded = await recordTemplateExecution({
        scopedDb,
        templateId: branded,
        organizationId,
        userId,
        format: "text",
        diagnostics,
        recordAuditEvent,
      });
      if (Result.isError(recorded)) {
        observeFailure(recorded.error, { sink: RECORD_FILL_FAILED_SINK });
        return raiseChatToolError(
          new ChatToolError({
            kind: "server-defect",
            message: "The template fill could not be recorded.",
            cause: recorded.error,
          }),
        );
      }
      // The completion decision over the whole diagnostics record: a fill
      // with an unfilled placeholder, a failed AI draft, an undecided AI
      // condition or an unrestored placeholder is partial, and each
      // shortfall names what to supply.
      const completion = decideTemplateFillCompletion({
        mode: "allow_partial",
        diagnostics,
      });
      const graded = {
        ...result,
        ...(completion.type === "complete"
          ? { completionStatus: "complete" as const }
          : {
              completionStatus: "partial" as const,
              shortfall: fillShortfallIssues(completion.blocking),
            }),
      };
      return diagnostics.unrestoredFields.length === 0
        ? graded
        : { ...graded, unrestoredFields: diagnostics.unrestoredFields };
    }),
  };
};

type CreateTemplateAuthoringToolsArgs = {
  /** The turn's admission; the suggestion request is a step of the turn. */
  modelAdmission: ModelDispatchAdmission | undefined;
  /** Org-scoped DB used to meter the AI suggestion step. */
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  /** Acting user for the metering ledger. */
  userId: SafeId<"user">;
  /** Org AI config from the chat turn; see `createTemplateTools`. */
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  /** The chat turn's boundary, which prepares the nested suggestion request. */
  thirdPartyBoundary: ChatThirdPartyBoundary;
  dependencies?: TemplateAuthoringToolDependencies | undefined;
};

type TemplateAuthoringToolDependencies = {
  suggestTemplateFields: typeof suggestTemplateFields;
};

const defaultTemplateAuthoringToolDependencies = {
  suggestTemplateFields,
} satisfies TemplateAuthoringToolDependencies;

/**
 * Chat (MCP) tool for *authoring* templates: `suggest_template_fields` proposes
 * which literal values in a document being authored should become `{{field}}`
 * placeholders. Split from `createTemplateTools` because this widens a fill-only
 * role into template authoring, so callers gate it behind a `template:
 * ["create"]` grant rather than the broader `["use"]`.
 */
const restoreSuggestion = (
  boundary: ChatThirdPartyBoundary,
  suggestion: SuggestedTemplateField,
): { complete: boolean; suggestion: SuggestedTemplateField } => {
  const literal = restoreTextFromBoundary(boundary, suggestion.literalText);
  const restore = (text: string) =>
    restoreTextFromBoundary(boundary, text).text;
  return {
    complete: literal.complete,
    suggestion: {
      ...suggestion,
      literalText: literal.text,
      ...(suggestion.label === undefined
        ? {}
        : { label: restore(suggestion.label) }),
      ...(suggestion.exampleValue === undefined
        ? {}
        : { exampleValue: restore(suggestion.exampleValue) }),
      ...(suggestion.aiPrompt === undefined
        ? {}
        : { aiPrompt: restore(suggestion.aiPrompt) }),
      ...(suggestion.hint === undefined
        ? {}
        : { hint: restore(suggestion.hint) }),
    },
  };
};

export const createTemplateAuthoringTools = ({
  modelAdmission,
  safeDb,
  organizationId,
  userId,
  orgAIConfig,
  managedAIResidency,
  thirdPartyBoundary,
  dependencies = defaultTemplateAuthoringToolDependencies,
}: CreateTemplateAuthoringToolsArgs) => {
  const aiAnalytics = buildTemplateAiAnalytics({
    safeDb,
    organizationId,
    userId,
    orgAIConfig,
    feature: "templates.suggest_fields",
  });

  return {
    [SUGGEST_TEMPLATE_FIELDS_TOOL_NAME]: toolDefinition({
      name: SUGGEST_TEMPLATE_FIELDS_TOOL_NAME,
      description:
        "Suggest which literal values in a template document being authored " +
        "should become {{field}} placeholders (party names, addresses, " +
        "registration numbers, amounts, dates, signatories). Pass the " +
        "document text (or the part the user asked about). Returns suggested " +
        "fields: the exact literalText, a dotted fieldPath, an inputType and " +
        "an optional AI-draft prompt. After reviewing the suggestions, apply " +
        "the ones that make sense with suggest_changes, replacing " +
        "each literalText occurrence with its {{fieldPath}} marker verbatim. " +
        "In bilingual or multi-column documents apply the marker in EVERY " +
        "language column (one edit per parallel occurrence), so the same " +
        "value is never a field in one language and hardcoded in the other.",
      inputSchema: toTanStackToolSchema(
        v.strictObject({
          text: v.pipe(
            v.string(),
            v.maxLength(200_000),
            v.description("The document text to analyze, copied verbatim."),
          ),
          instructions: v.nullable(
            v.pipe(
              v.string(),
              v.description(
                "Extra user guidance, e.g. which kinds of values to focus on.",
              ),
            ),
          ),
        }),
      ),
    }).server(async ({ text, instructions }) => {
      // The tool receives the turn's real values. Its nested request is
      // prepared by the turn's boundary like the turn itself, and the
      // suggestions come back with those values restored, so the boundary
      // prepares them once more on their way back to the model.
      const documentText = await prepareTextForThirdParty({
        boundary: thirdPartyBoundary,
        text,
      });
      const preparedInstructions = await prepareTextForThirdParty({
        boundary: thirdPartyBoundary,
        text: instructions ?? "",
      });
      // The tool runtime reports a failed call by the error its execute
      // function throws.
      if (Result.isError(documentText)) {
        throw documentText.error;
      }
      if (Result.isError(preparedInstructions)) {
        throw preparedInstructions.error;
      }

      // suggestTemplateFields rejects on a call failure (BYOK
      // misconfiguration, provider outage, timeout); capture the original
      // for telemetry, then throw a sanitized, stable message instead of
      // rethrowing it — the raw provider error can carry internals (key
      // names, quota details) that must not reach the model verbatim.
      try {
        const suggestions = await dependencies.suggestTemplateFields({
          admission: requireChatToolModelAdmission(modelAdmission),
          documentText: documentText.value,
          instructions:
            instructions === null ? undefined : preparedInstructions.value,
          orgAIConfig: orgAIConfig ?? null,
          managedAIResidency,
          organizationId,
          aiAnalytics,
        });
        const restored = suggestions.map((suggestion) =>
          restoreSuggestion(thirdPartyBoundary, suggestion),
        );
        // A suggestion whose literal text keeps a placeholder the boundary
        // cannot restore matches nothing in the document: it is withheld and
        // named instead.
        const unrestoredFields = restored
          .filter(({ complete }) => !complete)
          .map(({ suggestion }) => suggestion.fieldPath);
        return {
          suggestions: restored
            .filter(({ complete }) => complete)
            .map(({ suggestion }) => suggestion),
          ...(unrestoredFields.length === 0 ? {} : { unrestoredFields }),
        };
      } catch (error) {
        aiAnalytics.captureError(error);
        throw new ChatToolError({
          kind: "transient",
          message:
            "Template field suggestion failed; the workspace's AI provider returned an error.",
          cause: error,
        });
      }
    }),
  };
};

export {
  DESCRIBE_TEMPLATE_TOOL_NAME,
  FILL_TEMPLATE_TOOL_NAME,
  LIST_TEMPLATES_TOOL_NAME,
};
