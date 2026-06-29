/**
 * Model-level RTL base-direction normalization.
 *
 * The in-editor AutoBidiDetection runs on the ProseMirror doc, so it only
 * reaches a save when `getDocument()` can read the editor view's state. If the
 * body view was never instantiated, `buildCurrentDocument` falls back to the
 * untouched `history.state` Document, which would export RTL-led paragraphs
 * without `w:bidi`. This pass fills the same gap at the model layer: it sets
 * `bidi` on undecided RTL-led paragraphs while leaving explicit decisions
 * (`true`/`false`) and LTR paragraphs alone.
 *
 * Detection mirrors the editor's first-strong rule via `detectBaseDirection`.
 * Text extraction is best-effort over the dominant content (runs and
 * hyperlinked runs); inline fields and tracked-change wrappers are treated as
 * neutral here (the editor path covers them when a view exists).
 */
import type {
  BlockContent,
  Document,
  Hyperlink,
  Paragraph,
  ParagraphContent,
  Run,
  Table,
} from "../types/document";
import { detectBaseDirection } from "../utils/baseDirection";

const runText = (run: Run): string => {
  let text = "";
  for (const piece of run.content) {
    if (piece.type === "text") {
      text += piece.text;
    }
  }
  return text;
};

const hyperlinkText = (link: Hyperlink): string => {
  let text = "";
  for (const child of link.children) {
    if (child.type === "run") {
      text += runText(child);
    }
  }
  return text;
};

// First-strong directional text for model paragraph content. Mirrors the
// editor's field/SDT-aware detection: it folds in field result text and recurses
// inline content controls and insertion wrappers (deleted/moved-away content is
// not live text, so it is skipped). Mutually recursive, hence declarations.
function paragraphContentText(items: readonly ParagraphContent[]): string {
  let text = "";
  for (const item of items) {
    text += singleItemText(item);
  }
  return text;
}

function singleItemText(item: ParagraphContent): string {
  switch (item.type) {
    case "run":
      return runText(item);
    case "hyperlink":
      return hyperlinkText(item);
    case "simpleField":
    case "insertion":
      return paragraphContentText(item.content);
    case "complexField":
      return paragraphContentText(item.fieldResult);
    case "inlineSdt":
      return paragraphContentText(item.content);
    default:
      return "";
  }
}

const paragraphText = (paragraph: Paragraph): string =>
  paragraphContentText(paragraph.content);

const normalizeParagraph = (paragraph: Paragraph): Paragraph => {
  // Respect an explicit decision (true = RTL, false = forced LTR); only fill in
  // the undecided case.
  if (paragraph.formatting?.bidi != null) {
    return paragraph;
  }
  if (detectBaseDirection(paragraphText(paragraph)) !== "rtl") {
    return paragraph;
  }
  return {
    ...paragraph,
    formatting: { ...paragraph.formatting, bidi: true },
  };
};

const normalizeTable = (table: Table): Table => ({
  ...table,
  rows: table.rows.map((row) => ({
    ...row,
    cells: row.cells.map((cell) => ({
      ...cell,
      content: cell.content.map((block) =>
        block.type === "paragraph"
          ? normalizeParagraph(block)
          : normalizeTable(block),
      ),
    })),
  })),
});

const normalizeBlocks = (blocks: BlockContent[]): BlockContent[] =>
  blocks.map((block) => {
    if (block.type === "paragraph") {
      return normalizeParagraph(block);
    }
    if (block.type === "table") {
      return normalizeTable(block);
    }
    // Block content control: recurse into its block children.
    return { ...block, content: normalizeBlocks(block.content) };
  });

/**
 * Return a copy of `doc` with `bidi` filled in for undecided RTL-led body
 * paragraphs (including those nested in tables and block content controls).
 */
export const normalizeBaseDirection = (doc: Document): Document => ({
  ...doc,
  package: {
    ...doc.package,
    document: {
      ...doc.package.document,
      content: normalizeBlocks(doc.package.document.content),
    },
  },
});
