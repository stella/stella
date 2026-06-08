import { valibotSchema } from "@ai-sdk/valibot";
import { tool } from "ai";
import * as v from "valibot";

import type { ScopedDb } from "@/api/db";
import {
  describeStoredTemplate,
  fillStoredTemplate,
} from "@/api/handlers/templates/template-fill-service";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedTemplateId } from "@/api/lib/safe-id-boundaries";

const LIST_TEMPLATES_TOOL_NAME = "list_templates" as const;
const DESCRIBE_TEMPLATE_TOOL_NAME = "describe_template" as const;
const FILL_TEMPLATE_TOOL_NAME = "fill_template" as const;

type CreateTemplateToolsArgs = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
};

/**
 * Chat (MCP) tools for the document-template library, letting the assistant
 * drive templating end to end: discover templates (`list_templates`), learn a
 * template's fields (`describe_template`), and fill one (`fill_template`).
 * All org-scoped via RLS on `scopedDb`.
 */
export const createTemplateTools = ({
  scopedDb,
  organizationId,
}: CreateTemplateToolsArgs) => ({
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
      describeStoredTemplate({
        templateId: brandPersistedTemplateId(templateId),
        scopedDb,
      }),
  }),

  [FILL_TEMPLATE_TOOL_NAME]: tool({
    description:
      "Fill a template with values and return the assembled document text. " +
      "Call describe_template first to learn the field paths. 'values' maps " +
      'each field path to its value, e.g. {"tenant.name": "ACME Sp. z o.o.", ' +
      '"signing_date": "2026-06-08"}. Returns the rendered text plus any ' +
      "placeholders left unfilled.",
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
      fillStoredTemplate({
        templateId: brandPersistedTemplateId(templateId),
        values,
        scopedDb,
        organizationId,
      }),
  }),
});

export {
  DESCRIBE_TEMPLATE_TOOL_NAME,
  FILL_TEMPLATE_TOOL_NAME,
  LIST_TEMPLATES_TOOL_NAME,
};
