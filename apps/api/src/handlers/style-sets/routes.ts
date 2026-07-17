import Elysia from "elysia";
import { rateLimit } from "elysia-rate-limit";

import createStyleSet from "@/api/handlers/style-sets/create";
import createStyleSetFromEditor from "@/api/handlers/style-sets/create-from-editor";
import deleteStyleSet from "@/api/handlers/style-sets/delete";
import downloadStyleSet from "@/api/handlers/style-sets/download";
import listStyleSets from "@/api/handlers/style-sets/list";
import readStyleSetEditor from "@/api/handlers/style-sets/read-editor";
import readStellaStyleEditor from "@/api/handlers/style-sets/read-stella-editor";
import replaceStyleSet from "@/api/handlers/style-sets/replace";
import updateStyleSet from "@/api/handlers/style-sets/update";
import updateStyleSetFromEditor from "@/api/handlers/style-sets/update-from-editor";
import { isStyleSetUploadRateLimitedRequest } from "@/api/handlers/style-sets/upload-rate-limit";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

export const styleSetsRoute = new Elysia({ prefix: "/style-sets" })
  .use(authMacro)
  .use(permissionMacro)
  .use(
    rateLimit({
      scoping: "scoped",
      duration: API_RATE_LIMITS.upload.duration,
      max: API_RATE_LIMITS.upload.max,
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
    query: listStyleSets.config.query,
  })
  .put("/", createStyleSet.handler, {
    body: createStyleSet.config.body,
    permissions: createStyleSet.config.permissions,
  })
  .get("/editor/stella", readStellaStyleEditor.handler, {
    permissions: readStellaStyleEditor.config.permissions,
  })
  .put("/editor", createStyleSetFromEditor.handler, {
    body: createStyleSetFromEditor.config.body,
    permissions: createStyleSetFromEditor.config.permissions,
  })
  .get("/:styleSetId/download", downloadStyleSet.handler, {
    params: downloadStyleSet.config.params,
    permissions: downloadStyleSet.config.permissions,
  })
  .post("/:styleSetId", updateStyleSet.handler, {
    body: updateStyleSet.config.body,
    params: updateStyleSet.config.params,
    permissions: updateStyleSet.config.permissions,
  })
  .post("/:styleSetId/source", replaceStyleSet.handler, {
    body: replaceStyleSet.config.body,
    params: replaceStyleSet.config.params,
    permissions: replaceStyleSet.config.permissions,
  })
  .get("/:styleSetId/editor", readStyleSetEditor.handler, {
    params: readStyleSetEditor.config.params,
    permissions: readStyleSetEditor.config.permissions,
  })
  .post("/:styleSetId/editor", updateStyleSetFromEditor.handler, {
    body: updateStyleSetFromEditor.config.body,
    params: updateStyleSetFromEditor.config.params,
    permissions: updateStyleSetFromEditor.config.permissions,
  })
  .delete("/:styleSetId", deleteStyleSet.handler, {
    params: deleteStyleSet.config.params,
    permissions: deleteStyleSet.config.permissions,
  });
