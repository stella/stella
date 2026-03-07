import Elysia, { t } from "elysia";

import {
  createWorkspacesBodySchema,
  createWorkspacesHandler,
} from "@/api/handlers/workspaces/create";
import { deleteWorkspaceHandler } from "@/api/handlers/workspaces/delete-by-id";
import { readWorkspacesHandler } from "@/api/handlers/workspaces/read";
import { readWorkspaceHandler } from "@/api/handlers/workspaces/read-by-id";
import { readJustificationsHandler } from "@/api/handlers/workspaces/read-justifications";
import { readLastActiveWorkspaceHandler } from "@/api/handlers/workspaces/read-last-active";
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
import { workspaceAccessMacro } from "@/api/lib/auth";
import { tNanoid } from "@/api/lib/custom-schema";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const workspacesRoute = new Elysia({ prefix: "/workspaces" })
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .guard({
    validateAuth: true,
  })
  .get("/", (ctx) =>
    readWorkspacesHandler({
      organizationId: ctx.session.activeOrganizationId,
    }),
  )
  .put(
    "/",
    (ctx) =>
      createWorkspacesHandler({
        organizationId: ctx.session.activeOrganizationId,
        body: ctx.body,
      }),

    {
      invalidateQuery: true,
      body: createWorkspacesBodySchema,
    },
  )
  .get("/last-active", (ctx) =>
    readLastActiveWorkspaceHandler({
      userId: ctx.user.id,
      organizationId: ctx.session.activeOrganizationId,
    }),
  )
  .group(
    "/:workspaceId",
    {
      validateWorkspaceAccess: true,
    },
    (app) =>
      app
        .get("/", (ctx) =>
          readWorkspaceHandler({
            workspaceId: ctx.workspaceId,
            organizationId: ctx.session.activeOrganizationId,
          }),
        )
        .get("/workflow", (ctx) =>
          readWorkflowHandler({
            workspaceId: ctx.workspaceId,
            organizationId: ctx.session.activeOrganizationId,
            authToken: ctx.session.token,
          }),
        )
        .get("/justifications", (ctx) =>
          readJustificationsHandler({
            workspaceId: ctx.workspaceId,
          }),
        )
        .get("/overview", (ctx) =>
          readOverviewHandler({
            workspaceId: ctx.workspaceId,
          }),
        )
        .post(
          "/",
          (ctx) =>
            updateWorkspaceHandler({
              workspaceId: ctx.workspaceId,
              organizationId: ctx.session.activeOrganizationId,
              body: ctx.body,
            }),
          {
            body: updateWorkspaceBodySchema,
            invalidateQuery: true,
          },
        )
        .post("/last-active", (ctx) =>
          updateLastActiveWorkspaceHandler({
            userId: ctx.user.id,
            organizationId: ctx.session.activeOrganizationId,
            workspaceId: ctx.workspaceId,
          }),
        )
        .delete(
          "/",
          (ctx) =>
            deleteWorkspaceHandler({
              workspaceId: ctx.workspaceId,
              organizationId: ctx.session.activeOrganizationId,
              authToken: ctx.session.token,
            }),
          {
            invalidateQuery: true,
          },
        )
        .get("/contacts", (ctx) =>
          readWorkspaceContactsHandler({
            workspaceId: ctx.workspaceId,
          }),
        )
        .put(
          "/contacts",
          (ctx) =>
            createWorkspaceContactHandler({
              workspaceId: ctx.workspaceId,
              organizationId: ctx.session.activeOrganizationId,
              body: ctx.body,
            }),
          {
            body: createWorkspaceContactBodySchema,
            invalidateQuery: true,
          },
        )
        .delete(
          "/contacts/:workspaceContactId",
          (ctx) =>
            deleteWorkspaceContactHandler({
              workspaceId: ctx.workspaceId,
              workspaceContactId: ctx.params.workspaceContactId,
            }),
          {
            params: t.Object({ workspaceContactId: tNanoid }),
            invalidateQuery: true,
          },
        ),
  );
