import Elysia from "elysia";

import createPlaybookDefinition from "@/api/handlers/playbooks/create";
import deletePlaybookDefinition from "@/api/handlers/playbooks/delete-by-id";
import getPlaybookDefinition from "@/api/handlers/playbooks/read-by-id";
import listPlaybookDefinitions from "@/api/handlers/playbooks/read-list";
import updatePlaybookDefinition from "@/api/handlers/playbooks/update-by-id";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const playbooksRoute = new Elysia({
  prefix: "/playbooks",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listPlaybookDefinitions.handler, {
    permissions: listPlaybookDefinitions.config.permissions,
    query: listPlaybookDefinitions.config.query,
  })
  .post("/", createPlaybookDefinition.handler, {
    body: createPlaybookDefinition.config.body,
    permissions: createPlaybookDefinition.config.permissions,
  })
  .get("/:playbookId", getPlaybookDefinition.handler, {
    params: getPlaybookDefinition.config.params,
    permissions: getPlaybookDefinition.config.permissions,
  })
  .put("/:playbookId", updatePlaybookDefinition.handler, {
    body: updatePlaybookDefinition.config.body,
    params: updatePlaybookDefinition.config.params,
    permissions: updatePlaybookDefinition.config.permissions,
  })
  .delete("/:playbookId", deletePlaybookDefinition.handler, {
    params: deletePlaybookDefinition.config.params,
    permissions: deletePlaybookDefinition.config.permissions,
  });
