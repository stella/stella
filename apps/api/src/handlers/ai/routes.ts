import Elysia from "elysia";

import draftEmail from "@/api/handlers/ai/draft-email";
import summarizeEmail from "@/api/handlers/ai/summarize";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const aiRoute = new Elysia({ prefix: "/ai" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .post("/summarize", summarizeEmail.handler, {
    body: summarizeEmail.config.body,
    permissions: summarizeEmail.config.permissions,
  })
  .post("/draft-email", draftEmail.handler, {
    body: draftEmail.config.body,
    permissions: draftEmail.config.permissions,
  });
