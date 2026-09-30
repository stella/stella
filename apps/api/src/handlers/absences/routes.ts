import Elysia from "elysia";

import { authMacro, permissionMacro } from "@/api/lib/auth";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import approvalQueue from "./approval-queue/list";
import approve from "./approve";
import cancel from "./cancel";
import mine from "./mine/list";
import reject from "./reject";
import request from "./request";

export const absencesRoute = new Elysia({ prefix: "/v1/absences" })
  .use(rateLimit(createStandardApiRateLimitOptions()))
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .post("/", request.handler, {
    body: request.config.body,
    permissions: request.config.permissions,
  })
  .get("/mine", mine.handler, {
    query: mine.config.query,
    permissions: mine.config.permissions,
  })
  .get("/approval-queue", approvalQueue.handler, {
    query: approvalQueue.config.query,
    permissions: approvalQueue.config.permissions,
  })
  .post("/:id/approve", approve.handler, {
    params: approve.config.params,
    body: approve.config.body,
    permissions: approve.config.permissions,
  })
  .post("/:id/reject", reject.handler, {
    params: reject.config.params,
    body: reject.config.body,
    permissions: reject.config.permissions,
  })
  .post("/:id/cancel", cancel.handler, {
    params: cancel.config.params,
    body: cancel.config.body,
    permissions: cancel.config.permissions,
  });
