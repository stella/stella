/**
 * Where folio painted a block, for surfaces that have to sit beside the page.
 *
 * Folio keeps two parallel DOM trees: the ProseMirror source tree, which is
 * hidden and carries no page geometry, and the paginated layout, which is what
 * the reader actually sees. Only the layout can be measured, and it addresses
 * a paragraph by its position in document order — `data-block-id="block-N"`,
 * `N` one-based over the same non-empty-block walk that
 * `createAIEditSnapshot()` and the server-side DOCX extractor use to mint
 * citation block ids.
 *
 * That selector is the whole contract between folio's renderer and everything
 * that points at a clause, so it lives here once rather than in every caller.
 */

import type { RefObject } from "react";

import type { DocxEditorRef } from "@stll/folio-react";

/**
 * The scroll container folio paints its pages into, for the editor this ref
 * addresses. `null` before the editor view mounts.
 *
 * Resolved through the editor's own view rather than a document-wide query:
 * a workspace can have the main viewer and an inspector preview mounted at
 * once, and a note pinned to the wrong document's geometry is worse than no
 * note at all.
 */
export const folioScrollRoot = (
  editorRef: RefObject<DocxEditorRef | null>,
): HTMLElement | null =>
  editorRef.current
    ?.getEditorRef()
    ?.getView()
    ?.dom.closest<HTMLElement>("[data-folio-scroll]") ?? null;

/**
 * The painted element for the block at `blockIndex` (zero-based, document
 * order), or `null` when folio has not laid that page out yet — pages
 * materialize as the reader scrolls toward them.
 */
export const folioLayoutBlockElement = (
  root: ParentNode,
  blockIndex: number,
): HTMLElement | null =>
  root.querySelector<HTMLElement>(
    `.layout-page [data-block-id="block-${String(blockIndex + 1)}"]`,
  );
