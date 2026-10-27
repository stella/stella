import readDocumentReviewPassages from "@/api/handlers/document-reviews/read-passages";
import { routes } from "@/api/http/route";

/** Organization-level: a playbook quotes passages from matters of its own,
 *  so the read is not bound to one matter the way the run routes are. */
export const documentReviewPassagesRoute = routes(
  {
    "/passages": { POST: readDocumentReviewPassages },
  },
  { prefix: "/document-reviews" },
);
