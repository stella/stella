import prepareDocumentTranslation from "@/api/handlers/document-translations/prepare";
import createDocumentTranslationRun from "@/api/handlers/document-translations/runs/create";
import readDocumentTranslationRun from "@/api/handlers/document-translations/runs/get";
import { mount, routes } from "@/api/http/route";
import { translateBudget } from "@/api/lib/rate-limit/dedicated-budgets";

export const documentTranslationsRoute = mount(
  [
    routes({
      "/prepare": { POST: prepareDocumentTranslation },
      "/runs/:runId": { GET: readDocumentTranslationRun },
    }),
    // Starting a run spends the organisation's paid translation quota.
    routes(
      { "/runs": { POST: createDocumentTranslationRun } },
      { middleware: [translateBudget] },
    ),
  ],
  { prefix: "/workspaces/:workspaceId/document-translations" },
);
