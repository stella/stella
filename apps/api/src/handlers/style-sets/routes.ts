import Elysia from "elysia";
import { rateLimit } from "elysia-rate-limit";

import createStyleSet from "@/api/handlers/style-sets/create";
import deleteStyleSet from "@/api/handlers/style-sets/delete";
import downloadStyleSet from "@/api/handlers/style-sets/download";
import listStyleSets from "@/api/handlers/style-sets/list";
import replaceStyleSet from "@/api/handlers/style-sets/replace";
import updateStyleSet from "@/api/handlers/style-sets/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import {
  InMemoryRateLimitContext,
  scopedGenerator,
} from "@/api/lib/rate-limit/rate-limit";

export const styleSetsRoute = new Elysia({ prefix: "/style-sets" })
  .use(authMacro)
  .use(permissionMacro)
  .use(
    rateLimit({
      scoping: "scoped",
      duration: API_RATE_LIMITS.upload.duration,
      max: API_RATE_LIMITS.upload.max,
      generator: scopedGenerator("style-set-upload"),
      context: new InMemoryRateLimitContext(),
      skip: (request) => {
        const { pathname } = new URL(request.url);
        return !(
          request.method === "PUT" ||
          (request.method === "POST" && pathname.endsWith("/source"))
        );
      },
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
  .delete("/:styleSetId", deleteStyleSet.handler, {
    params: deleteStyleSet.config.params,
    permissions: deleteStyleSet.config.permissions,
  });
