import Elysia from "elysia";

import boeLawStructure from "@/api/handlers/legislation/boe/law-structure/get";
import boeGetLaw from "@/api/handlers/legislation/boe/laws/get";
import boeRelatedLaws from "@/api/handlers/legislation/boe/related-laws/list";
import boeSearch from "@/api/handlers/legislation/boe/search";
import boeTextBlock from "@/api/handlers/legislation/boe/text-block/get";
import bormeSummary from "@/api/handlers/legislation/borme/summary/get";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const legislationRoute = new Elysia({ prefix: "/legislation" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({
    validateAuth: true,
  })
  .get(
    "/search",
    {
      query: boeSearch.config.query,
    },
    boeSearch.handler,
  )
  .get(
    "/laws/:lawId",
    {
      params: boeGetLaw.config.params,
      query: boeGetLaw.config.query,
    },
    boeGetLaw.handler,
  )
  .get(
    "/laws/:lawId/structure",
    {
      params: boeLawStructure.config.params,
    },
    boeLawStructure.handler,
  )
  .get(
    "/laws/:lawId/blocks/:blockId",
    {
      params: boeTextBlock.config.params,
    },
    boeTextBlock.handler,
  )
  .get(
    "/laws/:lawId/related",
    {
      params: boeRelatedLaws.config.params,
      query: boeRelatedLaws.config.query,
    },
    boeRelatedLaws.handler,
  )
  .get(
    "/borme/:date",
    {
      params: bormeSummary.config.params,
    },
    bormeSummary.handler,
  );
