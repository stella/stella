import Elysia from "elysia";

import boeGetLaw from "@/api/handlers/legislation/boe-get-law";
import boeLawStructure from "@/api/handlers/legislation/boe-law-structure";
import boeRelatedLaws from "@/api/handlers/legislation/boe-related-laws";
import boeSearch from "@/api/handlers/legislation/boe-search";
import boeTextBlock from "@/api/handlers/legislation/boe-text-block";
import bormeSummary from "@/api/handlers/legislation/borme-summary";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const legislationRoute = new Elysia({ prefix: "/legislation" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({
    validateAuth: true,
  })
  .get("/search", boeSearch.handler, {
    query: boeSearch.config.query,
  })
  .get("/laws/:lawId", boeGetLaw.handler, {
    params: boeGetLaw.config.params,
    query: boeGetLaw.config.query,
  })
  .get("/laws/:lawId/structure", boeLawStructure.handler, {
    params: boeLawStructure.config.params,
  })
  .get("/laws/:lawId/blocks/:blockId", boeTextBlock.handler, {
    params: boeTextBlock.config.params,
  })
  .get("/laws/:lawId/related", boeRelatedLaws.handler, {
    params: boeRelatedLaws.config.params,
    query: boeRelatedLaws.config.query,
  })
  .get("/borme/:date", bormeSummary.handler, {
    params: bormeSummary.config.params,
  });
