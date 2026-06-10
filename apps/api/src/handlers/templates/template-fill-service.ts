/**
 * Shared template orchestration for the chat (MCP) tools: load a stored
 * template's DOCX from S3, then either describe its fields or fill it and
 * return the assembled text. Mirrors the fill-preview route's recipe
 * (discover clause slots → fill → extractText), reusing the same underlying,
 * already-tested functions.
 */

import type { ScopedDb } from "@/api/db";
import {
  adaptAiFields,
  type AiOccurrenceAdapter,
} from "@/api/handlers/docx/adapt-ai-fields";
import { discoverClauseSlots } from "@/api/handlers/docx/discover-clause-slots";
import { discoverTemplate } from "@/api/handlers/docx/discover-template";
import { extractText } from "@/api/handlers/docx/extract-text";
import { createDispatchLookupResolver } from "@/api/handlers/docx/lookup-fields";
import { applyManifestFillSteps } from "@/api/handlers/docx/manifest-fill-steps";
import { fillTemplate } from "@/api/handlers/docx/patch-template";
import {
  type AiFieldGenerator,
  resolveAiFields,
} from "@/api/handlers/docx/resolve-ai-fields";
import { resolveClauseSlots } from "@/api/handlers/docx/resolve-clause-slots";
import { readManifest } from "@/api/handlers/docx/template-manifest";
import type {
  FieldDateFormat,
  FieldPart,
  InputType,
} from "@/api/handlers/docx/types";
import { isTemplateData } from "@/api/handlers/docx/types";
import { recordTemplateUse } from "@/api/handlers/templates/record-use";
import type { SafeId } from "@/api/lib/branded-types";
import { getS3 } from "@/api/lib/s3";

// Data a template is filled with: open-ended field-path → value map (paths come
// from the template's manifest/markers, not a fixed entity), patched in place
// with resolved clause slots and AI-drafted fields before fill.
type FillValues = Record<string, unknown>;

const loadTemplate = async (
  templateId: SafeId<"template">,
  scopedDb: ScopedDb,
): Promise<{ name: string; fileName: string; buffer: Buffer } | null> => {
  // RLS on scopedDb scopes this to the caller's organization.
  const template = await scopedDb((tx) =>
    tx.query.templates.findFirst({
      where: { id: { eq: templateId } },
      columns: { name: true, fileName: true, s3Key: true },
    }),
  );
  if (!template) {
    return null;
  }
  const buffer = Buffer.from(await getS3().file(template.s3Key).arrayBuffer());
  return { name: template.name, fileName: template.fileName, buffer };
};

type DescribedField = {
  path: string;
  label: string | null;
  inputType: InputType;
  required: boolean;
  /** Short fill guidance (expected format, where to find the value). */
  hint: string | null;
  /** Allowed values for a select; null when the field is not a select. */
  options: string[] | null;
  /**
   * Lookup field output formats: the bare `{{path}}` marker renders the first
   * format; later formats are addressed by `{{path.key}}`. Null for
   * non-lookup fields so an agent knows which fields resolve from a registry.
   */
  formats: { key: string; template: string }[] | null;
  /** AI-drafting instruction (this field is written by AI at fill time when
   *  the value is omitted); null when the field is not AI-drafted. */
  aiPrompt: string | null;
  /** True when the entered value is a stub AI rewrites per occurrence to fit
   *  the surrounding text; false otherwise. */
  aiAdapt: boolean;
  /** Path of another field that supplies this select's options live at fill
   *  time (dependent select); null when the options are static/none. */
  optionsFrom: string | null;
  /** Locale-aware date rendering for a date field; null when unset. */
  dateFormat: FieldDateFormat | null;
  /** Composite parts joined by {@link DescribedField.format}; null when the
   *  field is not composite. */
  parts: FieldPart[] | null;
  /** Join template over the composite part keys; null when not composite. */
  format: string | null;
};

export type DescribeTemplateResult =
  | {
      name: string;
      fields: DescribedField[];
      conditions: { name: string; expression: string }[];
      computed: { name: string; expression: string }[];
    }
  | { error: string };

export const describeStoredTemplate = async ({
  templateId,
  scopedDb,
}: {
  templateId: SafeId<"template">;
  scopedDb: ScopedDb;
}): Promise<DescribeTemplateResult> => {
  const loaded = await loadTemplate(templateId, scopedDb);
  if (!loaded) {
    return { error: "Template not found." };
  }

  const manifest = await readManifest(loaded.buffer);
  if (manifest) {
    // Formula fields are derived at fill time, never user-submitted, so they
    // are reported as computed values rather than fillable fields.
    return {
      name: loaded.name,
      fields: manifest.fields
        .filter((field) => field.formula === undefined)
        .map((field) => ({
          path: field.path,
          label: field.label ?? null,
          inputType: field.inputType ?? "text",
          required: field.required ?? false,
          hint: field.hint ?? null,
          options: field.options ?? null,
          formats:
            field.lookup === undefined
              ? null
              : field.lookup.formats.map((format) => ({
                  key: format.key,
                  template: format.template,
                })),
          aiPrompt: field.aiPrompt ?? null,
          aiAdapt: field.aiAdapt ?? false,
          optionsFrom: field.optionsFrom ?? null,
          dateFormat: field.dateFormat ?? null,
          parts: field.parts ?? null,
          format: field.format ?? null,
        })),
      conditions: manifest.conditions.map((c) => ({
        name: c.name,
        expression: c.expression,
      })),
      computed: manifest.fields.flatMap((field) =>
        field.formula === undefined
          ? []
          : [{ name: field.path, expression: field.formula }],
      ),
    };
  }

  // No manifest (a raw upload): fall back to discovered field paths.
  const discovered = await discoverTemplate(loaded.buffer);
  return {
    name: loaded.name,
    fields: discovered.fields.map((field) => ({
      path: field.path,
      label: null,
      inputType: "text",
      required: false,
      hint: null,
      options: null,
      formats: null,
      aiPrompt: null,
      aiAdapt: false,
      optionsFrom: null,
      dateFormat: null,
      parts: null,
      format: null,
    })),
    conditions: [],
    computed: [],
  };
};

type FillServiceOptions = {
  templateId: SafeId<"template">;
  values: FillValues;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  /** Optional model-backed generator for AI-fillable fields (aiPrompt). */
  generateAiValue?: AiFieldGenerator | undefined;
  /** Optional model-backed per-occurrence adapter for aiAdapt fields. */
  adaptAiValue?: AiOccurrenceAdapter | undefined;
};

type FilledDocx = {
  templateName: string;
  fileName: string;
  buffer: Buffer;
  unmatchedPlaceholders: string[];
  unusedValues: string[];
  structureErrors: Awaited<ReturnType<typeof fillTemplate>>["structureErrors"];
};

/**
 * Shared fill recipe: load the stored DOCX, resolve clause slots, run the
 * manifest fill steps (lookups, composites, formulas, dependent selects),
 * draft/adapt AI fields, then substitute. Records the template use.
 * Mirrors the fill-by-id route's pipeline so a template fills identically
 * at every boundary. Backs the fill-to-workspace route (which persists the
 * bytes as a matter document) and the chat tools' text fill below.
 */
export const fillStoredTemplateDocx = async ({
  templateId,
  values,
  scopedDb,
  organizationId,
  generateAiValue,
  adaptAiValue,
}: FillServiceOptions): Promise<FilledDocx | { error: string }> => {
  const loaded = await loadTemplate(templateId, scopedDb);
  if (!loaded) {
    return { error: "Template not found." };
  }

  let record: FillValues = { ...values };

  const slots = await discoverClauseSlots(loaded.buffer);
  if (slots.length > 0) {
    const patches = await resolveClauseSlots(
      templateId,
      slots,
      scopedDb,
      organizationId,
    );
    for (const [key, value] of Object.entries(patches)) {
      record[key] = value;
    }
  }

  // Draft AI-fillable fields (manifest fields with an aiPrompt) before fill.
  let fillBuffer = loaded.buffer;
  let adaptedPaths: readonly string[] = [];
  const manifest = await readManifest(loaded.buffer);
  if (manifest) {
    // Resolve registry lookups, assemble composite (multipart) values,
    // evaluate formula (derived) fields, and check dependent (optionsFrom)
    // selects before any AI step or substitution sees them; a failing step
    // rejects naming the field.
    const stepError = await applyManifestFillSteps({
      values: record,
      manifest,
      resolveLookup: createDispatchLookupResolver(),
    });
    if (stepError !== null) {
      return { error: stepError };
    }

    record = await resolveAiFields({
      values: record,
      fields: manifest.fields,
      generate: generateAiValue,
    });
    // Rewrite each aiAdapt marker occurrence to fit its surrounding text;
    // the stub stays in `record` so uncovered occurrences still get the
    // plain global substitution below.
    const adapted = await adaptAiFields({
      buffer: loaded.buffer,
      fields: manifest.fields,
      values: record,
      adapt: adaptAiValue,
    });
    fillBuffer = adapted.buffer;
    adaptedPaths = adapted.adaptedPaths;
  }

  if (!isTemplateData(record)) {
    return {
      error:
        "Values must be strings, numbers, booleans, arrays, or nested objects.",
    };
  }

  const result = await fillTemplate(fillBuffer, record);

  await scopedDb(async (tx) => {
    await recordTemplateUse({ tx, templateId });
  });

  return {
    templateName: loaded.name,
    fileName: loaded.fileName,
    buffer: result.buffer,
    unmatchedPlaceholders: result.unmatchedPlaceholders,
    // Adapted stubs no longer match a marker (each occurrence was already
    // substituted), so they are not "unused" in any user-meaningful sense.
    unusedValues: result.unusedValues.filter(
      (name) => !adaptedPaths.includes(name),
    ),
    structureErrors: result.structureErrors,
  };
};

export type FillTemplateResult =
  | { text: string; unmatchedPlaceholders: string[]; unusedValues: string[] }
  | { error: string };

/**
 * Fill result that carries both the rendered DOCX bytes and the assembled
 * plain text. Backs the MCP `fill_template` tool, which returns the text for
 * the agent to read plus the bytes (base64) for the agent to save.
 */
export type FillTemplateWithDocxResult =
  | {
      templateName: string;
      fileName: string;
      buffer: Buffer;
      text: string;
      unmatchedPlaceholders: string[];
      unusedValues: string[];
    }
  | { error: string };

export const fillStoredTemplateWithText = async (
  options: FillServiceOptions,
): Promise<FillTemplateWithDocxResult> => {
  const filled = await fillStoredTemplateDocx(options);
  if ("error" in filled) {
    return filled;
  }

  const { paragraphs } = await extractText(filled.buffer);

  return {
    templateName: filled.templateName,
    fileName: filled.fileName,
    buffer: filled.buffer,
    text: paragraphs
      .map((paragraph) => paragraph.text)
      .join("\n")
      .trim(),
    unmatchedPlaceholders: filled.unmatchedPlaceholders,
    unusedValues: filled.unusedValues,
  };
};

export const fillStoredTemplate = async (
  options: FillServiceOptions,
): Promise<FillTemplateResult> => {
  const filled = await fillStoredTemplateDocx(options);
  if ("error" in filled) {
    return filled;
  }

  const { paragraphs } = await extractText(filled.buffer);

  return {
    text: paragraphs
      .map((paragraph) => paragraph.text)
      .join("\n")
      .trim(),
    unmatchedPlaceholders: filled.unmatchedPlaceholders,
    unusedValues: filled.unusedValues,
  };
};
