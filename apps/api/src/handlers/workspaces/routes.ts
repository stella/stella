import { Result } from "better-result";
import * as v from "valibot";

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
import readVocabulary from "@/api/handlers/workspaces/vocabulary/get";
import readWorkflow from "@/api/handlers/workspaces/workflow/get";
import workflowStart from "@/api/handlers/workspaces/workflow/start";
import workflowTargetCount from "@/api/handlers/workspaces/workflow/targets/count";
import { readWorkspaceContactsHandler } from "@/api/handlers/workspaces/workspace-contacts-read";
import { readWorkspaceMembersHandler } from "@/api/handlers/workspaces/workspace-members-read";
import { mount, routes } from "@/api/http/route";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";

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
    query: v.object({}),
  } satisfies WorkspaceHandlerConfig,
  async function* ({ safeDb, workspaceId }) {
    const response = yield* Result.await(
      readOverviewHandler({
        workspaceId,
        safeDb,
      }),
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

export const workspacesRoute = mount(
  [
    routes({
      "/": { GET: readWorkspaces, PUT: createWorkspaces },
      "/member-previews": { GET: listWorkspaceMemberPreviews },
      "/navigation": { GET: readWorkspaceNavigation },
      "/active": { GET: readActiveWorkspace },
    }),
    routes(
      {
        "/": {
          GET: readWorkspace,
          POST: updateWorkspace,
          DELETE: deleteWorkspace,
        },
        "/vocabulary": { GET: readVocabulary },
        "/workflow": { GET: readWorkflow },
        "/workflow/start": { POST: workflowStart },
        "/workflow/target-count": { POST: workflowTargetCount },
        "/cell-retry": { POST: cellRetry },
        "/justifications/query": { POST: readJustifications },
        "/bounding-boxes": { POST: generateBoundingBoxes },
        "/infosoud/courts": { GET: infosoudCourts },
        "/infosoud/lookup": { POST: infosoudLookup },
        "/infosoud/import-agenda": { POST: infosoudImportAgenda },
        "/activity": { GET: readWorkspaceActivity },
        "/overview": { GET: readOverview },
        "/search-preview": { GET: readSearchPreview },
        "/correspondence/drops": { GET: listCorrespondenceDrops },
        "/overview/activity": { GET: readOverviewActivity },
        "/overview/activity/actors": { GET: readOverviewActivityActors },
        "/overview/activity/export": { GET: exportOverviewActivity },
        "/duplicate": { POST: duplicateWorkspace },
        "/active": { POST: updateActiveWorkspace },
        "/archive": { POST: archiveWorkspace },
        "/contacts": {
          GET: readWorkspaceContacts,
          PUT: createWorkspaceContact,
        },
        "/contacts/:workspaceContactId": { DELETE: deleteWorkspaceContact },
        "/anonymization-terms": {
          GET: readWorkspaceAnonymizationTerms,
          PUT: createWorkspaceAnonymizationTerms,
        },
        "/anonymization-terms/:entryId": {
          DELETE: deleteWorkspaceAnonymizationTerm,
        },
        "/anonymization-allowlist": {
          GET: readWorkspaceAnonymizationAllowlist,
          PUT: createWorkspaceAnonymizationAllowlistEntry,
        },
        "/anonymization-allowlist/:entryId": {
          DELETE: deleteWorkspaceAnonymizationAllowlistEntry,
        },
        "/correspondence": { GET: listCorrespondence },
        "/correspondence/address": {
          GET: getMatterInboundAddress,
          POST: createMatterInboundAddress,
          DELETE: deleteMatterInboundAddress,
        },
        "/correspondence/:correspondenceId": {
          GET: getCorrespondence,
          PATCH: updateCorrespondence,
        },
        "/members": { GET: readWorkspaceMembers, PUT: addWorkspaceMember },
        "/members/:userId": { DELETE: removeWorkspaceMember },
      },
      { prefix: "/:workspaceId" },
    ),
    routes({
      "/:workspaceId/unarchive": { POST: unarchiveWorkspace },
    }),
  ],
  { prefix: "/workspaces" },
);
