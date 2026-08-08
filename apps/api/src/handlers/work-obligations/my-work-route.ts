import Elysia from "elysia";

import { env } from "@/api/env";
import myWork from "@/api/handlers/work-obligations/queues/list";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const myWorkRoute = new Elysia({ prefix: "/my-work" })
  .use(deploymentFeatureGate(env.isDev || env.FEATURE_GOVERNED_WORKFLOW))
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", myWork.handler, {
    query: myWork.config.query,
    permissions: myWork.config.permissions,
  });
