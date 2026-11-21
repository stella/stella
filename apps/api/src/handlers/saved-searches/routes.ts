import createSavedSearch from "@/api/handlers/saved-searches/create";
import deleteSavedSearch from "@/api/handlers/saved-searches/delete";
import getSavedSearch from "@/api/handlers/saved-searches/get";
import listSavedSearches from "@/api/handlers/saved-searches/list";
import updateSavedSearch from "@/api/handlers/saved-searches/update";
import { routes } from "@/api/http/route";

export const savedSearchesRoute = routes(
  {
    "/": { GET: listSavedSearches, POST: createSavedSearch },
    "/:savedSearchId": {
      GET: getSavedSearch,
      PATCH: updateSavedSearch,
      DELETE: deleteSavedSearch,
    },
  },
  { prefix: "/saved-searches" },
);
