import createDocumentType from "@/api/handlers/document-types/create";
import deleteDocumentType from "@/api/handlers/document-types/delete";
import listDocumentTypes from "@/api/handlers/document-types/list";
import reorderDocumentTypes from "@/api/handlers/document-types/reorder";
import updateDocumentType from "@/api/handlers/document-types/update";
import { routes } from "@/api/http/route";

export const documentTypesRoute = routes(
  {
    "/": { GET: listDocumentTypes, POST: createDocumentType },
    "/reorder": { POST: reorderDocumentTypes },
    "/:documentTypeId": {
      PATCH: updateDocumentType,
      DELETE: deleteDocumentType,
    },
  },
  { prefix: "/document-types" },
);
