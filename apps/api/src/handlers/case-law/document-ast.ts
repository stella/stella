// parser-output-unchanged: Unused facade re-exports removed; canonical AST implementation unchanged.
export type {
  Block,
  DocumentAst,
  DocumentAstMetadata,
  HeadingBlock,
  HeadingLevel,
  Inline,
  ParagraphBlock,
  ParagraphRole,
  TableBlock,
  TableCell,
} from "@/api/lib/case-law/document-ast";

export {
  hasBlockInlines,
  hasInlineChildren,
  hasUsableAst,
  plainTextOf,
  projectPlainText,
} from "@/api/lib/case-law/document-ast";
