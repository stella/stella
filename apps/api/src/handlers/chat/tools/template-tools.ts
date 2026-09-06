import { toolDefinition } from "@tanstack/ai";
import * as v from "valibot";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/lib/docx/ai-field-generator";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedTemplateId } from "@/api/lib/safe-id-boundaries";
import { recordTemplateFill } from "@/api/lib/templates/record-use";
import { suggestTemplateFields } from "@/api/lib/templates/suggest-template-fields";
import {
  describeStoredTemplate,
  fillStoredTemplate,
} from "@/api/lib/templates/template-fill-service";

const LIST_TEMPLATES_TOOL_NAME = "list_templates" as const;
const DESCRIBE_TEMPLATE_TOOL_NAME = "describe_template" as const;
const FILL_TEMPLATE_TOOL_NAME = "fill_template" as const;
export const SUGGEST_TEMPLATE_FIELDS_TOOL_NAME =
  "suggest_template_fields" as const;

// Exported so the fill_template eval can register the exact wording
// production sends, instead of a copy that can drift from it.
export const DESCRIBE_TEMPLATE_DESCRIPTION =
  "Describe a template's fillable fields (with any named conditions and " +
  "computed fields) so you know what values to provide before filling " +
  "it. Each field's 'required' flag marks values fill_template rejects " +
  "when omitted (unless the field is AI-fillable); 'arrays' lists any " +
  "{{#each}} loops, so a path grouped there is an array of objects in " +
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
  "plus any placeholders left unfilled.";

type CreateTemplateToolsArgs = {
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
  /** Records the EXECUTE audit event for a fill when present. */
  recordAuditEvent?: AuditRecorder | undefined;
};

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
  scopedDb,
  safeDb,
  organizationId,
  userId,
  orgAIConfig,
  recordAuditEvent,
}: CreateTemplateToolsArgs) => {
  // Model-backed collaborators for the manifest's AI fields, shared with the
  // web fill routes so AI placeholders behave identically: a generator for
  // AI-fillable fields (FieldMeta.aiPrompt), a decider for AI-decided boolean
  // conditions, and a per-occurrence adapter for aiAdapt stubs. A failed or
  // unavailable model just leaves the field unfilled rather than erroring.
  // The fill service builds these only when the manifest declares an AI field.
  // tenantWorkspaceIds is empty: a chat-driven template action is org-scoped,
  // not bound to a matter (see buildTemplateAiAnalytics below).
  const aiCollaborators = () => {
    const shared = {
      orgAIConfig: orgAIConfig ?? null,
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
    return {
      generateAiValue: buildAiFieldGenerator(shared),
      decideAiCondition: buildAiConditionDecider(shared),
      adaptAiValue: buildAiOccurrenceAdapter(shared),
    };
  };

  return {
    [LIST_TEMPLATES_TOOL_NAME]: toolDefinition({
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
    }).server(async () => {
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
    }),

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
      const result = await fillStoredTemplate({
        templateId: branded,
        values,
        scopedDb,
        organizationId,
        requiredFields: "enforce",
        aiCollaborators,
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
      if (!("error" in result)) {
        // Record the execution (fill row + EXECUTE audit) like the REST fill
        // routes, so agent-driven fills appear in the audit trail.
        // Best-effort: a successful render is not discarded if the
        // bookkeeping write fails (it is captured).
        await scopedDb(
          async (tx) =>
            await recordTemplateFill({
              tx,
              templateId: branded,
              organizationId,
              userId,
              format: "text",
              unmatchedCount: result.unmatchedPlaceholders.length,
              aiFieldErrorCount: result.aiFieldErrors.length,
              unusedCount: result.unusedValues.length,
              recordAuditEvent,
            }),
        ).catch(captureError);
      }
      return result;
    }),
  };
};

type CreateTemplateAuthoringToolsArgs = {
  /** Org-scoped DB used to meter the AI suggestion step. */
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  /** Acting user for the metering ledger. */
  userId: SafeId<"user">;
  /** Org AI config from the chat turn; see `createTemplateTools`. */
  orgAIConfig: OrgAIConfig | null;
  dependencies?: TemplateAuthoringToolDependencies | undefined;
};

export type TemplateAuthoringToolDependencies = {
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
export const createTemplateAuthoringTools = ({
  safeDb,
  organizationId,
  userId,
  orgAIConfig,
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
      // suggestTemplateFields rejects on a call failure (BYOK
      // misconfiguration, provider outage, timeout); capture the original
      // for telemetry, then throw a sanitized, stable message instead of
      // rethrowing it — the raw provider error can carry internals (key
      // names, quota details) that must not reach the model verbatim.
      try {
        const suggestions = await dependencies.suggestTemplateFields({
          documentText: text,
          instructions: instructions ?? undefined,
          orgAIConfig: orgAIConfig ?? null,
          organizationId,
          aiAnalytics,
        });
        return { suggestions };
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
