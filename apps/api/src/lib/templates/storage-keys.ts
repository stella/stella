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

type TemplateRevisionKeyOptions = {
  contents: Uint8Array;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  version: number;
};

/**
 * Object key for re-embedded bytes of a version that already exists (a manifest
 * overlay that adds no version). The writer stores them here and repoints the
 * rows in the same transaction rather than overwriting the object those rows
 * still reference, so a transaction that rolls back after the write leaves an
 * unreferenced object instead of bytes the rows disagree with.
 *
 * The key is the digest of the bytes it holds, so re-applying an overlay that
 * produces an identical document rewrites one key instead of adding another.
 */
export const buildTemplateRevisionS3Key = ({
  contents,
  organizationId,
  templateId,
  version,
}: TemplateRevisionKeyOptions): string => {
  const digest = new Bun.CryptoHasher("sha256")
    .update(contents)
    .digest("hex")
    .slice(0, 16);
  return `${templateKeyPrefix(organizationId, templateId)}/v${version}-${digest}.docx`;
};
