import { valibotSchema } from "@ai-sdk/valibot";
import { tool } from "ai";
import * as v from "valibot";

import type { ScopedDb } from "@/api/db";
import { buildAiFieldGenerator } from "@/api/handlers/docx/ai-field-generator";
import { suggestTemplateFields } from "@/api/handlers/templates/suggest-template-fields";
import {
  describeStoredTemplate,
  fillStoredTemplate,
} from "@/api/handlers/templates/template-fill-service";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedTemplateId } from "@/api/lib/safe-id-boundaries";

const LIST_TEMPLATES_TOOL_NAME = "list_templates" as const;
const DESCRIBE_TEMPLATE_TOOL_NAME = "describe_template" as const;
const FILL_TEMPLATE_TOOL_NAME = "fill_template" as const;
const SUGGEST_TEMPLATE_FIELDS_TOOL_NAME = "suggest_template_fields" as const;

type CreateTemplateToolsArgs = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  /** Org AI config from the chat turn; enables AI-fillable fields when set. */
  orgAIConfig?: OrgAIConfig | null | undefined;
};

/**
 * Chat (MCP) tools for the document-template library, letting the assistant
 * drive templating end to end: discover templates (`list_templates`), learn a
 * template's fields (`describe_template`), and fill one (`fill_template`),
 * including AI-fillable fields drafted from the org's model. Org-scoped via
 * RLS on `scopedDb`.
 */
export const createTemplateTools = ({
  scopedDb,
  organizationId,
  orgAIConfig,
}: CreateTemplateToolsArgs) => {
  // Model-backed generator for AI-fillable fields (FieldMeta.aiPrompt); shared
  // with the web fill routes so AI placeholders behave identically. A failed or
  // unavailable model just leaves the field unfilled rather than erroring.
  // TODO(metering): wire createAIAnalyticsCallbacks so this nested generation
  // is metered alongside other model calls.
  const generateAiValue = buildAiFieldGenerator({
    orgAIConfig: orgAIConfig ?? null,
    organizationId,
  });

  return {
    [LIST_TEMPLATES_TOOL_NAME]: tool({
      description:
        "List the document templates in this workspace (NDAs, powers of " +
        "attorney, leases, and so on). Returns each template's id, name and " +
        "number of fillable fields. Call this first so you know which " +
        "templates exist and their ids before describing or filling one.",
      inputSchema: valibotSchema(v.strictObject({})),
      execute: async () => {
        const rows = await scopedDb((tx) =>
          tx.query.templates.findMany({
            columns: { id: true, name: true, fieldCount: true },
            orderBy: { createdAt: "desc" },
            limit: LIMITS.templatesCount,
          }),
        );
        return { templates: rows };
      },
    }),

    [DESCRIBE_TEMPLATE_TOOL_NAME]: tool({
      description:
        "Describe a template's fillable fields (with any named conditions and " +
        "computed fields) so you know what values to provide before filling " +
        "it. Pass the template id from list_templates.",
      inputSchema: valibotSchema(
        v.strictObject({
          templateId: v.pipe(
            v.string(),
            v.description("Template id, as returned by list_templates."),
          ),
        }),
      ),
      execute: async ({ templateId }) =>
        await describeStoredTemplate({
          templateId: brandPersistedTemplateId(templateId),
          scopedDb,
        }),
    }),

    [FILL_TEMPLATE_TOOL_NAME]: tool({
      description:
        "Fill a template with values and return the assembled document text. " +
        "Call describe_template first to learn the field paths. 'values' maps " +
        'each field path to its value, e.g. {"tenant.name": "ACME Sp. z o.o.", ' +
        '"signing_date": "2026-06-08"}. Fields configured as AI-fillable are ' +
        "drafted automatically when you omit them. Returns the rendered text " +
        "plus any placeholders left unfilled.",
      inputSchema: valibotSchema(
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
      execute: async ({ templateId, values }) =>
        await fillStoredTemplate({
          templateId: brandPersistedTemplateId(templateId),
          values,
          scopedDb,
          organizationId,
          generateAiValue,
        }),
    }),

    [SUGGEST_TEMPLATE_FIELDS_TOOL_NAME]: tool({
      description:
        "Suggest which literal values in a template document being authored " +
        "should become {{field}} placeholders (party names, addresses, " +
        "registration numbers, amounts, dates, signatories). Pass the " +
        "document text (or the part the user asked about). Returns suggested " +
        "fields: the exact literalText, a dotted fieldPath, an inputType and " +
        "an optional AI-draft prompt. After reviewing the suggestions, apply " +
        "the ones that make sense with apply-active-docx-edits, replacing " +
        "each literalText occurrence with its {{fieldPath}} marker verbatim.",
      inputSchema: valibotSchema(
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
      execute: async ({ text, instructions }) => {
        const suggestions = await suggestTemplateFields({
          documentText: text,
          instructions: instructions ?? undefined,
          orgAIConfig: orgAIConfig ?? null,
          organizationId,
        });
        return { suggestions };
      },
    }),
  };
};

export {
  DESCRIBE_TEMPLATE_TOOL_NAME,
  FILL_TEMPLATE_TOOL_NAME,
  LIST_TEMPLATES_TOOL_NAME,
};
