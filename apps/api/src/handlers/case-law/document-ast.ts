export type {
  Block,
  DocumentAst,
  DocumentAstMetadata,
  DocumentAstSource,
  HeadingBlock,
  Inline,
  InlineBold,
  InlineItalic,
  InlineLineBreak,
  InlineLink,
  InlineText,
  ParagraphBlock,
  ParagraphRole,
  TableBlock,
  TableCell,
} from "@/api/lib/case-law/document-ast";

export {
  getDocumentAstMetadata,
  hasUsableAst,
  isDocumentAst,
  parseDocumentAst,
} from "@/api/lib/case-law/document-ast";
