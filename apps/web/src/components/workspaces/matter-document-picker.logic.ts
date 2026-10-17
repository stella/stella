import { foldSearchMatchText } from "@stll/text-normalize";
import { containsSearchMatchKey } from "@stll/text-normalize/search-match-key";

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
  const foldedQuery = foldSearchMatchText(search);
  return files
    .filter(
      (file) =>
        (file.mimeType === DOCX_MIME || file.mimeType === PDF_MIME) &&
        containsSearchMatchKey(
          foldSearchMatchText(file.name ?? file.fileName),
          foldedQuery,
        ),
    )
    .slice(0, MAX_VISIBLE_DOCUMENTS);
};
