import Elysia from "elysia";

import readDocumentReviewPassages from "@/api/handlers/document-reviews/read-passages";
import { authMacro, permissionMacro } from "@/api/lib/auth";

/** Organization-level: a playbook quotes passages from matters of its own,
 *  so the read is not bound to one matter the way the run routes are. */
export const documentReviewPassagesRoute = new Elysia({
  prefix: "/document-reviews",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .post("/passages", readDocumentReviewPassages.handler, {
    body: readDocumentReviewPassages.config.body,
    permissions: readDocumentReviewPassages.config.permissions,
  });
