import updateCellMetadata from "@/api/handlers/fields/cell-metadata/update";
import markColumnFlag from "@/api/handlers/fields/column-flag/update";
import updateKanbanPlacement from "@/api/handlers/fields/kanban-placement/update";
import upsertField from "@/api/handlers/fields/upsert";
import { routes } from "@/api/http/route";

export const fieldsRoute = routes(
  {
    "/": { POST: upsertField },
    "/kanban-placement": { PATCH: updateKanbanPlacement },
    "/metadata": { PATCH: updateCellMetadata },
    "/metadata-batch": { PATCH: markColumnFlag },
  },
  { prefix: "/fields/:workspaceId" },
);
