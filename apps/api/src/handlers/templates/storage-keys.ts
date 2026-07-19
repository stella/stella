import type { SafeId } from "@/api/lib/branded-types";

/**
 * Single home for template DOCX object keys so the current file and its
 * immutable per-version snapshots stay on the same addressing scheme. Both
 * keys share the `${organizationId}/templates/${templateId}` prefix: the base
 * key is the live document, and each version appends `/v${version}.docx`.
 */
const templateKeyPrefix = (
  organizationId: SafeId<"organization">,
  templateId: SafeId<"template">,
) => `${organizationId}/templates/${templateId}`;

/** Object key for a template's current (live) DOCX. */
export const buildTemplateS3Key = (
  organizationId: SafeId<"organization">,
  templateId: SafeId<"template">,
) => `${templateKeyPrefix(organizationId, templateId)}.docx`;

/** Immutable per-version object key so historical snapshots stay downloadable. */
export const buildTemplateVersionS3Key = (
  organizationId: SafeId<"organization">,
  templateId: SafeId<"template">,
  version: number,
) => `${templateKeyPrefix(organizationId, templateId)}/v${version}.docx`;
