import Elysia from "elysia";

import {
  handleValidateProvider,
  validateProviderBody,
} from "@/api/handlers/ai-config/validate-provider";

export const aiConfigPublicRoute = new Elysia({ prefix: "/ai-config" }).post(
  "/validate-provider",
  async ({ body, request }) => await handleValidateProvider({ body, request }),
  { body: validateProviderBody },
);
