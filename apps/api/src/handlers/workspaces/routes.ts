import { Result } from "better-result";
import Elysia from "elysia";

import createWorkspaceAnonymizationAllowlistEntry from "@/api/handlers/workspaces/anonymization-allowlist/create";
import deleteWorkspaceAnonymizationAllowlistEntry from "@/api/handlers/workspaces/anonymization-allowlist/delete";
import readWorkspaceAnonymizationAllowlist from "@/api/handlers/workspaces/anonymization-allowlist/list";
import createWorkspaceAnonymizationTerms from "@/api/handlers/workspaces/anonymization-terms/create";
import deleteWorkspaceAnonymizationTerm from "@/api/handlers/workspaces/anonymization-terms/delete";
import readWorkspaceAnonymizationTerms from "@/api/handlers/workspaces/anonymization-terms/list";
import archiveWorkspace from "@/api/handlers/workspaces/archive";
import cellRetry from "@/api/handlers/workspaces/cells/retry";
import createWorkspaceContact from "@/api/handlers/workspaces/contacts/create";
import deleteWorkspaceContact from "@/api/handlers/workspaces/contacts/delete";
import createMatterInboundAddress from "@/api/handlers/workspaces/correspondence/address/create";
import deleteMatterInboundAddress from "@/api/handlers/workspaces/correspondence/address/delete";
import getMatterInboundAddress from "@/api/handlers/workspaces/correspondence/address/get";
import listCorrespondenceDrops from "@/api/handlers/workspaces/correspondence/drops/list";
import getCorrespondence from "@/api/handlers/workspaces/correspondence/get";
import listCorrespondence from "@/api/handlers/workspaces/correspondence/list";
import updateCorrespondence from "@/api/handlers/workspaces/correspondence/update";
import createWorkspaces from "@/api/handlers/workspaces/create";
import deleteWorkspace from "@/api/handlers/workspaces/delete";
import duplicateWorkspace from "@/api/handlers/workspaces/duplicate";
import exportOverviewActivity from "@/api/handlers/workspaces/export-overview-activity";
import generateBoundingBoxes from "@/api/handlers/workspaces/generate-bounding-boxes";
import { readWorkspaceHandler } from "@/api/handlers/workspaces/get";
import infosoudCourts from "@/api/handlers/workspaces/infosoud-courts";
import infosoudImportAgenda from "@/api/handlers/workspaces/infosoud-import-agenda";
import infosoudLookup from "@/api/handlers/workspaces/infosoud-lookup";
import readJustifications from "@/api/handlers/workspaces/justifications/list";
import readWorkspaces from "@/api/handlers/workspaces/list";
import listWorkspaceMemberPreviews from "@/api/handlers/workspaces/member-previews/list";
import addWorkspaceMember from "@/api/handlers/workspaces/members/add";
import removeWorkspaceMember from "@/api/handlers/workspaces/members/remove";
import readActiveWorkspace from "@/api/handlers/workspaces/read-active";
import readWorkspaceActivity from "@/api/handlers/workspaces/read-activity";
import readWorkspaceNavigation from "@/api/handlers/workspaces/read-navigation";
import { readOverviewHandler } from "@/api/handlers/workspaces/read-overview";
import readOverviewActivity from "@/api/handlers/workspaces/read-overview-activity";
import readOverviewActivityActors from "@/api/handlers/workspaces/read-overview-activity-actors";
import readSearchPreview from "@/api/handlers/workspaces/search-preview/get";
import unarchiveWorkspace from "@/api/handlers/workspaces/unarchive";
import updateWorkspace from "@/api/handlers/workspaces/update";
import updateActiveWorkspace from "@/api/handlers/workspaces/update-active";
import readWorkflow from "@/api/handlers/workspaces/workflow/get";
import workflowStart from "@/api/handlers/workspaces/workflow/start";
import workflowTargetCount from "@/api/handlers/workspaces/workflow/targets/count";
import { readWorkspaceContactsHandler } from "@/api/handlers/workspaces/workspace-contacts-read";
import { readWorkspaceMembersHandler } from "@/api/handlers/workspaces/workspace-members-read";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { workspaceParams } from "@/api/lib/custom-schema";

const readWorkspace = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "covered", by: "list_matters" },
  } satisfies WorkspaceHandlerConfig,
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
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "covered", by: "list_matters" },
  } satisfies WorkspaceHandlerConfig,
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
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "covered", by: "list_matters" },
  } satisfies WorkspaceHandlerConfig,
  async function* ({ scopedDb, workspaceId }) {
    const response = yield* Result.await(
      readWorkspaceContactsHandler({ workspaceId, scopedDb }),
    );

    return Result.ok(response);
  },
);

const readWorkspaceMembers = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "covered", by: "list_matters" },
  } satisfies WorkspaceHandlerConfig,
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
  .get("/member-previews", listWorkspaceMemberPreviews.handler, {
    permissions: listWorkspaceMemberPreviews.config.permissions,
    query: listWorkspaceMemberPreviews.config.query,
  })
  .get("/navigation", readWorkspaceNavigation.handler, {
    permissions: readWorkspaceNavigation.config.permissions,
    query: readWorkspaceNavigation.config.query,
  })
  .put("/", createWorkspaces.handler, {
    body: createWorkspaces.config.body,
    permissions: createWorkspaces.config.permissions,
  })
  .get("/active", readActiveWorkspace.handler, {
    permissions: readActiveWorkspace.config.permissions,
  })
  .group(
    "/:workspaceId",
    {
      params: workspaceParams({}),
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
          permissions: infosoudImportAgenda.config.permissions,
        })
        .get("/activity", readWorkspaceActivity.handler, {
          permissions: readWorkspaceActivity.config.permissions,
          query: readWorkspaceActivity.config.query,
        })
        .get("/overview", readOverview.handler, {
          permissions: readOverview.config.permissions,
        })
        .get("/search-preview", readSearchPreview.handler, {
          permissions: readSearchPreview.config.permissions,
        })
        .get("/correspondence/drops", listCorrespondenceDrops.handler, {
          permissions: listCorrespondenceDrops.config.permissions,
          query: listCorrespondenceDrops.config.query,
        })
        .get("/overview/activity", readOverviewActivity.handler, {
          permissions: readOverviewActivity.config.permissions,
          query: readOverviewActivity.config.query,
        })
        .get("/overview/activity/actors", readOverviewActivityActors.handler, {
          permissions: readOverviewActivityActors.config.permissions,
          query: readOverviewActivityActors.config.query,
        })
        .get("/overview/activity/export", exportOverviewActivity.handler, {
          permissions: exportOverviewActivity.config.permissions,
          query: exportOverviewActivity.config.query,
        })
        .post("/", updateWorkspace.handler, {
          body: updateWorkspace.config.body,
          permissions: updateWorkspace.config.permissions,
        })
        .post("/duplicate", duplicateWorkspace.handler, {
          body: duplicateWorkspace.config.body,
          permissions: duplicateWorkspace.config.permissions,
        })
        .post("/active", updateActiveWorkspace.handler, {
          permissions: updateActiveWorkspace.config.permissions,
        })
        .delete("/", deleteWorkspace.handler, {
          permissions: deleteWorkspace.config.permissions,
        })
        .post("/archive", archiveWorkspace.handler, {
          permissions: archiveWorkspace.config.permissions,
        })
        // Unarchive is mounted below, outside the active-only group.
        .get("/contacts", readWorkspaceContacts.handler, {
          permissions: readWorkspaceContacts.config.permissions,
        })
        .put("/contacts", createWorkspaceContact.handler, {
          body: createWorkspaceContact.config.body,
          permissions: createWorkspaceContact.config.permissions,
        })
        .delete(
          "/contacts/:workspaceContactId",
          deleteWorkspaceContact.handler,
          {
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
            permissions: createWorkspaceAnonymizationTerms.config.permissions,
          },
        )
        .delete(
          "/anonymization-terms/:entryId",
          deleteWorkspaceAnonymizationTerm.handler,
          {
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
            permissions:
              createWorkspaceAnonymizationAllowlistEntry.config.permissions,
          },
        )
        .delete(
          "/anonymization-allowlist/:entryId",
          deleteWorkspaceAnonymizationAllowlistEntry.handler,
          {
            params: deleteWorkspaceAnonymizationAllowlistEntry.config.params,
            permissions:
              deleteWorkspaceAnonymizationAllowlistEntry.config.permissions,
          },
        )
        .get("/correspondence", listCorrespondence.handler, {
          permissions: listCorrespondence.config.permissions,
          query: listCorrespondence.config.query,
        })
        .get("/correspondence/address", getMatterInboundAddress.handler, {
          permissions: getMatterInboundAddress.config.permissions,
        })
        .post("/correspondence/address", createMatterInboundAddress.handler, {
          permissions: createMatterInboundAddress.config.permissions,
        })
        .delete("/correspondence/address", deleteMatterInboundAddress.handler, {
          permissions: deleteMatterInboundAddress.config.permissions,
        })
        .get("/correspondence/:correspondenceId", getCorrespondence.handler, {
          permissions: getCorrespondence.config.permissions,
          params: getCorrespondence.config.params,
        })
        .patch(
          "/correspondence/:correspondenceId",
          updateCorrespondence.handler,
          {
            permissions: updateCorrespondence.config.permissions,
            params: updateCorrespondence.config.params,
            body: updateCorrespondence.config.body,
          },
        )
        .get("/members", readWorkspaceMembers.handler, {
          permissions: readWorkspaceMembers.config.permissions,
        })
        .put("/members", addWorkspaceMember.handler, {
          body: addWorkspaceMember.config.body,
          permissions: addWorkspaceMember.config.permissions,
        })
        .delete("/members/:userId", removeWorkspaceMember.handler, {
          body: removeWorkspaceMember.config.body,
          params: removeWorkspaceMember.config.params,
          permissions: removeWorkspaceMember.config.permissions,
        }),
  )
  .post("/:workspaceId/unarchive", unarchiveWorkspace.handler, {
    permissions: unarchiveWorkspace.config.permissions,
    validateWorkspaceAccessIncludingArchived: true,
  });
