import {
  compileLegalSourceToDocument,
  serializeDocumentToDocx,
} from "@stll/docx-core";

/**
 * The docx-core legal-source compiler owns the whole reading of a draft:
 * directives, inline markdown (bold, italic, links), `[[placeholders]]`,
 * and the deterministic normalizations it reports as `fixes`. Nothing is
 * rewritten here; the model sees that report in the tool result and
 * decides for itself.
 */
export const compileCreateDocumentSourceToDocument = (
  source: string,
  options?: Parameters<typeof compileLegalSourceToDocument>[1],
) => compileLegalSourceToDocument(source, options);

export const compileCreateDocumentSourceToDocx = async (
  source: string,
  options?: Parameters<typeof compileLegalSourceToDocument>[1],
) => {
  const compiled = compileCreateDocumentSourceToDocument(source, options);
  if (compiled.status !== "ok") {
    return compiled;
  }
  return {
    ...compiled,
    buffer: await serializeDocumentToDocx(compiled.document, {
      language: compiled.draft.meta.locale,
    }),
  };
};
