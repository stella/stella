import lookupResearchAnswers from "@/api/handlers/case-law/research/answers-lookup";
import runResearchAnswers from "@/api/handlers/case-law/research/answers-run";
import createResearchColumn from "@/api/handlers/case-law/research/columns-create";
import deleteResearchColumn from "@/api/handlers/case-law/research/columns-delete";
import listResearchColumns from "@/api/handlers/case-law/research/columns-list";
import reorderResearchColumns from "@/api/handlers/case-law/research/columns-reorder";
import suggestResearchColumnPrompt from "@/api/handlers/case-law/research/columns-suggest-prompt";
import updateResearchColumn from "@/api/handlers/case-law/research/columns-update";
import { routes } from "@/api/http/route";

/**
 * Organization-scoped. Question columns and their answers belong to the
 * organization: one answer serves every search that surfaces the decision.
 */
export const caseLawResearchRoute = routes(
  {
    "/columns": { GET: listResearchColumns, POST: createResearchColumn },
    "/columns/order": { PUT: reorderResearchColumns },
    "/columns/suggest-prompt": { POST: suggestResearchColumnPrompt },
    "/columns/:columnId": {
      PATCH: updateResearchColumn,
      DELETE: deleteResearchColumn,
    },
    "/answers/lookup": { POST: lookupResearchAnswers },
    "/answers/run": { POST: runResearchAnswers },
  },
  { prefix: "/case/research" },
);
