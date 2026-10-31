import createOrganization from "@/api/handlers/organizations/create";
import { organizationCreateBudget } from "@/api/handlers/organizations/rate-limit";
import { mount, routes } from "@/api/http/route";

export const organizationsRoute = mount(
  [
    routes(
      { "/": { POST: createOrganization } },
      { middleware: [organizationCreateBudget] },
    ),
  ],
  { prefix: "/organizations" },
);
