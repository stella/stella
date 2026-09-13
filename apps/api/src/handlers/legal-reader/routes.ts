import Elysia from "elysia";

import createReaderAnnotation from "@/api/handlers/legal-reader/annotations/create";
import deleteReaderAnnotation from "@/api/handlers/legal-reader/annotations/delete";
import listReaderAnnotations from "@/api/handlers/legal-reader/annotations/list";
import updateReaderAnnotation from "@/api/handlers/legal-reader/annotations/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";

/**
 * What a reader leaves on the legal documents they read. One surface for
 * both corpora: the document is named by `targetType` and `targetId`, so the
 * decision reader and the statutes reader post the same request.
 */
export const legalReaderRoute = new Elysia({ prefix: "/reader" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/annotations", listReaderAnnotations.handler, {
    query: listReaderAnnotations.config.query,
    permissions: listReaderAnnotations.config.permissions,
  })
  .post("/annotations", createReaderAnnotation.handler, {
    body: createReaderAnnotation.config.body,
    permissions: createReaderAnnotation.config.permissions,
  })
  .patch("/annotations/:annotationId", updateReaderAnnotation.handler, {
    body: updateReaderAnnotation.config.body,
    params: updateReaderAnnotation.config.params,
    permissions: updateReaderAnnotation.config.permissions,
  })
  .delete("/annotations/:annotationId", deleteReaderAnnotation.handler, {
    params: deleteReaderAnnotation.config.params,
    permissions: deleteReaderAnnotation.config.permissions,
  });
