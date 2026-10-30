import { organizationSlugBudget } from "@/api/handlers/organizations/slug/rate-limit";
import updateSlug from "@/api/handlers/organizations/slug/update";
import { routes } from "@/api/http/route";

export const organizationsRoute = routes(
  {
    "/slug": { POST: updateSlug },
  },
  { prefix: "/organizations", middleware: [organizationSlugBudget] },
);
