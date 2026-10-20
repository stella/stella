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
  .get(
    "/",
    {
      permissions: listStyleSets.config.permissions,
      query: listStyleSets.config.query,
    },
    listStyleSets.handler,
  )
  .put(
    "/",
    {
      body: createStyleSet.config.body,
      permissions: createStyleSet.config.permissions,
    },
    createStyleSet.handler,
  )
  .get(
    "/editor/stella",
    {
      permissions: readStellaStyleEditor.config.permissions,
    },
    readStellaStyleEditor.handler,
  )
  .post(
    "/editor/preview",
    {
      body: previewStyleSetFromEditor.config.body,
      permissions: previewStyleSetFromEditor.config.permissions,
    },
    previewStyleSetFromEditor.handler,
  )
  .put(
    "/editor",
    {
      body: createStyleSetFromEditor.config.body,
      permissions: createStyleSetFromEditor.config.permissions,
    },
    createStyleSetFromEditor.handler,
  )
  .get(
    "/:styleSetId/download",
    {
      params: downloadStyleSet.config.params,
      permissions: downloadStyleSet.config.permissions,
    },
    downloadStyleSet.handler,
  )
  .post(
    "/:styleSetId",
    {
      body: updateStyleSet.config.body,
      params: updateStyleSet.config.params,
      permissions: updateStyleSet.config.permissions,
    },
    updateStyleSet.handler,
  )
  .post(
    "/:styleSetId/source",
    {
      body: replaceStyleSet.config.body,
      params: replaceStyleSet.config.params,
      permissions: replaceStyleSet.config.permissions,
    },
    replaceStyleSet.handler,
  )
  .get(
    "/:styleSetId/editor",
    {
      params: readStyleSetEditor.config.params,
      permissions: readStyleSetEditor.config.permissions,
    },
    readStyleSetEditor.handler,
  )
  .post(
    "/:styleSetId/editor",
    {
      body: updateStyleSetFromEditor.config.body,
      params: updateStyleSetFromEditor.config.params,
      permissions: updateStyleSetFromEditor.config.permissions,
    },
    updateStyleSetFromEditor.handler,
  )
  .delete(
    "/:styleSetId",
    {
      params: deleteStyleSet.config.params,
      permissions: deleteStyleSet.config.permissions,
    },
    deleteStyleSet.handler,
  );
