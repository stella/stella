import { createSearchQueryMatcher } from "@stll/text-normalize/search-query-matcher";

import { DOCX_MIME, PDF_MIME } from "@/lib/consts";

const MAX_VISIBLE_DOCUMENTS = 30;

type MatterDocument = {
  entityId: string;
  fileName: string;
  mimeType: string;
  name?: string | null;
};

/** The matter's documents a picker offers: the ones stored as DOCX or PDF. */
export const pickableDocuments = <T extends MatterDocument>(
  files: readonly T[],
) =>
  files.filter(
    (file) => file.mimeType === DOCX_MIME || file.mimeType === PDF_MIME,
  );

export const filterVisibleDocuments = <T extends MatterDocument>(
  files: readonly T[],
  search: string,
) => {
  const matches = createSearchQueryMatcher(search);
  return pickableDocuments(files)
    .filter((file) => matches(file.name ?? file.fileName))
    .slice(0, MAX_VISIBLE_DOCUMENTS);
};
