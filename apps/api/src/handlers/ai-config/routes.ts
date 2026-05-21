import Elysia from "elysia";

import validateProvider from "@/api/handlers/ai-config/validate-provider";
import { sessionAuthMacro } from "@/api/lib/auth";

export const aiConfigPublicRoute = new Elysia({ prefix: "/ai-config" })
  .use(sessionAuthMacro)
  .guard({ validateSession: true })
  .post("/validate-provider", validateProvider.handler, {
    body: validateProvider.config.body,
  });
