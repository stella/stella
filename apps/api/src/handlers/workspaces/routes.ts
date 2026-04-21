import Elysia, { t } from "elysia";

import archiveWorkspace from "@/api/handlers/workspaces/archive";
import createWorkspaces from "@/api/handlers/workspaces/create";
import deleteWorkspace from "@/api/handlers/workspaces/delete-by-id";
import generateBoundingBoxes from "@/api/handlers/workspaces/generate-bounding-boxes";
import readWorkspaces from "@/api/handlers/workspaces/read";
import readActiveWorkspace from "@/api/handlers/workspaces/read-active";
import { readWorkspaceHandler } from "@/api/handlers/workspaces/read-by-id";
import { readJustificationsHandler } from "@/api/handlers/workspaces/read-justifications";
import readWorkspaceNavigation from "@/api/handlers/workspaces/read-navigation";
import { readOverviewHandler } from "@/api/handlers/workspaces/read-overview";
import { readWorkflowHandler } from "@/api/handlers/workspaces/read-workflow-status";
import unarchiveWorkspace from "@/api/handlers/workspaces/unarchive";
import updateActiveWorkspace from "@/api/handlers/workspaces/update-active";
import updateWorkspace from "@/api/handlers/workspaces/update-by-id";
import workflowStart from "@/api/handlers/workspaces/workflow-start";
import createWorkspaceContact from "@/api/handlers/workspaces/workspace-contacts-create";
import deleteWorkspaceContact from "@/api/handlers/workspaces/workspace-contacts-delete";
import { readWorkspaceContactsHandler } from "@/api/handlers/workspaces/workspace-contacts-read";
import addWorkspaceMember from "@/api/handlers/workspaces/workspace-members-add";
import { readWorkspaceMembersHandler } from "@/api/handlers/workspaces/workspace-members-read";
import removeWorkspaceMember from "@/api/handlers/workspaces/workspace-members-remove";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { tUuid } from "@/api/lib/custom-schema";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";
import { LIMITS } from "@/api/lib/limits";

export const workspacesRoute = new Elysia({ prefix: "/workspaces" })
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .use(permissionMacro)
  .guard({
    validateAuth: true,
  })
  .get("/", readWorkspaces.handler)
  .get("/navigation", readWorkspaceNavigation.handler)
  .put("/", createWorkspaces.handler, {
    body: createWorkspaces.config.body,
    invalidateQuery: true,
  })
  .get("/active", readActiveWorkspace.handler)
  .group(
    "/:workspaceId",
    {
      validateWorkspaceAccess: true,
    },
    (app) =>
      app
        .get(
          "/",
          async (ctx) =>
            await readWorkspaceHandler({
              workspaceId: ctx.workspaceId,
              organizationId: ctx.session.activeOrganizationId,
              scopedDb: ctx.scopedDb,
            }),
        )
        .get(
          "/workflow",
          async (ctx) => await readWorkflowHandler(ctx.workspaceId),
        )
        .post("/workflow/start", workflowStart.handler, {
          body: workflowStart.config.body,
          permissions: workflowStart.config.permissions,
        })
        .post(
          "/justifications/query",
          async (ctx) =>
            await readJustificationsHandler({
              workspaceId: ctx.workspaceId,
              scopedDb: ctx.scopedDb,
              entityIds: ctx.body.entityIds,
            }),
          {
            body: t.Object({
              entityIds: t.Array(tUuid, {
                minItems: 1,
                maxItems: LIMITS.entitiesPageSizeMax,
              }),
            }),
          },
        )
        .post("/bounding-boxes", generateBoundingBoxes.handler, {
          body: generateBoundingBoxes.config.body,
          invalidateQuery: true,
        })
        .get(
          "/overview",
          async (ctx) =>
            await readOverviewHandler({
              workspaceId: ctx.workspaceId,
              scopedDb: ctx.scopedDb,
            }),
        )
        .post("/", updateWorkspace.handler, {
          body: updateWorkspace.config.body,
          invalidateQuery: true,
        })
        .post("/active", updateActiveWorkspace.handler)
        .delete("/", deleteWorkspace.handler, {
          invalidateQuery: true,
        })
        .post("/archive", archiveWorkspace.handler, {
          permissions: archiveWorkspace.config.permissions,
          invalidateQuery: true,
        })
        // Unarchive is mounted below, outside the active-only group.
        .get(
          "/contacts",
          async (ctx) =>
            await readWorkspaceContactsHandler({
              workspaceId: ctx.workspaceId,
              scopedDb: ctx.scopedDb,
            }),
        )
        .put("/contacts", createWorkspaceContact.handler, {
          body: createWorkspaceContact.config.body,
          invalidateQuery: true,
        })
        .delete(
          "/contacts/:workspaceContactId",
          deleteWorkspaceContact.handler,
          {
            params: deleteWorkspaceContact.config.params,
            invalidateQuery: true,
          },
        )
        .get(
          "/members",
          async (ctx) =>
            await readWorkspaceMembersHandler({
              workspaceId: ctx.workspaceId,
              scopedDb: ctx.scopedDb,
            }),
        )
        .put("/members", addWorkspaceMember.handler, {
          body: addWorkspaceMember.config.body,
          invalidateQuery: true,
        })
        .delete("/members/:userId", removeWorkspaceMember.handler, {
          params: removeWorkspaceMember.config.params,
          invalidateQuery: true,
        }),
  )
  .post("/:workspaceId/unarchive", unarchiveWorkspace.handler, {
    validateWorkspaceAccessIncludingArchived: true,
    permissions: unarchiveWorkspace.config.permissions,
    invalidateQuery: true,
  });
