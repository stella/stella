import { Result } from "better-result";
import Elysia, { t } from "elysia";

import {
  createWorkspaceAnonymizationTerms,
  deleteWorkspaceAnonymizationTerm,
  readWorkspaceAnonymizationTerms,
} from "@/api/handlers/workspaces/anonymization-terms";
import archiveWorkspace from "@/api/handlers/workspaces/archive";
import createWorkspaces from "@/api/handlers/workspaces/create";
import deleteWorkspace from "@/api/handlers/workspaces/delete-by-id";
import duplicateWorkspace from "@/api/handlers/workspaces/duplicate";
import generateBoundingBoxes from "@/api/handlers/workspaces/generate-bounding-boxes";
import infosoudCourts from "@/api/handlers/workspaces/infosoud-courts";
import infosoudImportAgenda from "@/api/handlers/workspaces/infosoud-import-agenda";
import infosoudLookup from "@/api/handlers/workspaces/infosoud-lookup";
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
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { tSafeId } from "@/api/lib/custom-schema";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";
import { LIMITS } from "@/api/lib/limits";

const readWorkspace = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
  } satisfies HandlerConfig,
  async function* ({ scopedDb, session, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readWorkspaceHandler({
            workspaceId,
            organizationId: session.activeOrganizationId,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const readWorkflow = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
  } satisfies HandlerConfig,
  async function* ({ workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(async () => await readWorkflowHandler(workspaceId)),
    );

    return Result.ok(response);
  },
);

const readJustifications = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    body: t.Object({
      entityIds: t.Array(tSafeId("entity"), {
        minItems: 1,
        maxItems: LIMITS.entitiesPageSizeMax,
      }),
    }),
  } satisfies HandlerConfig,
  async function* ({ body: { entityIds }, scopedDb, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readJustificationsHandler({
            workspaceId,
            scopedDb,
            entityIds,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const readOverview = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
  } satisfies HandlerConfig,
  async function* ({ scopedDb, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readOverviewHandler({
            workspaceId,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const readWorkspaceContacts = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
  } satisfies HandlerConfig,
  async function* ({ scopedDb, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readWorkspaceContactsHandler({
            workspaceId,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const readWorkspaceMembers = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
  } satisfies HandlerConfig,
  async function* ({ scopedDb, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readWorkspaceMembersHandler({
            workspaceId,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

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
      params: t.Object({ workspaceId: tSafeId("workspace") }),
      validateWorkspaceAccess: true,
    },
    (app) =>
      app
        .get("/", readWorkspace.handler)
        .get("/workflow", readWorkflow.handler)
        .post("/workflow/start", workflowStart.handler, {
          body: workflowStart.config.body,
          permissions: workflowStart.config.permissions,
        })
        .post("/justifications/query", readJustifications.handler, {
          body: readJustifications.config.body,
        })
        .post("/bounding-boxes", generateBoundingBoxes.handler, {
          body: generateBoundingBoxes.config.body,
          invalidateQuery: true,
        })
        .get("/infosoud/courts", infosoudCourts.handler)
        .post("/infosoud/lookup", infosoudLookup.handler, {
          body: infosoudLookup.config.body,
        })
        .post("/infosoud/import-agenda", infosoudImportAgenda.handler, {
          body: infosoudImportAgenda.config.body,
          invalidateQuery: true,
        })
        .get("/overview", readOverview.handler)
        .post("/", updateWorkspace.handler, {
          body: updateWorkspace.config.body,
          invalidateQuery: true,
        })
        .post("/duplicate", duplicateWorkspace.handler, {
          body: duplicateWorkspace.config.body,
          permissions: duplicateWorkspace.config.permissions,
          invalidateOrganizationQuery: true,
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
        .get("/contacts", readWorkspaceContacts.handler)
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
        .get("/anonymization-terms", readWorkspaceAnonymizationTerms.handler)
        .put(
          "/anonymization-terms",
          createWorkspaceAnonymizationTerms.handler,
          {
            body: createWorkspaceAnonymizationTerms.config.body,
            invalidateQuery: true,
          },
        )
        .delete(
          "/anonymization-terms/:entryId",
          deleteWorkspaceAnonymizationTerm.handler,
          {
            params: deleteWorkspaceAnonymizationTerm.config.params,
            invalidateQuery: true,
          },
        )
        .get("/members", readWorkspaceMembers.handler)
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
