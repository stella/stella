import readLegislation from "@/api/handlers/legislation/get";
import createMatterLinksBatch from "@/api/handlers/legislation/matter-links/batch/create";
import createMatterLink from "@/api/handlers/legislation/matter-links/create";
import deleteMatterLink from "@/api/handlers/legislation/matter-links/delete";
import listMatterLinks from "@/api/handlers/legislation/matter-links/list";
import searchLegislation from "@/api/handlers/legislation/search";
import { mount, routes } from "@/api/http/route";

/**
 * Corpus-legislation routes (ingested statutes searchable via the
 * corpus index/pg-fts substrate). Namespaced under /legislation/corpus to
 * avoid colliding with the existing BOE proxy routes in routes.ts.
 */

const corpusRoute = routes(
  {
    "/search": { POST: searchLegislation },
    "/:documentId": { GET: readLegislation },
  },
  { prefix: "/legislation/corpus" },
);

const matterLinksRoute = routes(
  {
    "/": { GET: listMatterLinks, POST: createMatterLink },
    "/batch": { POST: createMatterLinksBatch },
    "/:linkId": { DELETE: deleteMatterLink },
  },
  { prefix: "/legislation/matter-links/:workspaceId" },
);

export const legislationCorpusRoute = mount([corpusRoute, matterLinksRoute]);
