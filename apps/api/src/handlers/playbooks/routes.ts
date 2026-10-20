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
  .get(
    "/",
    {
      permissions: listPlaybookDefinitions.config.permissions,
      query: listPlaybookDefinitions.config.query,
    },
    listPlaybookDefinitions.handler,
  )
  .post(
    "/",
    {
      body: createPlaybookDefinition.config.body,
      permissions: createPlaybookDefinition.config.permissions,
    },
    createPlaybookDefinition.handler,
  )
  // Registered ahead of the `:playbookId` param routes so static paths are
  // never swallowed by the dynamic segment.
  .get(
    "/starters",
    {
      permissions: listStarterPlaybooks.config.permissions,
    },
    listStarterPlaybooks.handler,
  )
  .get(
    "/recent",
    {
      permissions: listRecentPlaybooks.config.permissions,
      query: listRecentPlaybooks.config.query,
    },
    listRecentPlaybooks.handler,
  )
  .post(
    "/from-starter",
    {
      body: createPlaybookFromStarter.config.body,
      permissions: createPlaybookFromStarter.config.permissions,
    },
    createPlaybookFromStarter.handler,
  )
  .post(
    "/from-run",
    {
      body: createPlaybookFromRun.config.body,
      permissions: createPlaybookFromRun.config.permissions,
    },
    createPlaybookFromRun.handler,
  )
  .get(
    "/:playbookId",
    {
      params: getPlaybookDefinition.config.params,
      permissions: getPlaybookDefinition.config.permissions,
    },
    getPlaybookDefinition.handler,
  )
  .put(
    "/:playbookId",
    {
      body: updatePlaybookDefinition.config.body,
      params: updatePlaybookDefinition.config.params,
      permissions: updatePlaybookDefinition.config.permissions,
    },
    updatePlaybookDefinition.handler,
  )
  .delete(
    "/:playbookId",
    {
      params: deletePlaybookDefinition.config.params,
      permissions: deletePlaybookDefinition.config.permissions,
    },
    deletePlaybookDefinition.handler,
  )
  .post(
    "/:playbookId/approve",
    {
      body: approvePlaybookDefinition.config.body,
      params: approvePlaybookDefinition.config.params,
      permissions: approvePlaybookDefinition.config.permissions,
    },
    approvePlaybookDefinition.handler,
  )
  .get(
    "/:playbookId/versions",
    {
      params: listPlaybookVersions.config.params,
      query: listPlaybookVersions.config.query,
      permissions: listPlaybookVersions.config.permissions,
    },
    listPlaybookVersions.handler,
  )
  .post(
    "/:playbookId/versions/:version/restore",
    {
      params: restorePlaybookVersion.config.params,
      permissions: restorePlaybookVersion.config.permissions,
    },
    restorePlaybookVersion.handler,
  );
