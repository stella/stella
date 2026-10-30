import compareDocumentVersions from "@/api/handlers/documents/compare";
import { routes } from "@/api/http/route";

export const documentsRoute = routes(
  {
    "/document/:documentId/compare": { POST: compareDocumentVersions },
  },
  { prefix: "/documents/:workspaceId" },
);
