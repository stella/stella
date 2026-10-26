import { createSearchQueryMatcher } from "@stll/text-normalize";

import { DOCX_MIME, PDF_MIME } from "@/lib/consts";

const MAX_VISIBLE_DOCUMENTS = 30;

type MatterDocument = {
  entityId: string;
  fileName: string;
  mimeType: string;
  name?: string | null;
};

export const filterVisibleDocuments = <T extends MatterDocument>(
  files: readonly T[],
  search: string,
) => {
  const matches = createSearchQueryMatcher(search);
  return files
    .filter(
      (file) =>
        (file.mimeType === DOCX_MIME || file.mimeType === PDF_MIME) &&
        matches(file.name ?? file.fileName),
    )
    .slice(0, MAX_VISIBLE_DOCUMENTS);
};
