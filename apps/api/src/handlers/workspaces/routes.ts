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
  .get(
    "/",
    {
      permissions: readWorkspaces.config.permissions,
    },
    readWorkspaces.handler,
  )
  .get(
    "/member-previews",
    {
      permissions: listWorkspaceMemberPreviews.config.permissions,
      query: listWorkspaceMemberPreviews.config.query,
    },
    listWorkspaceMemberPreviews.handler,
  )
  .get(
    "/navigation",
    {
      permissions: readWorkspaceNavigation.config.permissions,
      query: readWorkspaceNavigation.config.query,
    },
    readWorkspaceNavigation.handler,
  )
  .put(
    "/",
    {
      body: createWorkspaces.config.body,
      permissions: createWorkspaces.config.permissions,
    },
    createWorkspaces.handler,
  )
  .get(
    "/active",
    {
      permissions: readActiveWorkspace.config.permissions,
    },
    readActiveWorkspace.handler,
  )
  .group(
    "/:workspaceId",
    {
      params: workspaceParams({}),
      schema: "merge",
      validateWorkspaceAccess: true,
    },
    (app) =>
      app
        .get(
          "/",
          {
            permissions: readWorkspace.config.permissions,
          },
          readWorkspace.handler,
        )
        .get(
          "/workflow",
          {
            permissions: readWorkflow.config.permissions,
          },
          readWorkflow.handler,
        )
        .post(
          "/workflow/start",
          {
            body: workflowStart.config.body,
            permissions: workflowStart.config.permissions,
          },
          workflowStart.handler,
        )
        .post(
          "/workflow/target-count",
          {
            body: workflowTargetCount.config.body,
            permissions: workflowTargetCount.config.permissions,
          },
          workflowTargetCount.handler,
        )
        .post(
          "/cell-retry",
          {
            body: cellRetry.config.body,
            permissions: cellRetry.config.permissions,
          },
          cellRetry.handler,
        )
        .post(
          "/justifications/query",
          {
            body: readJustifications.config.body,
            permissions: readJustifications.config.permissions,
          },
          readJustifications.handler,
        )
        .post(
          "/bounding-boxes",
          {
            body: generateBoundingBoxes.config.body,
            permissions: generateBoundingBoxes.config.permissions,
          },
          generateBoundingBoxes.handler,
        )
        .get(
          "/infosoud/courts",
          {
            permissions: infosoudCourts.config.permissions,
          },
          infosoudCourts.handler,
        )
        .post(
          "/infosoud/lookup",
          {
            body: infosoudLookup.config.body,
            permissions: infosoudLookup.config.permissions,
          },
          infosoudLookup.handler,
        )
        .post(
          "/infosoud/import-agenda",
          {
            body: infosoudImportAgenda.config.body,
            permissions: infosoudImportAgenda.config.permissions,
          },
          infosoudImportAgenda.handler,
        )
        .get(
          "/activity",
          {
            permissions: readWorkspaceActivity.config.permissions,
            query: readWorkspaceActivity.config.query,
          },
          readWorkspaceActivity.handler,
        )
        .get(
          "/overview",
          {
            permissions: readOverview.config.permissions,
            query: readOverview.config.query,
          },
          readOverview.handler,
        )
        .get(
          "/search-preview",
          {
            permissions: readSearchPreview.config.permissions,
          },
          readSearchPreview.handler,
        )
        .get(
          "/correspondence/drops",
          {
            permissions: listCorrespondenceDrops.config.permissions,
            query: listCorrespondenceDrops.config.query,
          },
          listCorrespondenceDrops.handler,
        )
        .get(
          "/overview/activity",
          {
            permissions: readOverviewActivity.config.permissions,
            query: readOverviewActivity.config.query,
          },
          readOverviewActivity.handler,
        )
        .get(
          "/overview/activity/actors",
          {
            permissions: readOverviewActivityActors.config.permissions,
            query: readOverviewActivityActors.config.query,
          },
          readOverviewActivityActors.handler,
        )
        .get(
          "/overview/activity/export",
          {
            permissions: exportOverviewActivity.config.permissions,
            query: exportOverviewActivity.config.query,
          },
          exportOverviewActivity.handler,
        ),
  )
  .group(
    "/:workspaceId",
    {
      params: workspaceParams({}),
      schema: "merge",
      validateWorkspaceAccess: true,
    },
    (app) =>
      app
        .post(
          "/",
          {
            body: updateWorkspace.config.body,
            permissions: updateWorkspace.config.permissions,
          },
          updateWorkspace.handler,
        )
        .post(
          "/duplicate",
          {
            body: duplicateWorkspace.config.body,
            permissions: duplicateWorkspace.config.permissions,
          },
          duplicateWorkspace.handler,
        )
        .post(
          "/active",
          {
            permissions: updateActiveWorkspace.config.permissions,
          },
          updateActiveWorkspace.handler,
        )
        .delete(
          "/",
          {
            permissions: deleteWorkspace.config.permissions,
          },
          deleteWorkspace.handler,
        )
        .post(
          "/archive",
          {
            permissions: archiveWorkspace.config.permissions,
          },
          archiveWorkspace.handler,
        )
        // Unarchive is mounted below, outside the active-only group.
        .get(
          "/contacts",
          {
            permissions: readWorkspaceContacts.config.permissions,
          },
          readWorkspaceContacts.handler,
        )
        .put(
          "/contacts",
          {
            body: createWorkspaceContact.config.body,
            permissions: createWorkspaceContact.config.permissions,
          },
          createWorkspaceContact.handler,
        )
        .delete(
          "/contacts/:workspaceContactId",
          {
            params: deleteWorkspaceContact.config.params,
            permissions: deleteWorkspaceContact.config.permissions,
          },
          deleteWorkspaceContact.handler,
        )
        .get(
          "/anonymization-terms",
          {
            permissions: readWorkspaceAnonymizationTerms.config.permissions,
          },
          readWorkspaceAnonymizationTerms.handler,
        )
        .put(
          "/anonymization-terms",
          {
            body: createWorkspaceAnonymizationTerms.config.body,
            permissions: createWorkspaceAnonymizationTerms.config.permissions,
          },
          createWorkspaceAnonymizationTerms.handler,
        )
        .delete(
          "/anonymization-terms/:entryId",
          {
            params: deleteWorkspaceAnonymizationTerm.config.params,
            permissions: deleteWorkspaceAnonymizationTerm.config.permissions,
          },
          deleteWorkspaceAnonymizationTerm.handler,
        )
        .get(
          "/anonymization-allowlist",
          {
            permissions: readWorkspaceAnonymizationAllowlist.config.permissions,
            query: readWorkspaceAnonymizationAllowlist.config.query,
          },
          readWorkspaceAnonymizationAllowlist.handler,
        )
        .put(
          "/anonymization-allowlist",
          {
            body: createWorkspaceAnonymizationAllowlistEntry.config.body,
            permissions:
              createWorkspaceAnonymizationAllowlistEntry.config.permissions,
          },
          createWorkspaceAnonymizationAllowlistEntry.handler,
        )
        .delete(
          "/anonymization-allowlist/:entryId",
          {
            params: deleteWorkspaceAnonymizationAllowlistEntry.config.params,
            permissions:
              deleteWorkspaceAnonymizationAllowlistEntry.config.permissions,
          },
          deleteWorkspaceAnonymizationAllowlistEntry.handler,
        ),
  )
  .group(
    "/:workspaceId",
    {
      params: workspaceParams({}),
      schema: "merge",
      validateWorkspaceAccess: true,
    },
    (app) =>
      app
        .get(
          "/correspondence",
          {
            permissions: listCorrespondence.config.permissions,
            query: listCorrespondence.config.query,
          },
          listCorrespondence.handler,
        )
        .get(
          "/correspondence/address",
          {
            permissions: getMatterInboundAddress.config.permissions,
          },
          getMatterInboundAddress.handler,
        )
        .post(
          "/correspondence/address",
          {
            permissions: createMatterInboundAddress.config.permissions,
          },
          createMatterInboundAddress.handler,
        )
        .delete(
          "/correspondence/address",
          {
            permissions: deleteMatterInboundAddress.config.permissions,
          },
          deleteMatterInboundAddress.handler,
        )
        .get(
          "/correspondence/:correspondenceId",
          {
            permissions: getCorrespondence.config.permissions,
            params: getCorrespondence.config.params,
          },
          getCorrespondence.handler,
        )
        .patch(
          "/correspondence/:correspondenceId",
          {
            permissions: updateCorrespondence.config.permissions,
            params: updateCorrespondence.config.params,
            body: updateCorrespondence.config.body,
          },
          updateCorrespondence.handler,
        )
        .get(
          "/members",
          {
            permissions: readWorkspaceMembers.config.permissions,
          },
          readWorkspaceMembers.handler,
        )
        .put(
          "/members",
          {
            body: addWorkspaceMember.config.body,
            permissions: addWorkspaceMember.config.permissions,
          },
          addWorkspaceMember.handler,
        )
        .delete(
          "/members/:userId",
          {
            body: removeWorkspaceMember.config.body,
            params: removeWorkspaceMember.config.params,
            permissions: removeWorkspaceMember.config.permissions,
          },
          removeWorkspaceMember.handler,
        ),
  )
  .post(
    "/:workspaceId/unarchive",
    {
      permissions: unarchiveWorkspace.config.permissions,
      validateWorkspaceAccessIncludingArchived: true,
    },
    unarchiveWorkspace.handler,
  );
