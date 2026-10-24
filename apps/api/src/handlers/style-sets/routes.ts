import Elysia from "elysia";

import createStyleSet from "@/api/handlers/style-sets/create";
import deleteStyleSet from "@/api/handlers/style-sets/delete";
import downloadStyleSet from "@/api/handlers/style-sets/download";
import readStyleSetEditor from "@/api/handlers/style-sets/editor/get";
import createStyleSetFromEditor from "@/api/handlers/style-sets/from-editor/create";
import updateStyleSetFromEditor from "@/api/handlers/style-sets/from-editor/update";
import listStyleSets from "@/api/handlers/style-sets/list";
import previewStyleSetFromEditor from "@/api/handlers/style-sets/preview-from-editor";
import replaceStyleSet from "@/api/handlers/style-sets/replace";
import readStellaStyleEditor from "@/api/handlers/style-sets/stella-editor/get";
import updateStyleSet from "@/api/handlers/style-sets/update";
import { isStyleSetUploadRateLimitedRequest } from "@/api/handlers/style-sets/upload-rate-limit";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

export const styleSetsRoute = new Elysia({ prefix: "/style-sets" })
  .use(authMacro)
  .use(permissionMacro)
  .use(
    rateLimit({
      duration: API_RATE_LIMITS.upload.duration,
      max: API_RATE_LIMITS.upload.max,
      budget: { name: "api.upload.address", keyKind: "address" },
      ...createRedisRateLimit({
        failurePolicy: "fail_open_local",
        scope: "style-set-upload",
      }),
      skip: (request) => !isStyleSetUploadRateLimitedRequest(request),
    }),
  )
  .guard({ validateAuth: true })
  .get("/", listStyleSets.handler, {
    permissions: listStyleSets.config.permissions,
    accountAccess: listStyleSets.config.accountAccess,
    query: listStyleSets.config.query,
  })
  .put("/", createStyleSet.handler, {
    body: createStyleSet.config.body,
    permissions: createStyleSet.config.permissions,
    accountAccess: createStyleSet.config.accountAccess,
  })
  .get("/editor/stella", readStellaStyleEditor.handler, {
    permissions: readStellaStyleEditor.config.permissions,
    accountAccess: readStellaStyleEditor.config.accountAccess,
  })
  .post("/editor/preview", previewStyleSetFromEditor.handler, {
    body: previewStyleSetFromEditor.config.body,
    permissions: previewStyleSetFromEditor.config.permissions,
    accountAccess: previewStyleSetFromEditor.config.accountAccess,
  })
  .put("/editor", createStyleSetFromEditor.handler, {
    body: createStyleSetFromEditor.config.body,
    permissions: createStyleSetFromEditor.config.permissions,
    accountAccess: createStyleSetFromEditor.config.accountAccess,
  })
  .get("/:styleSetId/download", downloadStyleSet.handler, {
    params: downloadStyleSet.config.params,
    permissions: downloadStyleSet.config.permissions,
    accountAccess: downloadStyleSet.config.accountAccess,
  })
  .post("/:styleSetId", updateStyleSet.handler, {
    body: updateStyleSet.config.body,
    params: updateStyleSet.config.params,
    permissions: updateStyleSet.config.permissions,
    accountAccess: updateStyleSet.config.accountAccess,
  })
  .post("/:styleSetId/source", replaceStyleSet.handler, {
    body: replaceStyleSet.config.body,
    params: replaceStyleSet.config.params,
    permissions: replaceStyleSet.config.permissions,
    accountAccess: replaceStyleSet.config.accountAccess,
  })
  .get("/:styleSetId/editor", readStyleSetEditor.handler, {
    params: readStyleSetEditor.config.params,
    permissions: readStyleSetEditor.config.permissions,
    accountAccess: readStyleSetEditor.config.accountAccess,
  })
  .post("/:styleSetId/editor", updateStyleSetFromEditor.handler, {
    body: updateStyleSetFromEditor.config.body,
    params: updateStyleSetFromEditor.config.params,
    permissions: updateStyleSetFromEditor.config.permissions,
    accountAccess: updateStyleSetFromEditor.config.accountAccess,
  })
  .delete("/:styleSetId", deleteStyleSet.handler, {
    params: deleteStyleSet.config.params,
    permissions: deleteStyleSet.config.permissions,
    accountAccess: deleteStyleSet.config.accountAccess,
  });
