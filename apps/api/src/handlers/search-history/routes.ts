import clearSearchHistory from "@/api/handlers/search-history/clear";
import deleteSearchHistoryEntry from "@/api/handlers/search-history/delete";
import importSearchHistory from "@/api/handlers/search-history/import";
import importClock from "@/api/handlers/search-history/import-clock";
import listSearchHistory from "@/api/handlers/search-history/list";
import upsertSearchHistory from "@/api/handlers/search-history/upsert";
import { routes } from "@/api/http/route";

export const searchHistoryRoute = routes(
  {
    "/": {
      GET: listSearchHistory,
      POST: upsertSearchHistory,
      DELETE: clearSearchHistory,
    },
    "/import-clock": { GET: importClock },
    "/import": { POST: importSearchHistory },
    "/:entryId": { DELETE: deleteSearchHistoryEntry },
  },
  { prefix: "/search-history" },
);
