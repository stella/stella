import readSoftLaw from "@/api/handlers/soft-law/get";
import searchSoftLaw from "@/api/handlers/soft-law/search";
import { routes } from "@/api/http/route";

/** Signed-in reads of served regulator guidance. There is no anonymous route. */
export const softLawRoute = routes(
  {
    "/search": { GET: searchSoftLaw },
    "/:documentId": { GET: readSoftLaw },
  },
  {
    prefix: "/soft-law",
    deployment: { type: "flag", flag: "FEATURE_PUBLIC_LAW" },
  },
);
