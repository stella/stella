import type { SafeId } from "@/api/lib/branded-types";

/**
 * Single home for template DOCX object keys so the current file and its
 * immutable snapshots stay under the same organization/template prefix.
 * Readers use persisted keys, including older version-counter keys.
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

type TemplateWriteKeyOptions = {
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  writeId: SafeId<"templateVersion">;
};

/**
 * One exact key per write attempt, stable across its transport retries but
 * never shared with competing attempts (even when their bytes are identical).
 * Recovery can therefore delete a losing candidate without touching a winner.
 */
export const buildTemplateWriteS3Key = ({
  organizationId,
  templateId,
  writeId,
}: TemplateWriteKeyOptions): string =>
  `${templateKeyPrefix(organizationId, templateId)}/write-${writeId}.docx`;
