import boeLawStructure from "@/api/handlers/legislation/boe/law-structure/get";
import boeGetLaw from "@/api/handlers/legislation/boe/laws/get";
import boeRelatedLaws from "@/api/handlers/legislation/boe/related-laws/list";
import boeSearch from "@/api/handlers/legislation/boe/search";
import boeTextBlock from "@/api/handlers/legislation/boe/text-block/get";
import bormeSummary from "@/api/handlers/legislation/borme/summary/get";
import { routes } from "@/api/http/route";

export const legislationRoute = routes(
  {
    "/search": { GET: boeSearch },
    "/laws/:lawId": { GET: boeGetLaw },
    "/laws/:lawId/structure": { GET: boeLawStructure },
    "/laws/:lawId/blocks/:blockId": { GET: boeTextBlock },
    "/laws/:lawId/related": { GET: boeRelatedLaws },
    "/borme/:date": { GET: bormeSummary },
  },
  { prefix: "/legislation" },
);
