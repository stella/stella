import { Result } from "better-result";
import * as v from "valibot";

import { roles } from "@stll/permissions";

import {
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/handlers/docx/ai-field-generator";
import { validateDocxBuffer } from "@/api/handlers/entities/validate-docx-buffer";
import { createStoredTemplate } from "@/api/handlers/templates/create-template-service";
import {
  describeStoredTemplate,
  fillStoredTemplateWithText,
} from "@/api/handlers/templates/template-fill-service";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import { brandPersistedTemplateId } from "@/api/lib/safe-id-boundaries";
import { buildMarkerReference } from "@/api/mcp/template-marker-reference";
import type { McpToolDefinition, McpToolHandler } from "@/api/mcp/tool-types";
import { errorResult, stringProp, textResult } from "@/api/mcp/tool-utils";

type TemplateToolName =
  | "list_templates"
  | "describe_template"
  | "fill_template"
  | "create_template"
  | "template_marker_reference";

/** Max assembled-text length returned inline; full bytes ride along as base64. */
const TEMPLATE_FILL_TEXT_MAX_CHARS = 16_000;

export const TEMPLATE_TOOL_DEFINITIONS = [
  {
    annotations: { readOnlyHint: true },
    description:
      "List the document templates in this organization (NDAs, powers of " +
      "attorney, leases, and so on). Returns each template's id, name, number " +
      "of fillable fields, tags, and usage guidance (whenToUse / whenNotToUse). " +
      "Call this first to learn which templates exist and their ids before " +
      "describing or filling one. Prefer a template whose whenToUse matches the " +
      "request and skip any whose whenNotToUse applies.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    name: "list_templates",
    scope: "stella:templates",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Describe a template's fillable fields so you know what to provide before " +
      "filling it. Returns each field's path, label, inputType, whether it is " +
      "required, a hint, and (for registry-lookup fields) the named output " +
      "formats. Also returns named conditions and computed (formula) fields. " +
      "Pass the template id from list_templates.",
    inputSchema: {
      type: "object",
      properties: {
        template_id: stringProp("Template id, as returned by list_templates"),
      },
      required: ["template_id"],
    },
    name: "describe_template",
    scope: "stella:templates",
  },
  {
    description:
      "Fill a template with values and return the assembled document text plus " +
      "the filled DOCX as base64. Call describe_template first to learn the " +
      "field paths. 'values' maps each field path to its value, e.g. " +
      '{"tenant.name": "ACME Sp. z o.o.", "signing_date": "2026-06-08"}. ' +
      "Registry lookups, composite fields, formula fields, and AI-fillable " +
      "fields are resolved automatically; AI-fillable fields are drafted when " +
      "you omit them. Returns the rendered text and any placeholders left " +
      "unfilled.",
    inputSchema: {
      type: "object",
      properties: {
        template_id: stringProp("Template id, as returned by list_templates"),
        values: {
          type: "object",
          description: "Map of field path to value.",
          additionalProperties: true,
        },
      },
      required: ["template_id", "values"],
    },
    name: "fill_template",
    scope: "stella:templates",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Return stella's `{{...}}` template marker grammar: how to write " +
      "fillable values, conditional and repeating blocks, clause slots, and " +
      "numbering inside a DOCX. Takes no arguments. Call this before " +
      "create_template whenever you are unsure of the marker syntax.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    name: "template_marker_reference",
    scope: "stella:templates",
  },
  {
    description:
      "Create a document template from a DOCX file containing {{markers}}. " +
      "'docx_base64' is the base64-encoded bytes of a .docx (Office Open XML) " +
      "file; the {{field}} markers in it become the template's fillable fields. " +
      "If you are unsure how to write the markers, call " +
      "template_marker_reference first. " +
      "Max ~10 MB decoded. Returns the new template id and the number of " +
      "discovered fields. Use describe_template afterwards to inspect the fields.",
    inputSchema: {
      type: "object",
      properties: {
        name: stringProp("Template display name", { maxLength: 256 }),
        docx_base64: stringProp(
          "Base64-encoded DOCX file bytes (Office Open XML, max ~10 MB decoded)",
        ),
      },
      required: ["name", "docx_base64"],
    },
    name: "create_template",
    scope: "stella:templates",
  },
] as const satisfies readonly McpToolDefinition[];

const listTemplatesArgsSchema = v.strictObject({});

const handleListTemplatesTool: McpToolHandler = async ({ args, context }) => {
  const parsed = v.safeParse(listTemplatesArgsSchema, args);
  if (!parsed.success) {
    return errorResult("Invalid input: list_templates takes no parameters");
  }

  const rows = await context.scopedDb((tx) =>
    tx.query.templates.findMany({
      columns: {
        id: true,
        name: true,
        fieldCount: true,
        tags: true,
        whenToUse: true,
        whenNotToUse: true,
      },
      orderBy: { createdAt: "desc" },
      limit: LIMITS.templatesCount,
    }),
  );

  return textResult({ templates: rows });
};

const markerReferenceArgsSchema = v.strictObject({});

// eslint-disable-next-line require-await -- McpToolHandler is async; this handler has no I/O to await
const handleMarkerReferenceTool: McpToolHandler = async ({ args }) => {
  const parsed = v.safeParse(markerReferenceArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      "Invalid input: template_marker_reference takes no parameters",
    );
  }

  return textResult({ reference: buildMarkerReference() });
};

const describeTemplateArgsSchema = v.strictObject({
  template_id: v.pipe(v.string(), v.minLength(1)),
});

const handleDescribeTemplateTool: McpToolHandler = async ({
  args,
  context,
}) => {
  const parsed = v.safeParse(describeTemplateArgsSchema, args);
  if (!parsed.success) {
    return errorResult("Invalid input: expected { template_id: string }");
  }

  const result = await describeStoredTemplate({
    templateId: brandPersistedTemplateId(parsed.output.template_id),
    scopedDb: context.scopedDb,
  });
  if ("error" in result) {
    return errorResult(result.error);
  }

  return textResult(result);
};

const fillTemplateArgsSchema = v.strictObject({
  template_id: v.pipe(v.string(), v.minLength(1)),
  values: v.record(v.string(), v.unknown()),
});

const handleFillTemplateTool: McpToolHandler = async ({ args, context }) => {
  const parsed = v.safeParse(fillTemplateArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      "Invalid input: expected { template_id: string, values: object }",
    );
  }

  // Load the org's AI config so AI-fillable / aiAdapt fields behave exactly as
  // they do in the chat tools and web fill routes; a missing config simply
  // leaves those fields unfilled rather than erroring.
  const orgAIConfig = await loadOrgAIConfig(context.organizationId);
  const generateAiValue = buildAiFieldGenerator({
    orgAIConfig,
    organizationId: context.organizationId,
  });
  const adaptAiValue = buildAiOccurrenceAdapter({
    orgAIConfig,
    organizationId: context.organizationId,
  });

  const filled = await fillStoredTemplateWithText({
    templateId: brandPersistedTemplateId(parsed.output.template_id),
    values: parsed.output.values,
    scopedDb: context.scopedDb,
    organizationId: context.organizationId,
    generateAiValue,
    adaptAiValue,
  });
  if ("error" in filled) {
    return errorResult(filled.error);
  }

  const truncated = filled.text.length > TEMPLATE_FILL_TEXT_MAX_CHARS;

  return textResult({
    templateName: filled.templateName,
    fileName: filled.fileName,
    text: truncated
      ? filled.text.slice(0, TEMPLATE_FILL_TEXT_MAX_CHARS)
      : filled.text,
    truncated,
    docxBase64: filled.buffer.toString("base64"),
    unmatchedPlaceholders: filled.unmatchedPlaceholders,
    unusedValues: filled.unusedValues,
  });
};

const createTemplateArgsSchema = v.strictObject({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  docx_base64: v.pipe(v.string(), v.minLength(1)),
});

const handleCreateTemplateTool: McpToolHandler = async ({ args, context }) => {
  const hasPermission = roles[context.memberRole].authorize({
    template: ["create"],
  });
  if (!hasPermission.success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(createTemplateArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      "Invalid input: expected { name: string, docx_base64: string }",
    );
  }

  const buffer = Buffer.from(parsed.output.docx_base64, "base64");
  // base64 silently drops invalid characters; an empty decode means the input
  // was not valid base64 at all.
  if (buffer.byteLength === 0) {
    return errorResult("Invalid input: docx_base64 is not valid base64");
  }
  if (buffer.byteLength > FILE_SIZE_LIMIT_BYTES.document) {
    return errorResult("DOCX exceeds the maximum allowed size");
  }

  const validation = await validateDocxBuffer(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
  );
  if (!validation.valid) {
    return errorResult(`Invalid DOCX file: ${validation.error}`);
  }

  const created = await Result.gen(() =>
    createStoredTemplate({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
      userId: context.userId,
      buffer,
      name: parsed.output.name,
      fileName: `${parsed.output.name}.docx`,
      recordAuditEvent: context.recordAuditEvent,
    }),
  );
  if (Result.isError(created)) {
    return errorResult(created.error.message);
  }

  return textResult({
    templateId: created.value.id,
    name: created.value.name,
    fieldCount: created.value.fieldCount,
  });
};

export const TEMPLATE_TOOL_HANDLERS = {
  create_template: handleCreateTemplateTool,
  describe_template: handleDescribeTemplateTool,
  fill_template: handleFillTemplateTool,
  list_templates: handleListTemplatesTool,
  template_marker_reference: handleMarkerReferenceTool,
} satisfies Record<TemplateToolName, McpToolHandler>;
