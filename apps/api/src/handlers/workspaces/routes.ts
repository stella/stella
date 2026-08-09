import { Result } from "better-result";
import Elysia, { t } from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import createWorkspaceAnonymizationAllowlistEntry from "@/api/handlers/workspaces/anonymization-allowlist/create";
import deleteWorkspaceAnonymizationAllowlistEntry from "@/api/handlers/workspaces/anonymization-allowlist/delete";
import readWorkspaceAnonymizationAllowlist from "@/api/handlers/workspaces/anonymization-allowlist/list";
import createWorkspaceAnonymizationTerms from "@/api/handlers/workspaces/anonymization-terms/create";
import deleteWorkspaceAnonymizationTerm from "@/api/handlers/workspaces/anonymization-terms/delete";
import readWorkspaceAnonymizationTerms from "@/api/handlers/workspaces/anonymization-terms/list";
import archiveWorkspace from "@/api/handlers/workspaces/archive";
import cellRetry from "@/api/handlers/workspaces/cell-retry";
import createWorkspaces from "@/api/handlers/workspaces/create";
import deleteWorkspace from "@/api/handlers/workspaces/delete";
import duplicateWorkspace from "@/api/handlers/workspaces/duplicate";
import generateBoundingBoxes from "@/api/handlers/workspaces/generate-bounding-boxes";
import { readWorkspaceHandler } from "@/api/handlers/workspaces/get";
import infosoudCourts from "@/api/handlers/workspaces/infosoud-courts";
import infosoudImportAgenda from "@/api/handlers/workspaces/infosoud-import-agenda";
import infosoudLookup from "@/api/handlers/workspaces/infosoud-lookup";
import readWorkspaces from "@/api/handlers/workspaces/list";
import readActiveWorkspace from "@/api/handlers/workspaces/read-active";
import readWorkspaceActivity from "@/api/handlers/workspaces/read-activity";
import readJustifications from "@/api/handlers/workspaces/read-justifications";
import readWorkspaceNavigation from "@/api/handlers/workspaces/read-navigation";
import { readOverviewHandler } from "@/api/handlers/workspaces/read-overview";
import readOverviewActivity from "@/api/handlers/workspaces/read-overview-activity";
import readWorkflow from "@/api/handlers/workspaces/read-workflow-status";
import workflowTargetCount from "@/api/handlers/workspaces/read-workflow-target-count";
import unarchiveWorkspace from "@/api/handlers/workspaces/unarchive";
import updateWorkspace from "@/api/handlers/workspaces/update";
import updateActiveWorkspace from "@/api/handlers/workspaces/update-active";
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
import {
  organizationResourceSetUpdates,
  resourceRealtime,
  workspaceResourceSetUpdates,
} from "@/api/lib/resource-realtime-macro";

const organizationWorkspaceRealtimeUpdates = organizationResourceSetUpdates(
  RESOURCE_TYPE.WORKSPACE,
);
const workspaceContactRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.CONTACT,
);
const workspaceEntityRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.ENTITY,
);
const workspaceRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.WORKSPACE,
);

const readWorkspace = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    mcp: { type: "covered", by: "list_matters" },
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

const readOverview = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    mcp: { type: "covered", by: "list_matters" },
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
    mcp: { type: "covered", by: "list_matters" },
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
    mcp: { type: "covered", by: "list_matters" },
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
  .use(resourceRealtime)
  .use(permissionMacro)
  // Kept deliberately: this guard is the type-level carrier of
  // `validateAuth` for Elysia's context composition. `permissions` is a
  // function-form macro (see "Known Elysia Gotchas" in AGENTS.md) that
  // applies `validateAuth` at runtime but not in type composition, so a
  // per-route `validateAuth: true` literal instead of this guard breaks
  // sibling macro context composition. The per-request memoization in
  // `resolveValidateAuth`
  // (lib/auth.ts) neutralizes the extra resolve this guard stacks on top
  // of `permissions`. See tests/security/route-auth-invariants.test.ts.
  .guard({
    validateAuth: true,
  })
  .get("/", readWorkspaces.handler, {
    permissions: readWorkspaces.config.permissions,
  })
  .get("/navigation", readWorkspaceNavigation.handler, {
    permissions: readWorkspaceNavigation.config.permissions,
    query: readWorkspaceNavigation.config.query,
  })
  .put("/", createWorkspaces.handler, {
    body: createWorkspaces.config.body,
    resourceSetUpdated: organizationWorkspaceRealtimeUpdates,
    permissions: createWorkspaces.config.permissions,
  })
  .get("/active", readActiveWorkspace.handler, {
    permissions: readActiveWorkspace.config.permissions,
  })
  .group(
    "/:workspaceId",
    {
      params: t.Object({ workspaceId: tSafeId("workspace") }),
      validateWorkspaceAccess: true,
    },
    (app) =>
      app
        .get("/", readWorkspace.handler, {
          permissions: readWorkspace.config.permissions,
        })
        .get("/workflow", readWorkflow.handler, {
          permissions: readWorkflow.config.permissions,
        })
        .post("/workflow/start", workflowStart.handler, {
          body: workflowStart.config.body,
          permissions: workflowStart.config.permissions,
        })
        .post("/workflow/target-count", workflowTargetCount.handler, {
          body: workflowTargetCount.config.body,
          permissions: workflowTargetCount.config.permissions,
        })
        .post("/cell-retry", cellRetry.handler, {
          body: cellRetry.config.body,
          permissions: cellRetry.config.permissions,
        })
        .post("/justifications/query", readJustifications.handler, {
          body: readJustifications.config.body,
          permissions: readJustifications.config.permissions,
        })
        .post("/bounding-boxes", generateBoundingBoxes.handler, {
          body: generateBoundingBoxes.config.body,
          resourceSetUpdated: workspaceRealtimeUpdates,
          permissions: generateBoundingBoxes.config.permissions,
        })
        .get("/infosoud/courts", infosoudCourts.handler, {
          permissions: infosoudCourts.config.permissions,
        })
        .post("/infosoud/lookup", infosoudLookup.handler, {
          body: infosoudLookup.config.body,
          permissions: infosoudLookup.config.permissions,
        })
        .post("/infosoud/import-agenda", infosoudImportAgenda.handler, {
          body: infosoudImportAgenda.config.body,
          resourceSetUpdated: workspaceEntityRealtimeUpdates,
          permissions: infosoudImportAgenda.config.permissions,
        })
        .get("/activity", readWorkspaceActivity.handler, {
          permissions: readWorkspaceActivity.config.permissions,
          query: readWorkspaceActivity.config.query,
        })
        .get("/overview", readOverview.handler, {
          permissions: readOverview.config.permissions,
        })
        .get("/overview/activity", readOverviewActivity.handler, {
          permissions: readOverviewActivity.config.permissions,
          query: readOverviewActivity.config.query,
        })
        .post("/", updateWorkspace.handler, {
          body: updateWorkspace.config.body,
          resourceSetUpdated: workspaceRealtimeUpdates,
          permissions: updateWorkspace.config.permissions,
        })
        .post("/duplicate", duplicateWorkspace.handler, {
          body: duplicateWorkspace.config.body,
          resourceSetUpdated: organizationWorkspaceRealtimeUpdates,
          permissions: duplicateWorkspace.config.permissions,
        })
        .post("/active", updateActiveWorkspace.handler, {
          permissions: updateActiveWorkspace.config.permissions,
        })
        .delete("/", deleteWorkspace.handler, {
          resourceSetUpdated: workspaceRealtimeUpdates,
          permissions: deleteWorkspace.config.permissions,
        })
        .post("/archive", archiveWorkspace.handler, {
          resourceSetUpdated: workspaceRealtimeUpdates,
          permissions: archiveWorkspace.config.permissions,
        })
        // Unarchive is mounted below, outside the active-only group.
        .get("/contacts", readWorkspaceContacts.handler, {
          permissions: readWorkspaceContacts.config.permissions,
        })
        .put("/contacts", createWorkspaceContact.handler, {
          body: createWorkspaceContact.config.body,
          resourceSetUpdated: workspaceContactRealtimeUpdates,
          permissions: createWorkspaceContact.config.permissions,
        })
        .delete(
          "/contacts/:workspaceContactId",
          deleteWorkspaceContact.handler,
          {
            resourceSetUpdated: workspaceContactRealtimeUpdates,
            params: deleteWorkspaceContact.config.params,
            permissions: deleteWorkspaceContact.config.permissions,
          },
        )
        .get("/anonymization-terms", readWorkspaceAnonymizationTerms.handler, {
          permissions: readWorkspaceAnonymizationTerms.config.permissions,
        })
        .put(
          "/anonymization-terms",
          createWorkspaceAnonymizationTerms.handler,
          {
            body: createWorkspaceAnonymizationTerms.config.body,
            resourceSetUpdated: workspaceRealtimeUpdates,
            permissions: createWorkspaceAnonymizationTerms.config.permissions,
          },
        )
        .delete(
          "/anonymization-terms/:entryId",
          deleteWorkspaceAnonymizationTerm.handler,
          {
            resourceSetUpdated: workspaceRealtimeUpdates,
            params: deleteWorkspaceAnonymizationTerm.config.params,
            permissions: deleteWorkspaceAnonymizationTerm.config.permissions,
          },
        )
        .get(
          "/anonymization-allowlist",
          readWorkspaceAnonymizationAllowlist.handler,
          {
            permissions: readWorkspaceAnonymizationAllowlist.config.permissions,
            query: readWorkspaceAnonymizationAllowlist.config.query,
          },
        )
        .put(
          "/anonymization-allowlist",
          createWorkspaceAnonymizationAllowlistEntry.handler,
          {
            body: createWorkspaceAnonymizationAllowlistEntry.config.body,
            resourceSetUpdated: workspaceRealtimeUpdates,
            permissions:
              createWorkspaceAnonymizationAllowlistEntry.config.permissions,
          },
        )
        .delete(
          "/anonymization-allowlist/:entryId",
          deleteWorkspaceAnonymizationAllowlistEntry.handler,
          {
            resourceSetUpdated: workspaceRealtimeUpdates,
            params: deleteWorkspaceAnonymizationAllowlistEntry.config.params,
            permissions:
              deleteWorkspaceAnonymizationAllowlistEntry.config.permissions,
          },
        )
        .get("/members", readWorkspaceMembers.handler, {
          permissions: readWorkspaceMembers.config.permissions,
        })
        .put("/members", addWorkspaceMember.handler, {
          body: addWorkspaceMember.config.body,
          resourceSetUpdated: workspaceRealtimeUpdates,
          permissions: addWorkspaceMember.config.permissions,
        })
        .delete("/members/:userId", removeWorkspaceMember.handler, {
          resourceSetUpdated: workspaceRealtimeUpdates,
          params: removeWorkspaceMember.config.params,
          permissions: removeWorkspaceMember.config.permissions,
        }),
  )
  .post("/:workspaceId/unarchive", unarchiveWorkspace.handler, {
    resourceSetUpdated: workspaceRealtimeUpdates,
    permissions: unarchiveWorkspace.config.permissions,
    validateWorkspaceAccessIncludingArchived: true,
  });
