import Elysia from "elysia";

import createViewTemplate from "@/api/handlers/view-templates/create";
import deleteViewTemplate from "@/api/handlers/view-templates/delete";
import listViewTemplates from "@/api/handlers/view-templates/list";
import { workspaceAccessMacro } from "@/api/lib/auth";

export const viewTemplatesRoute = new Elysia({
  prefix: "/view-templates/:workspaceId",
})
  .use(workspaceAccessMacro)
  .guard({ validateWorkspaceAccess: true })
  .get("/", listViewTemplates.handler)
  .put(
    "/",
    {
      body: createViewTemplate.config.body,
    },
    createViewTemplate.handler,
  )
  .delete(
    "/:templateId",
    {
      params: deleteViewTemplate.config.params,
    },
    deleteViewTemplate.handler,
  );
