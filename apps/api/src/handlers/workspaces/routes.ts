import { Result } from "better-result";
import Elysia, { t } from "elysia";

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
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

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
  .use(invalidateQuery)
  .use(permissionMacro)
  // Kept deliberately: this guard is the type-level carrier of
  // `validateAuth` for Elysia's context composition. `permissions` is a
  // function-form macro (see "Known Elysia Gotchas" in AGENTS.md) that
  // applies `validateAuth` at runtime but not in type composition, so a
  // per-route `validateAuth: true` literal instead of this guard breaks
  // sibling macros' schema merging (e.g. `invalidateQuery`'s body
  // extension). The per-request memoization in `resolveValidateAuth`
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
  })
  .put("/", createWorkspaces.handler, {
    body: createWorkspaces.config.body,
    invalidateQuery: true,
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
          invalidateQuery: true,
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
          invalidateQuery: true,
          permissions: infosoudImportAgenda.config.permissions,
        })
        .get("/activity", readWorkspaceActivity.handler, {
          permissions: readWorkspaceActivity.config.permissions,
          query: readWorkspaceActivity.config.query,
        })
        .get("/overview", readOverview.handler, {
          permissions: readOverview.config.permissions,
        })
        .post("/", updateWorkspace.handler, {
          body: updateWorkspace.config.body,
          invalidateQuery: true,
          permissions: updateWorkspace.config.permissions,
        })
        .post("/duplicate", duplicateWorkspace.handler, {
          body: duplicateWorkspace.config.body,
          invalidateOrganizationQuery: true,
          permissions: duplicateWorkspace.config.permissions,
        })
        .post("/active", updateActiveWorkspace.handler, {
          permissions: updateActiveWorkspace.config.permissions,
        })
        .delete("/", deleteWorkspace.handler, {
          invalidateQuery: true,
          permissions: deleteWorkspace.config.permissions,
        })
        .post("/archive", archiveWorkspace.handler, {
          invalidateQuery: true,
          permissions: archiveWorkspace.config.permissions,
        })
        // Unarchive is mounted below, outside the active-only group.
        .get("/contacts", readWorkspaceContacts.handler, {
          permissions: readWorkspaceContacts.config.permissions,
        })
        .put("/contacts", createWorkspaceContact.handler, {
          body: createWorkspaceContact.config.body,
          invalidateQuery: true,
          permissions: createWorkspaceContact.config.permissions,
        })
        .delete(
          "/contacts/:workspaceContactId",
          deleteWorkspaceContact.handler,
          {
            invalidateQuery: true,
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
            invalidateQuery: true,
            permissions: createWorkspaceAnonymizationTerms.config.permissions,
          },
        )
        .delete(
          "/anonymization-terms/:entryId",
          deleteWorkspaceAnonymizationTerm.handler,
          {
            invalidateQuery: true,
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
            invalidateQuery: true,
            permissions:
              createWorkspaceAnonymizationAllowlistEntry.config.permissions,
          },
        )
        .delete(
          "/anonymization-allowlist/:entryId",
          deleteWorkspaceAnonymizationAllowlistEntry.handler,
          {
            invalidateQuery: true,
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
          invalidateQuery: true,
          permissions: addWorkspaceMember.config.permissions,
        })
        .delete("/members/:userId", removeWorkspaceMember.handler, {
          invalidateQuery: true,
          params: removeWorkspaceMember.config.params,
          permissions: removeWorkspaceMember.config.permissions,
        }),
  )
  .post("/:workspaceId/unarchive", unarchiveWorkspace.handler, {
    invalidateQuery: true,
    permissions: unarchiveWorkspace.config.permissions,
    validateWorkspaceAccessIncludingArchived: true,
  });
