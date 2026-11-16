import requestOrganizationAuditArchive from "@/api/handlers/organizations/audit-export/create";
import latestOrganizationAuditExport from "@/api/handlers/organizations/audit-export/get";
import createOrganization from "@/api/handlers/organizations/create";
import { organizationCreateBudget } from "@/api/handlers/organizations/rate-limit";
import updateSlug from "@/api/handlers/organizations/slug/update";
import { mount, routes } from "@/api/http/route";
import { organizationSlugBudget } from "@/api/lib/rate-limit/organization-slug";

export const organizationsRoute = mount(
  [
    routes(
      { "/": { POST: createOrganization } },
      { middleware: [organizationCreateBudget] },
    ),
    routes(
      { "/slug": { POST: updateSlug } },
      { middleware: [organizationSlugBudget] },
    ),
    routes({
      "/audit-export": {
        GET: latestOrganizationAuditExport,
        POST: requestOrganizationAuditArchive,
      },
    }),
  ],
  { prefix: "/organizations" },
);
