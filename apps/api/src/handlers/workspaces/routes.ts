import Elysia, { t } from "elysia";

import createWorkspaces from "@/api/handlers/workspaces/create";
import { deleteWorkspaceHandler } from "@/api/handlers/workspaces/delete-by-id";
import readWorkspaces from "@/api/handlers/workspaces/read";
import { readWorkspaceHandler } from "@/api/handlers/workspaces/read-by-id";
import { readJustificationsHandler } from "@/api/handlers/workspaces/read-justifications";
import readLastActiveWorkspace from "@/api/handlers/workspaces/read-last-active";
import { readOverviewHandler } from "@/api/handlers/workspaces/read-overview";
import { readWorkflowHandler } from "@/api/handlers/workspaces/read-workflow-status";
import {
  updateWorkspaceBodySchema,
  updateWorkspaceHandler,
} from "@/api/handlers/workspaces/update-by-id";
import { updateLastActiveWorkspaceHandler } from "@/api/handlers/workspaces/update-last-active";
import {
  createWorkspaceContactBodySchema,
  createWorkspaceContactHandler,
} from "@/api/handlers/workspaces/workspace-contacts-create";
import { deleteWorkspaceContactHandler } from "@/api/handlers/workspaces/workspace-contacts-delete";
import { readWorkspaceContactsHandler } from "@/api/handlers/workspaces/workspace-contacts-read";
import {
  addWorkspaceMemberBodySchema,
  addWorkspaceMemberHandler,
} from "@/api/handlers/workspaces/workspace-members-add";
import { readWorkspaceMembersHandler } from "@/api/handlers/workspaces/workspace-members-read";
import { removeWorkspaceMemberHandler } from "@/api/handlers/workspaces/workspace-members-remove";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { tNanoid } from "@/api/lib/custom-schema";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const workspacesRoute = new Elysia({ prefix: "/workspaces" })
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .use(permissionMacro)
  .guard({
    validateAuth: true,
  })
  .get("/", readWorkspaces.handler)
  .put("/", createWorkspaces.handler, {
    body: createWorkspaces.config.body,
    invalidateQuery: true,
  })
  .get("/last-active", readLastActiveWorkspace.handler)
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
          async (ctx) =>
            await readWorkflowHandler({
              workspaceId: ctx.workspaceId,
              organizationId: ctx.session.activeOrganizationId,
              authToken: ctx.session.token,
            }),
        )
        .get(
          "/justifications",
          async (ctx) =>
            await readJustificationsHandler({
              workspaceId: ctx.workspaceId,
              scopedDb: ctx.scopedDb,
            }),
        )
        .get(
          "/overview",
          async (ctx) =>
            await readOverviewHandler({
              workspaceId: ctx.workspaceId,
              scopedDb: ctx.scopedDb,
            }),
        )
        .post(
          "/",
          async (ctx) =>
            await updateWorkspaceHandler({
              workspaceId: ctx.workspaceId,
              organizationId: ctx.session.activeOrganizationId,
              body: ctx.body,
              scopedDb: ctx.scopedDb,
            }),
          {
            permissions: { workspace: ["update"] },
            body: updateWorkspaceBodySchema,
            invalidateQuery: true,
          },
        )
        .post(
          "/last-active",
          async (ctx) =>
            await updateLastActiveWorkspaceHandler({
              scopedDb: ctx.scopedDb,
              userId: ctx.user.id,
              organizationId: ctx.session.activeOrganizationId,
              workspaceId: ctx.workspaceId,
            }),
        )
        .delete(
          "/",
          async (ctx) =>
            await deleteWorkspaceHandler({
              scopedDb: ctx.scopedDb,
              workspaceId: ctx.workspaceId,
              organizationId: ctx.session.activeOrganizationId,
              authToken: ctx.session.token,
            }),
          {
            permissions: { workspace: ["delete"] },
            invalidateQuery: true,
          },
        )
        .get(
          "/contacts",
          async (ctx) =>
            await readWorkspaceContactsHandler({
              workspaceId: ctx.workspaceId,
              scopedDb: ctx.scopedDb,
            }),
        )
        .put(
          "/contacts",
          async (ctx) =>
            await createWorkspaceContactHandler({
              workspaceId: ctx.workspaceId,
              organizationId: ctx.session.activeOrganizationId,
              body: ctx.body,
              scopedDb: ctx.scopedDb,
            }),
          {
            permissions: { workspace: ["update"] },
            body: createWorkspaceContactBodySchema,
            invalidateQuery: true,
          },
        )
        .delete(
          "/contacts/:workspaceContactId",
          async (ctx) =>
            await deleteWorkspaceContactHandler({
              workspaceId: ctx.workspaceId,
              workspaceContactId: ctx.params.workspaceContactId,
              scopedDb: ctx.scopedDb,
            }),
          {
            permissions: { workspace: ["update"] },
            params: t.Object({ workspaceContactId: tNanoid }),
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
        .put(
          "/members",
          async (ctx) =>
            await addWorkspaceMemberHandler({
              workspaceId: ctx.workspaceId,
              organizationId: ctx.session.activeOrganizationId,
              body: ctx.body,
              scopedDb: ctx.scopedDb,
            }),
          {
            permissions: { workspace: ["update"] },
            body: addWorkspaceMemberBodySchema,
            invalidateQuery: true,
          },
        )
        .delete(
          "/members/:userId",
          async (ctx) =>
            await removeWorkspaceMemberHandler({
              workspaceId: ctx.workspaceId,
              userId: ctx.params.userId,
              scopedDb: ctx.scopedDb,
            }),
          {
            permissions: { workspace: ["update"] },
            params: t.Object({
              userId: t.String({ maxLength: 128 }),
            }),
            invalidateQuery: true,
          },
        ),
  );
