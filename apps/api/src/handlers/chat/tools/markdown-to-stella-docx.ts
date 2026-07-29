import {
  createDocx,
  createEmptyDocument,
  createStellaStyleDocumentPreset,
  mergeDocumentContent,
} from "@stll/folio-core";
import type { Document } from "@stll/folio-core";
import { fromMarkdown } from "@stll/folio-core/markdown";

/**
 * Compose Markdown into a Stella-styled document model.
 *
 * The Markdown parser's content is merged into a separate preset document so
 * the result keeps Stella's styles, numbering, font table, and A4 geometry.
 */
export const markdownToStellaDocument = (markdown: string): Document => {
  const target = createEmptyDocument({
    preset: createStellaStyleDocumentPreset(),
  });
  return mergeDocumentContent(target, fromMarkdown(markdown));
};

export const markdownToStellaDocx = async (
  markdown: string,
): Promise<ArrayBuffer> => await createDocx(markdownToStellaDocument(markdown));
