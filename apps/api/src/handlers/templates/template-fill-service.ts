/**
 * Shared template orchestration for the chat (MCP) tools: load a stored
 * template's DOCX from S3, then either describe its fields or fill it and
 * return the assembled text. Mirrors the fill-preview route's recipe
 * (discover clause slots → fill → extractText), reusing the same underlying,
 * already-tested functions.
 */

import type { ScopedDb } from "@/api/db";
import { discoverClauseSlots } from "@/api/handlers/docx/discover-clause-slots";
import { discoverTemplate } from "@/api/handlers/docx/discover-template";
import { extractText } from "@/api/handlers/docx/extract-text";
import { fillTemplate } from "@/api/handlers/docx/patch-template";
import { resolveClauseSlots } from "@/api/handlers/docx/resolve-clause-slots";
import { readManifest } from "@/api/handlers/docx/template-manifest";
import { isTemplateData } from "@/api/handlers/docx/types";
import type { SafeId } from "@/api/lib/branded-types";
import { getS3 } from "@/api/lib/s3";

const loadTemplate = async (
  templateId: SafeId<"template">,
  scopedDb: ScopedDb,
): Promise<{ name: string; buffer: Buffer } | null> => {
  // RLS on scopedDb scopes this to the caller's organization.
  const template = await scopedDb((tx) =>
    tx.query.templates.findFirst({
      where: { id: { eq: templateId } },
      columns: { name: true, s3Key: true },
    }),
  );
  if (!template) {
    return null;
  }
  const buffer = Buffer.from(await getS3().file(template.s3Key).arrayBuffer());
  return { name: template.name, buffer };
};

export type DescribeTemplateResult =
  | {
      name: string;
      fields: {
        path: string;
        label: string | null;
        inputType: string;
        required: boolean;
      }[];
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
    return {
      name: loaded.name,
      fields: manifest.fields.map((field) => ({
        path: field.path,
        label: field.label ?? null,
        inputType: field.inputType ?? "text",
        required: field.required ?? false,
      })),
      conditions: manifest.conditions.map((c) => ({
        name: c.name,
        expression: c.expression,
      })),
      computed: (manifest.computed ?? []).map((c) => ({
        name: c.name,
        expression: c.expression,
      })),
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
    })),
    conditions: [],
    computed: [],
  };
};

export type FillTemplateResult =
  | { text: string; unmatchedPlaceholders: string[]; unusedValues: string[] }
  | { error: string };

export const fillStoredTemplate = async ({
  templateId,
  values,
  scopedDb,
  organizationId,
}: {
  templateId: SafeId<"template">;
  values: Record<string, unknown>;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
}): Promise<FillTemplateResult> => {
  const loaded = await loadTemplate(templateId, scopedDb);
  if (!loaded) {
    return { error: "Template not found." };
  }

  const record: Record<string, unknown> = { ...values };

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

  if (!isTemplateData(record)) {
    return {
      error:
        "Values must be strings, numbers, booleans, arrays, or nested objects.",
    };
  }

  const result = await fillTemplate(loaded.buffer, record);
  const { paragraphs } = await extractText(result.buffer);

  return {
    text: paragraphs
      .map((paragraph) => paragraph.text)
      .join("\n")
      .trim(),
    unmatchedPlaceholders: result.unmatchedPlaceholders,
    unusedValues: result.unusedValues,
  };
};
