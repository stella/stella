import { Result } from "better-result";

import { mergeDocumentContent } from "@stll/folio-core";
import type { Document } from "@stll/folio-core";
import { fromMarkdown } from "@stll/folio-core/markdown";

import {
  DocxAuthoringError,
  documentToDocx,
  stellaDocument,
} from "@/api/lib/docx-authoring/document";

/**
 * Compose Markdown into a stella-styled document model.
 *
 * The parsed content is merged into a preset document rather than parsed in
 * place, so the result keeps stella's styles, numbering, font table, and A4
 * geometry, and the Markdown lists are numbered above the preset's reserved
 * definitions instead of colliding with them.
 */
export const markdownToStellaDocument = (markdown: string): Document =>
  mergeDocumentContent(stellaDocument(), fromMarkdown(markdown));

/**
 * Markdown to DOCX bytes. This is the entry point for model-written prose:
 * a chat tool, a flow step, or an export hands over plain Markdown and gets
 * a document in stella's house style. Drafts in the legal-source markup go
 * through `legalSourceToDocx` instead.
 */
export const markdownToStellaDocx = async (
  markdown: string,
): Promise<Result<ArrayBuffer, DocxAuthoringError>> =>
  await Result.tryPromise({
    try: async () => await documentToDocx(markdownToStellaDocument(markdown)),
    catch: (cause) =>
      new DocxAuthoringError({
        message: "The Markdown could not be rendered to DOCX.",
        cause,
      }),
  });
