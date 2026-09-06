/**
 * `templates.fill-preview`'s fill logic, factored out of the endpoint module
 * (`handlers/templates/fill-preview.ts`) so that module can keep to one
 * default `{ config, handler }` export while this stays directly testable.
 */

import type { Result as ResultType } from "better-result";
import { Result } from "better-result";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { extractText } from "@/api/lib/docx/extract-text";
import type { AiFieldError } from "@/api/lib/docx/resolve-ai-fields";
import type {
  ExtractedParagraph,
  TemplateStructureError,
} from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { containsNull } from "@/api/lib/templates/template-data";
import {
  fillTemplateDocx,
  loadStoredTemplateSource,
} from "@/api/lib/templates/template-fill-service";
import { buildTemplateFillAiWiring } from "@/api/lib/templates/template-fill-usage";

export type FillPreviewLogicProps = {
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  templateId: SafeId<"template">;
  body: { values: Record<string, unknown> };
};

/** What the preview renders: the filled text plus the same diagnostics a
 *  download reports. */
type FillPreviewResult = {
  paragraphs: ExtractedParagraph[];
  charCount: number;
  unmatchedPlaceholders: string[];
  unusedValues: string[];
  structureErrors: TemplateStructureError[];
  /** AI-drafted fields the model could not complete; their markers are
   *  unfilled in the preview above. */
  aiFieldErrors: AiFieldError[];
};

/** `templates.fill-preview`'s fill logic: the shared fill pipeline in its
 *  `"allow-partial"` mode, returning the rendered paragraphs and diagnostics
 *  for a live preview instead of a downloadable file. The error status is
 *  annotated because the branches below would otherwise infer as a union of
 *  differently-parameterised `HandlerError`s the caller cannot consume. */
export const fillPreviewLogic = async ({
  safeDb,
  scopedDb,
  organizationId,
  userId,
  templateId,
  body: { values: parsed },
}: FillPreviewLogicProps): Promise<
  ResultType<FillPreviewResult, HandlerError<400 | 402 | 404 | 500>>
> => {
  if (Object.values(parsed).some(containsNull)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "'values' must not contain null values.",
      }),
    );
  }

  const source = await loadStoredTemplateSource({
    templateId,
    organizationId,
    scopedDb,
  });
  if (!source) {
    return Result.err(
      new HandlerError({ status: 404, message: "Template not found" }),
    );
  }

  const result = await fillTemplateDocx({
    source,
    values: parsed,
    scopedDb,
    organizationId,
    // Live preview: the values are typically still in progress (the person is
    // mid-typing in the fill form), so partial values are explicitly allowed
    // here — the one deliberate exception to the required-fields gate every
    // other fill boundary (download, chat/MCP tool, workspace persistence)
    // enforces. Everything else, AI drafting included, runs exactly as it does
    // on download, so the preview shows what a download would produce.
    requiredFields: "allow-partial",
    // Rendering a preview is not a use of the template; nothing is recorded.
    useRecording: "caller",
    ...buildTemplateFillAiWiring({
      organizationId,
      userId,
      safeDb,
      feature: "templates.fill_preview",
      documentLanguages: source.documentLanguages,
    }),
  });

  if ("requiredFieldsRejection" in result) {
    // Unreachable under "allow-partial": the gate reports nothing. Surfaced
    // rather than dropped so the union stays exhaustively handled.
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Missing required template values: ${result.requiredFieldsRejection
          .map((field) => field.label ?? field.path)
          .join(", ")}`,
        requiredFields: result.requiredFieldsRejection,
      }),
    );
  }
  if ("usageRejection" in result) {
    return Result.err(result.usageRejection);
  }
  if ("error" in result) {
    return Result.err(new HandlerError({ status: 400, message: result.error }));
  }

  const { paragraphs, charCount } = await extractText(result.buffer);

  return Result.ok({
    paragraphs,
    charCount,
    unmatchedPlaceholders: result.unmatchedPlaceholders,
    unusedValues: result.unusedValues,
    structureErrors: result.structureErrors,
    aiFieldErrors: result.aiFieldErrors,
  });
};
