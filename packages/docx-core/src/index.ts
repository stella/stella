export type {
  BlockContent,
  BreakContent,
  Document,
  DocumentBody,
  DocxPackage,
  Paragraph,
  ParagraphContent,
  Run,
  RunContent,
  SectionProperties,
  Style,
  Table,
  TableCell,
  TableRow,
  TextContent,
} from "./model/document";
export {
  compileLegalSourceToDocument,
  compileLegalSourceToDocx,
  parseLegalSource,
  validateLegalDraft,
} from "./legal-source";
export type {
  Autofix,
  CompiledLegalDocument,
  LegalDraft,
  LegalDraftBlock,
  LegalDraftDiagnostic,
  LegalSourceCompileOptions,
  LegalSourceCompileResult,
  LegalSourceDocxCompileResult,
  LegalSourceParseResult,
} from "./legal-source";
export { serializeDocumentToDocx } from "./serialize/docx";
export { validateDocxPackage } from "./validate/docx";
export type { ValidateDocxPackageResult } from "./validate/docx";
