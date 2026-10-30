import readLegislation from "@/api/handlers/legislation/get";
import searchLegislation from "@/api/handlers/legislation/search";
import { routes } from "@/api/http/route";

/**
 * Corpus-legislation routes (ingested statutes searchable via the
 * corpus index/pg-fts substrate). Namespaced under /legislation/corpus to
 * avoid colliding with the existing BOE proxy routes in routes.ts.
 */

export const legislationCorpusRoute = routes(
  {
    "/search": { POST: searchLegislation },
    "/:documentId": { GET: readLegislation },
  },
  { prefix: "/legislation/corpus" },
);
