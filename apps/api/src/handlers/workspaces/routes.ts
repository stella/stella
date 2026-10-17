import { Result } from "better-result";
import Elysia, { t } from "elysia";

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
    contract: "patch",
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
    contract: "patch",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "covered", by: "list_matters" },
    query: t.Object({
      /** The reader's local date; the agenda starts there. */
      agendaFrom: t.Optional(t.String({ format: "date" })),
    }),
  } satisfies WorkspaceHandlerConfig,
  async function* ({ scopedDb, workspaceId, query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readOverviewHandler({
            workspaceId,
            scopedDb,
            agendaFrom: query.agendaFrom,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const readWorkspaceContacts = createSafeHandler(
  {
    contract: "patch",
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
    contract: "patch",
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
    accountAccess: readWorkspaces.config.accountAccess,
  })
  .get("/member-previews", listWorkspaceMemberPreviews.handler, {
    permissions: listWorkspaceMemberPreviews.config.permissions,
    accountAccess: listWorkspaceMemberPreviews.config.accountAccess,
    query: listWorkspaceMemberPreviews.config.query,
  })
  .get("/navigation", readWorkspaceNavigation.handler, {
    permissions: readWorkspaceNavigation.config.permissions,
    accountAccess: readWorkspaceNavigation.config.accountAccess,
    query: readWorkspaceNavigation.config.query,
  })
  .put("/", createWorkspaces.handler, {
    body: createWorkspaces.config.body,
    permissions: createWorkspaces.config.permissions,
    accountAccess: createWorkspaces.config.accountAccess,
  })
  .get("/active", readActiveWorkspace.handler, {
    permissions: readActiveWorkspace.config.permissions,
    accountAccess: readActiveWorkspace.config.accountAccess,
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
          accountAccess: readWorkspace.config.accountAccess,
        })
        .get("/workflow", readWorkflow.handler, {
          permissions: readWorkflow.config.permissions,
          accountAccess: readWorkflow.config.accountAccess,
        })
        .post("/workflow/start", workflowStart.handler, {
          body: workflowStart.config.body,
          permissions: workflowStart.config.permissions,
          accountAccess: workflowStart.config.accountAccess,
        })
        .post("/workflow/target-count", workflowTargetCount.handler, {
          body: workflowTargetCount.config.body,
          permissions: workflowTargetCount.config.permissions,
          accountAccess: workflowTargetCount.config.accountAccess,
        })
        .post("/cell-retry", cellRetry.handler, {
          body: cellRetry.config.body,
          permissions: cellRetry.config.permissions,
          accountAccess: cellRetry.config.accountAccess,
        })
        .post("/justifications/query", readJustifications.handler, {
          body: readJustifications.config.body,
          permissions: readJustifications.config.permissions,
          accountAccess: readJustifications.config.accountAccess,
        })
        .post("/bounding-boxes", generateBoundingBoxes.handler, {
          body: generateBoundingBoxes.config.body,
          permissions: generateBoundingBoxes.config.permissions,
          accountAccess: generateBoundingBoxes.config.accountAccess,
        })
        .get("/infosoud/courts", infosoudCourts.handler, {
          permissions: infosoudCourts.config.permissions,
          accountAccess: infosoudCourts.config.accountAccess,
        })
        .post("/infosoud/lookup", infosoudLookup.handler, {
          body: infosoudLookup.config.body,
          permissions: infosoudLookup.config.permissions,
          accountAccess: infosoudLookup.config.accountAccess,
        })
        .post("/infosoud/import-agenda", infosoudImportAgenda.handler, {
          body: infosoudImportAgenda.config.body,
          permissions: infosoudImportAgenda.config.permissions,
          accountAccess: infosoudImportAgenda.config.accountAccess,
        })
        .get("/activity", readWorkspaceActivity.handler, {
          permissions: readWorkspaceActivity.config.permissions,
          accountAccess: readWorkspaceActivity.config.accountAccess,
          query: readWorkspaceActivity.config.query,
        })
        .get("/overview", readOverview.handler, {
          permissions: readOverview.config.permissions,
          accountAccess: readOverview.config.accountAccess,
          query: readOverview.config.query,
        })
        .get("/search-preview", readSearchPreview.handler, {
          permissions: readSearchPreview.config.permissions,
          accountAccess: readSearchPreview.config.accountAccess,
        })
        .get("/correspondence/drops", listCorrespondenceDrops.handler, {
          permissions: listCorrespondenceDrops.config.permissions,
          accountAccess: listCorrespondenceDrops.config.accountAccess,
          query: listCorrespondenceDrops.config.query,
        })
        .get("/overview/activity", readOverviewActivity.handler, {
          permissions: readOverviewActivity.config.permissions,
          accountAccess: readOverviewActivity.config.accountAccess,
          query: readOverviewActivity.config.query,
        })
        .get("/overview/activity/actors", readOverviewActivityActors.handler, {
          permissions: readOverviewActivityActors.config.permissions,
          accountAccess: readOverviewActivityActors.config.accountAccess,
          query: readOverviewActivityActors.config.query,
        })
        .get("/overview/activity/export", exportOverviewActivity.handler, {
          permissions: exportOverviewActivity.config.permissions,
          accountAccess: exportOverviewActivity.config.accountAccess,
          query: exportOverviewActivity.config.query,
        })
        .post("/", updateWorkspace.handler, {
          body: updateWorkspace.config.body,
          permissions: updateWorkspace.config.permissions,
          accountAccess: updateWorkspace.config.accountAccess,
        })
        .post("/duplicate", duplicateWorkspace.handler, {
          body: duplicateWorkspace.config.body,
          permissions: duplicateWorkspace.config.permissions,
          accountAccess: duplicateWorkspace.config.accountAccess,
        })
        .post("/active", updateActiveWorkspace.handler, {
          permissions: updateActiveWorkspace.config.permissions,
          accountAccess: updateActiveWorkspace.config.accountAccess,
        })
        .delete("/", deleteWorkspace.handler, {
          permissions: deleteWorkspace.config.permissions,
          accountAccess: deleteWorkspace.config.accountAccess,
        })
        .post("/archive", archiveWorkspace.handler, {
          permissions: archiveWorkspace.config.permissions,
          accountAccess: archiveWorkspace.config.accountAccess,
        })
        // Unarchive is mounted below, outside the active-only group.
        .get("/contacts", readWorkspaceContacts.handler, {
          permissions: readWorkspaceContacts.config.permissions,
          accountAccess: readWorkspaceContacts.config.accountAccess,
        })
        .put("/contacts", createWorkspaceContact.handler, {
          body: createWorkspaceContact.config.body,
          permissions: createWorkspaceContact.config.permissions,
          accountAccess: createWorkspaceContact.config.accountAccess,
        })
        .delete(
          "/contacts/:workspaceContactId",
          deleteWorkspaceContact.handler,
          {
            params: deleteWorkspaceContact.config.params,
            permissions: deleteWorkspaceContact.config.permissions,
            accountAccess: deleteWorkspaceContact.config.accountAccess,
          },
        )
        .get("/anonymization-terms", readWorkspaceAnonymizationTerms.handler, {
          permissions: readWorkspaceAnonymizationTerms.config.permissions,
          accountAccess: readWorkspaceAnonymizationTerms.config.accountAccess,
        })
        .put(
          "/anonymization-terms",
          createWorkspaceAnonymizationTerms.handler,
          {
            body: createWorkspaceAnonymizationTerms.config.body,
            permissions: createWorkspaceAnonymizationTerms.config.permissions,
            accountAccess:
              createWorkspaceAnonymizationTerms.config.accountAccess,
          },
        )
        .delete(
          "/anonymization-terms/:entryId",
          deleteWorkspaceAnonymizationTerm.handler,
          {
            params: deleteWorkspaceAnonymizationTerm.config.params,
            permissions: deleteWorkspaceAnonymizationTerm.config.permissions,
            accountAccess:
              deleteWorkspaceAnonymizationTerm.config.accountAccess,
          },
        )
        .get(
          "/anonymization-allowlist",
          readWorkspaceAnonymizationAllowlist.handler,
          {
            permissions: readWorkspaceAnonymizationAllowlist.config.permissions,
            accountAccess:
              readWorkspaceAnonymizationAllowlist.config.accountAccess,
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
            accountAccess:
              createWorkspaceAnonymizationAllowlistEntry.config.accountAccess,
          },
        )
        .delete(
          "/anonymization-allowlist/:entryId",
          deleteWorkspaceAnonymizationAllowlistEntry.handler,
          {
            params: deleteWorkspaceAnonymizationAllowlistEntry.config.params,
            permissions:
              deleteWorkspaceAnonymizationAllowlistEntry.config.permissions,
            accountAccess:
              deleteWorkspaceAnonymizationAllowlistEntry.config.accountAccess,
          },
        ),
  )
  .group(
    "/:workspaceId",
    { params: workspaceParams({}), validateWorkspaceAccess: true },
    (app) =>
      app
        .get("/correspondence", listCorrespondence.handler, {
          permissions: listCorrespondence.config.permissions,
          accountAccess: listCorrespondence.config.accountAccess,
          query: listCorrespondence.config.query,
        })
        .get("/correspondence/address", getMatterInboundAddress.handler, {
          permissions: getMatterInboundAddress.config.permissions,
          accountAccess: getMatterInboundAddress.config.accountAccess,
        })
        .post("/correspondence/address", createMatterInboundAddress.handler, {
          permissions: createMatterInboundAddress.config.permissions,
          accountAccess: createMatterInboundAddress.config.accountAccess,
        })
        .delete("/correspondence/address", deleteMatterInboundAddress.handler, {
          permissions: deleteMatterInboundAddress.config.permissions,
          accountAccess: deleteMatterInboundAddress.config.accountAccess,
        })
        .get("/correspondence/:correspondenceId", getCorrespondence.handler, {
          permissions: getCorrespondence.config.permissions,
          accountAccess: getCorrespondence.config.accountAccess,
          params: getCorrespondence.config.params,
        })
        .patch(
          "/correspondence/:correspondenceId",
          updateCorrespondence.handler,
          {
            permissions: updateCorrespondence.config.permissions,
            accountAccess: updateCorrespondence.config.accountAccess,
            params: updateCorrespondence.config.params,
            body: updateCorrespondence.config.body,
          },
        )
        .get("/members", readWorkspaceMembers.handler, {
          permissions: readWorkspaceMembers.config.permissions,
          accountAccess: readWorkspaceMembers.config.accountAccess,
        })
        .put("/members", addWorkspaceMember.handler, {
          body: addWorkspaceMember.config.body,
          permissions: addWorkspaceMember.config.permissions,
          accountAccess: addWorkspaceMember.config.accountAccess,
        })
        .delete("/members/:userId", removeWorkspaceMember.handler, {
          body: removeWorkspaceMember.config.body,
          params: removeWorkspaceMember.config.params,
          permissions: removeWorkspaceMember.config.permissions,
          accountAccess: removeWorkspaceMember.config.accountAccess,
        }),
  )
  .post("/:workspaceId/unarchive", unarchiveWorkspace.handler, {
    permissions: unarchiveWorkspace.config.permissions,
    accountAccess: unarchiveWorkspace.config.accountAccess,
    validateWorkspaceAccessIncludingArchived: true,
  });
