import createReaderAnnotation from "@/api/handlers/legal-reader/annotations/create";
import deleteReaderAnnotation from "@/api/handlers/legal-reader/annotations/delete";
import listReaderAnnotations from "@/api/handlers/legal-reader/annotations/list";
import updateReaderAnnotation from "@/api/handlers/legal-reader/annotations/update";
import { readerAnswersRoute } from "@/api/handlers/legal-reader/answers/routes";
import { mount, routes } from "@/api/http/route";

/**
 * What a reader leaves on the legal documents they read. One surface for
 * both corpora: the document is named by `targetType` and `targetId`, so the
 * decision reader and the statutes reader post the same request.
 */
export const legalReaderRoute = mount(
  [
    routes({
      "/annotations": {
        GET: listReaderAnnotations,
        POST: createReaderAnnotation,
      },
      "/annotations/:annotationId": { PATCH: updateReaderAnnotation },
    }),
    readerAnswersRoute,
    routes({
      "/annotations/:annotationId": { DELETE: deleteReaderAnnotation },
    }),
  ],
  { prefix: "/reader" },
);
