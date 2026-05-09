import { serializeDocumentToDocx } from "../serialize/docx";
import { validateDocxPackage } from "../validate/docx";
import { compileLegalSourceToDocument } from "./compile";
import type {
  LegalSourceDocxCompileResult,
  LegalSourceCompileOptions,
} from "./types";

export const compileLegalSourceToDocx = async (
  source: string,
  options: LegalSourceCompileOptions = {},
): Promise<LegalSourceDocxCompileResult> => {
  const result = compileLegalSourceToDocument(source, options);
  if (result.status !== "ok") {
    return result;
  }

  const buffer = Buffer.from(
    await serializeDocumentToDocx(result.document, {
      language: result.draft.meta.locale,
    }),
  );
  const validation = await validateDocxPackage(buffer);
  if (!validation.valid) {
    return {
      status: "needs_llm_repair",
      draft: result.draft,
      fixes: result.fixes,
      errors: [
        {
          code: "generated-docx-invalid",
          message: validation.error,
          severity: "error",
        },
      ],
    };
  }

  return { ...result, buffer };
};

export { compileLegalSourceToDocument } from "./compile";
export { parseLegalSource } from "./parser";
export { validateLegalDraft } from "./validate";
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
} from "./types";
