import Elysia from "elysia";

import myWork from "@/api/handlers/work-obligations/queues/list";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const myWorkRoute = new Elysia({ prefix: "/my-work" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", myWork.handler, {
    query: myWork.config.query,
    permissions: myWork.config.permissions,
  });
