import updateSlug from "@/api/handlers/organizations/slug/update";
import { mount, routes } from "@/api/http/route";
import { organizationSlugBudget } from "@/api/lib/rate-limit/organization-slug";

export const organizationsRoute = mount(
  [
    routes(
      { "/slug": { POST: updateSlug } },
      { middleware: [organizationSlugBudget] },
    ),
  ],
  { prefix: "/organizations" },
);
