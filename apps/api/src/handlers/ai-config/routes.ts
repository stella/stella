import validateProvider from "@/api/handlers/ai-config/validate-provider";
import { routes } from "@/api/http/route";

export const aiConfigPublicRoute = routes(
  {
    "/validate-provider": { POST: validateProvider },
  },
  { prefix: "/ai-config" },
);
