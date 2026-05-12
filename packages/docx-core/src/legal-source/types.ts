import type { Document } from "../model/document";

export type LegalDocumentKind =
  | "agreement"
  | "letter"
  | "memo"
  | "checklist"
  | "pleading"
  | "other";

export type LegalNumberingProfile = "legal" | "none" | "checklist";

export type LegalPageSize = "A4" | "Letter";
export type LegalPageOrientation = "portrait" | "landscape";

export type LegalDraftMeta = {
  kind: LegalDocumentKind;
  locale: string;
  numbering: LegalNumberingProfile;
  page: {
    size: LegalPageSize;
    orientation: LegalPageOrientation;
  };
  title: string | null;
};

export type LegalTable = {
  headers: string[];
  rows: string[][];
};

export type LegalSignatureParty = {
  name: string;
  signatory?: string;
  title?: string;
};

export type LegalDraftBlock =
  | { type: "title"; text: string }
  | { type: "recital"; paragraphs: string[] }
  | { type: "clause"; level: number; heading: string; paragraphs: string[] }
  | { type: "paragraph"; paragraphs: string[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; table: LegalTable }
  | { type: "schedule"; heading: string; paragraphs: string[] }
  | { type: "signatures"; parties: LegalSignatureParty[] }
  | { type: "pageBreak" };

export type LegalDraft = {
  meta: LegalDraftMeta;
  blocks: LegalDraftBlock[];
};

export type LegalDraftDiagnosticSeverity = "warning" | "error";

export type LegalDraftDiagnostic = {
  code: string;
  message: string;
  severity: LegalDraftDiagnosticSeverity;
  line?: number;
};

export type Autofix = {
  code: string;
  message: string;
  line?: number;
};

export type LegalSourceParseResult = {
  draft: LegalDraft;
  fixes: Autofix[];
  diagnostics: LegalDraftDiagnostic[];
};

export type LegalSourceCompileOptions = {
  titleFallback?: string;
};

export type CompiledLegalDocument = {
  document: Document;
  draft: LegalDraft;
  fixes: Autofix[];
  warnings: LegalDraftDiagnostic[];
};

export type LegalSourceCompileResult =
  | ({ status: "ok" } & CompiledLegalDocument)
  | {
      status: "needs_llm_repair";
      draft: LegalDraft;
      fixes: Autofix[];
      errors: LegalDraftDiagnostic[];
    };

export type LegalSourceDocxCompileResult =
  | ({ status: "ok"; buffer: Buffer } & CompiledLegalDocument)
  | Extract<LegalSourceCompileResult, { status: "needs_llm_repair" }>;
