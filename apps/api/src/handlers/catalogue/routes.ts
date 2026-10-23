import installBundledSkill from "@/api/handlers/catalogue/install";
import listCatalogue from "@/api/handlers/catalogue/list";
import nativeToolDeployAvailability from "@/api/handlers/catalogue/native-tool-deploy-availability";
import { mount, routes } from "@/api/http/route";

const sessionCatalogueRoute = routes(
  {
    "/native-tool-deploy-availability": { GET: nativeToolDeployAvailability },
  },
  { prefix: "/catalogue" },
);

const authenticatedCatalogueRoute = routes(
  {
    "/": { GET: listCatalogue },
    "/install-skill": { POST: installBundledSkill },
  },
  { prefix: "/catalogue" },
);

export const catalogueRoute = mount([
  sessionCatalogueRoute,
  authenticatedCatalogueRoute,
]);
