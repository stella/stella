import Elysia from "elysia";

import approvePlaybookDefinition from "@/api/handlers/playbooks/approve";
import createPlaybookDefinition from "@/api/handlers/playbooks/create";
import deletePlaybookDefinition from "@/api/handlers/playbooks/delete";
import createPlaybookFromRun from "@/api/handlers/playbooks/from-run/create";
import createPlaybookFromStarter from "@/api/handlers/playbooks/from-starter/create";
import getPlaybookDefinition from "@/api/handlers/playbooks/get";
import listPlaybookDefinitions from "@/api/handlers/playbooks/list";
import listRecentPlaybooks from "@/api/handlers/playbooks/recent/list";
import listStarterPlaybooks from "@/api/handlers/playbooks/starters/list";
import updatePlaybookDefinition from "@/api/handlers/playbooks/update";
import listPlaybookVersions from "@/api/handlers/playbooks/versions/list";
import restorePlaybookVersion from "@/api/handlers/playbooks/versions/restore";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const playbooksRoute = new Elysia({
  prefix: "/playbooks",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listPlaybookDefinitions.handler, {
    permissions: listPlaybookDefinitions.config.permissions,
    accountAccess: listPlaybookDefinitions.config.accountAccess,
    query: listPlaybookDefinitions.config.query,
  })
  .post("/", createPlaybookDefinition.handler, {
    body: createPlaybookDefinition.config.body,
    permissions: createPlaybookDefinition.config.permissions,
    accountAccess: createPlaybookDefinition.config.accountAccess,
  })
  // Registered ahead of the `:playbookId` param routes so static paths are
  // never swallowed by the dynamic segment.
  .get("/starters", listStarterPlaybooks.handler, {
    permissions: listStarterPlaybooks.config.permissions,
    accountAccess: listStarterPlaybooks.config.accountAccess,
  })
  .get("/recent", listRecentPlaybooks.handler, {
    permissions: listRecentPlaybooks.config.permissions,
    accountAccess: listRecentPlaybooks.config.accountAccess,
    query: listRecentPlaybooks.config.query,
  })
  .post("/from-starter", createPlaybookFromStarter.handler, {
    body: createPlaybookFromStarter.config.body,
    permissions: createPlaybookFromStarter.config.permissions,
    accountAccess: createPlaybookFromStarter.config.accountAccess,
  })
  .post("/from-run", createPlaybookFromRun.handler, {
    body: createPlaybookFromRun.config.body,
    permissions: createPlaybookFromRun.config.permissions,
    accountAccess: createPlaybookFromRun.config.accountAccess,
  })
  .get("/:playbookId", getPlaybookDefinition.handler, {
    params: getPlaybookDefinition.config.params,
    permissions: getPlaybookDefinition.config.permissions,
    accountAccess: getPlaybookDefinition.config.accountAccess,
  })
  .put("/:playbookId", updatePlaybookDefinition.handler, {
    body: updatePlaybookDefinition.config.body,
    params: updatePlaybookDefinition.config.params,
    permissions: updatePlaybookDefinition.config.permissions,
    accountAccess: updatePlaybookDefinition.config.accountAccess,
  })
  .delete("/:playbookId", deletePlaybookDefinition.handler, {
    params: deletePlaybookDefinition.config.params,
    permissions: deletePlaybookDefinition.config.permissions,
    accountAccess: deletePlaybookDefinition.config.accountAccess,
  })
  .post("/:playbookId/approve", approvePlaybookDefinition.handler, {
    body: approvePlaybookDefinition.config.body,
    params: approvePlaybookDefinition.config.params,
    permissions: approvePlaybookDefinition.config.permissions,
    accountAccess: approvePlaybookDefinition.config.accountAccess,
  })
  .get("/:playbookId/versions", listPlaybookVersions.handler, {
    params: listPlaybookVersions.config.params,
    query: listPlaybookVersions.config.query,
    permissions: listPlaybookVersions.config.permissions,
    accountAccess: listPlaybookVersions.config.accountAccess,
  })
  .post(
    "/:playbookId/versions/:version/restore",
    restorePlaybookVersion.handler,
    {
      params: restorePlaybookVersion.config.params,
      permissions: restorePlaybookVersion.config.permissions,
      accountAccess: restorePlaybookVersion.config.accountAccess,
    },
  );
