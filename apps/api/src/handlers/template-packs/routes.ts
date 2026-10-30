import getTemplatePack from "@/api/handlers/template-packs/get";
import installTemplatePack from "@/api/handlers/template-packs/installs/create";
import listTemplatePacks from "@/api/handlers/template-packs/list";
import updateTemplatePackVisibility from "@/api/handlers/template-packs/visibility/update";
import { routes } from "@/api/http/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

// A deployment that does not offer bundled packs has no such routes at all,
// like the public-law routes.
export const templatePacksRoute = routes(
  {
    "/": { GET: listTemplatePacks },
    "/visibility": { POST: updateTemplatePackVisibility },
    "/:packId": { GET: getTemplatePack },
    "/:packId/install": { POST: installTemplatePack },
  },
  {
    prefix: "/template-packs",
    middleware: [deploymentFeatureGate("FEATURE_TEMPLATE_PACKS")],
  },
);
