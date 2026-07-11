import { toolDefinition } from "@tanstack/ai";
import * as v from "valibot";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/handlers/docx/ai-field-generator";
import { recordTemplateFill } from "@/api/handlers/templates/record-use";
import { suggestTemplateFields } from "@/api/handlers/templates/suggest-template-fields";
import {
  describeStoredTemplate,
  fillStoredTemplate,
} from "@/api/handlers/templates/template-fill-service";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedTemplateId } from "@/api/lib/safe-id-boundaries";

const LIST_TEMPLATES_TOOL_NAME = "list_templates" as const;
const DESCRIBE_TEMPLATE_TOOL_NAME = "describe_template" as const;
const FILL_TEMPLATE_TOOL_NAME = "fill_template" as const;
export const SUGGEST_TEMPLATE_FIELDS_TOOL_NAME =
  "suggest_template_fields" as const;

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
  const aiAnalytics = buildTemplateAiAnalytics({
    safeDb,
    organizationId,
    userId,
    orgAIConfig,
    feature: "templates.fill",
  });
  // Model-backed generator for AI-fillable fields (FieldMeta.aiPrompt); shared
  // with the web fill routes so AI placeholders behave identically. A failed or
  // unavailable model just leaves the field unfilled rather than erroring.
  const generateAiValue = buildAiFieldGenerator({
    orgAIConfig: orgAIConfig ?? null,
    organizationId,
    aiAnalytics,
  });
  // Decider for AI-decided boolean conditions (a boolean field with an
  // aiPrompt); same fallback semantics as generateAiValue.
  const decideAiCondition = buildAiConditionDecider({
    orgAIConfig: orgAIConfig ?? null,
    organizationId,
    aiAnalytics,
  });
  // Per-occurrence adapter for aiAdapt fields (stub rewritten to fit each
  // marker's surrounding text); same fallback semantics as generateAiValue.
  const adaptAiValue = buildAiOccurrenceAdapter({
    orgAIConfig: orgAIConfig ?? null,
    organizationId,
    aiAnalytics,
  });

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
      description:
        "Describe a template's fillable fields (with any named conditions and " +
        "computed fields) so you know what values to provide before filling " +
        "it. Pass the template id from list_templates.",
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
          scopedDb,
        }),
    ),

    [FILL_TEMPLATE_TOOL_NAME]: toolDefinition({
      name: FILL_TEMPLATE_TOOL_NAME,
      description:
        "Fill a template with values and return the assembled document text. " +
        "Call describe_template first to learn the field paths. 'values' maps " +
        'each field path to its value, e.g. {"tenant.name": "ACME Sp. z o.o.", ' +
        '"signing_date": "2026-06-08"}. Fields configured as AI-fillable are ' +
        "drafted automatically when you omit them. Returns the rendered text " +
        "plus any placeholders left unfilled.",
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
        generateAiValue,
        decideAiCondition,
        adaptAiValue,
      });
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
};

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
        "the ones that make sense with apply-active-docx-edits, replacing " +
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
      const suggestions = await suggestTemplateFields({
        documentText: text,
        instructions: instructions ?? undefined,
        orgAIConfig: orgAIConfig ?? null,
        organizationId,
        aiAnalytics,
      });
      return { suggestions };
    }),
  };
};

export {
  DESCRIBE_TEMPLATE_TOOL_NAME,
  FILL_TEMPLATE_TOOL_NAME,
  LIST_TEMPLATES_TOOL_NAME,
};
