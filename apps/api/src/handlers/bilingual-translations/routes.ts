import createBilingualRun from "@/api/handlers/bilingual-translations/create-run";
import prepareBilingualTranslation from "@/api/handlers/bilingual-translations/prepare";
import readBilingualRun from "@/api/handlers/bilingual-translations/read-run";
import { routes } from "@/api/http/route";

export const bilingualTranslationsRoute = routes(
  {
    "/prepare": { POST: prepareBilingualTranslation },
    "/runs": { POST: createBilingualRun },
    "/runs/:runId": { GET: readBilingualRun },
  },
  { prefix: "/workspaces/:workspaceId/bilingual-translations" },
);
