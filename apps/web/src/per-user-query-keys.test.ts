import { QueryClient, type QueryKey, skipToken } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import { repoRelativePath } from "@stll/portable-path";
import { type Node, parseSource, walk } from "@stll/scripts/src/syntax-tree";

import { savedTimeNarrativesKeys } from "@/components/billing/saved-time-narratives";
import { companyFormatKeys } from "@/components/company-format-library";
import { readerAnnotationKeys } from "@/components/legal-reader/annotations/reader-annotations-query";
import { documentAnnotationKeys } from "@/components/pdf/annotations/document-annotations-query";
import { savedSearchKeys } from "@/components/saved-searches.logic";
import { claimCommentKeys } from "@/features/avt/claim-comments-query";
import { readerAnswersOptions } from "@/features/case-law/components/case-viewer/reader-answers-query";
import { browserSiteGrantsOptions } from "@/features/chat/browser-control/browser-site-grants";
import { chatLimitReminderOptions } from "@/features/chat/chat-limit-reminder";
import { chatKeys } from "@/features/chat/chat-query-contract";
import { chatToolGrantsOptions } from "@/features/chat/chat-tool-grants";
import { desktopPresenceOptions } from "@/features/desktop/desktop-presence";
import { lawHistoryKeys } from "@/features/law-search-history/law-search-history-query";
import {
  sharepointAccessOptions,
  sharepointChildrenOptions,
  sharepointDrivesOptions,
  sharepointSitesOptions,
} from "@/features/sharepoint/sharepoint-queries";
import { timeTimersOptions } from "@/features/time-timers/queries";
import { accountDataExportLatestOptions } from "@/lib/account/account-data-export-queries";
import {
  linkedAccountsOptions,
  pendingDeletionTasksOptions,
  sessionsOptions,
} from "@/lib/account/queries";
import { professionalUseOptions } from "@/lib/auth-queries";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { inboxCountOptions } from "@/lib/inbox/queries";
import {
  chatUnavailableSkillsOptions,
  mcpConnectionsOptions,
  recentPlaybooksOptions,
  skillDetailOptions,
  skillsOptions,
} from "@/lib/knowledge/queries";
import { catalogueOptions } from "@/lib/knowledge/queries/catalogue";
import { notificationsOptions } from "@/lib/notification-queries";
import { organizationAuditExportLatestOptions } from "@/lib/organization/audit-export-queries";
import { organizationListOptions } from "@/lib/organization/queries";
import {
  searchFacetOptions,
  searchInfiniteOptions,
  searchPreviewOptions,
} from "@/lib/search";
import { usageLaneOptions } from "@/lib/usage-queries";
import {
  DEFAULT_MATTER_ACTIVITY_FILTERS,
  overviewActivityOptions,
  workspacesNavigationOptions,
} from "@/lib/workspaces/queries";
import { workspacesKeys } from "@/lib/workspaces/queries.logic";
import {
  entityViewKeys,
  entityViewsOptions,
} from "@/lib/workspaces/queries/entity-views";
import {
  legalListActivityOptions,
  legalListItemsOptions,
  legalListKeys,
  legalListSourcesOptions,
} from "@/lib/workspaces/queries/legal-lists";
import { myTimeEntriesInfiniteOptions } from "@/lib/workspaces/queries/my-time-entries";
import { myTimeSuggestionsOptions } from "@/lib/workspaces/queries/my-time-suggestions";
import { reportExportsKeys } from "@/lib/workspaces/queries/report-exports";
import {
  timeApprovalPendingOptions,
  timeApprovalQueueOptions,
} from "@/lib/workspaces/queries/time-approvals";
import { timeEntriesKeys } from "@/lib/workspaces/queries/time-entries";
import { viewTemplateKeys } from "@/lib/workspaces/queries/view-templates";
import { workspaceMemberPreviewsOptions } from "@/lib/workspaces/queries/workspace-member-previews";
import { featureEnrolmentsOptions } from "@/queries/feature-enrolments";
import {
  optionalOrganizationSettingsOptions,
  organizationSettingsOptions,
} from "@/queries/organization-settings";
import { connectedAppsOptions } from "@/routes/_protected.settings/-queries/connections";
import { memoriesKeys } from "@/routes/_protected.settings/-queries/memories";
import { memoryMattersOptions } from "@/routes/_protected.settings/-queries/memory-matters";
import { auditLogOptions } from "@/routes/_protected.settings/organization/-queries/audit-logs";
import { timeReportOptions } from "@/routes/_protected.time_.report/-components/report-query";

import { API_CLIENT_REQUEST_METHODS } from "../../../.oxlint-plugins/api-client-chain";

// API reads that answer for the signed-in user are cached under a key that
// names that user. The manifests below list every such read:
// - a new read endpoint (a GET route, a read POST, or a read-named handler)
//   that refers to the caller fails here until it is classified, and so does a
//   new auth-client list/get call;
// - a web module that starts calling a listed read fails until it is listed;
// - every query in a listed module that reaches a listed read must name the
//   user in its key, and the listed key factories are run to prove it.
const WEB_SOURCE = import.meta.dirname;
const API_SOURCE = nodePath.join(WEB_SOURCE, "../../api/src");
const API_HANDLERS = nodePath.join(API_SOURCE, "handlers");
const TEST_FILE_PATTERN = /\.(?:test|spec)\.tsx?$/u;

const ORG = "org-probe";
const USER = "user-probe";
const WORKSPACE = "workspace-probe";

type PerUserRead =
  // Cached by the web under a key checked here to carry the user id.
  | {
      kind: "keyed";
      calls: string[];
      files: string[];
      keys: () => QueryKey[];
      // Key expressions that carry the user inside an argument the source
      // scan cannot see into, each checked by one of `keys` above.
      opaqueKeys?: Record<string, string>;
    }
  // Cached under an id that only its owner can read.
  | { kind: "owned-id"; reason: string }
  // The session or role itself; the cache is dropped when it changes.
  | { kind: "session"; reason: string }
  // Rows shared by every member, with the caller's own marked (an open edit
  // session, say). Kept under the shared key; the whole cache is dropped when
  // the signed-in user changes.
  | { kind: "caller-marker"; reason: string }
  // Not called by the web today.
  | { kind: "no-web-caller"; calls: string[] }
  // Matched by the scan but not a per-user read.
  | { kind: "not-per-user"; reason: string };

const OWNED_THREAD = "cached under the thread id; threads are owner-filtered";
const OWNED_FILE = "served by URL, not cached; files are owner-filtered";
const WRITE = "a write, not cached";
const JOINS_NAMES = "joins member names; not filtered by the caller";
const USAGE_ONLY = "the caller is recorded for usage only";
const DOWNLOAD = "a file download, not cached";
const OAUTH_REDIRECT = "an OAuth redirect, not cached";
const OWN_EDIT_SESSION = "marks the caller's own open edit session";
const KEY_TYPE_HAS_USER = "the key argument's type requires userId";
const READ_FRESH = "read fresh at each use, never cached";
const SHAREPOINT_QUERIES = "features/sharepoint/sharepoint-queries.ts";
const SHAREPOINT_VIEWER = { organizationId: ORG, userId: USER };

const SEARCH_PROBE = {
  editedByUserIds: [],
  enabled: true,
  kinds: [],
  mimeTypes: [],
  organizationId: ORG,
  query: "query",
  types: [],
  userId: USER,
  workspaceIds: [],
};

// Keyed by handler path under apps/api/src/handlers.
const PER_USER_READS: Record<string, PerUserRead> = {
  "account-exports/download.ts": { kind: "not-per-user", reason: DOWNLOAD },
  "account-exports/download/get.ts": { kind: "no-web-caller", calls: [] },
  "account-exports/get.ts": {
    kind: "keyed",
    calls: ['api.me["data-exports"].get'],
    files: ["lib/account/account-data-export-queries.ts"],
    keys: () => [accountDataExportLatestOptions(USER).queryKey],
  },
  "account-exports/status/get.ts": { kind: "no-web-caller", calls: [] },
  "organizations/audit-export/get.ts": {
    kind: "keyed",
    calls: ['api.organizations["audit-export"].get'],
    files: ["lib/organization/audit-export-queries.ts"],
    keys: () => [organizationAuditExportLatestOptions(ORG, USER).queryKey],
  },
  "files/thumbnail.ts": { kind: "owned-id", reason: OWNED_FILE },
  "search-history/list.ts": {
    kind: "keyed",
    calls: ['api["search-history"].get'],
    files: ["features/law-search-history/law-search-history-query.ts"],
    keys: () => [
      lawHistoryKeys.list({
        scope: { organizationId: ORG, userId: USER },
        filter: "all",
        country: "CZE",
      }),
    ],
    opaqueKeys: {
      "lawHistoryKeys.list({ scope: scope ?? keyScope, filter, country, })":
        KEY_TYPE_HAS_USER,
    },
  },
  // The caller-bound clock anchor is fetched inside the import query and
  // spent by the import write; it is never cached on its own.
  "search-history/import-clock.ts": {
    kind: "keyed",
    calls: ['api["search-history"]["import-clock"].get'],
    files: ["features/law-search-history/law-search-history-query.ts"],
    keys: () => [lawHistoryKeys.import({ organizationId: ORG, userId: USER })],
    opaqueKeys: {
      "lawHistoryKeys.import(scope ?? keyScope)": KEY_TYPE_HAS_USER,
    },
  },
  "organization-settings/feature-access/get.ts": {
    kind: "no-web-caller",
    calls: ['api["organization-settings"]["feature-access"].get'],
  },
  "desktop-presence/read.ts": {
    kind: "keyed",
    calls: ["api.desktop.presence.get"],
    files: ["features/desktop/desktop-presence.ts"],
    keys: () => [
      desktopPresenceOptions({ userId: USER, organizationId: ORG }).queryKey,
    ],
    opaqueKeys: { "desktopPresenceKeys.all(key)": KEY_TYPE_HAS_USER },
  },
  "views/list.ts": {
    kind: "caller-marker",
    reason:
      "Shared view identities carry caller eligibility; session-cache-guard clears them on member changes.",
  },

  "workspaces/read-navigation.ts": {
    kind: "keyed",
    calls: ["api.workspaces.navigation.get", "fetchWorkspaceNavigationPage"],
    files: [
      "lib/memory-api.ts",
      "lib/workspaces/queries.ts",
      "routes/_protected.settings/-queries/memory-matters.ts",
    ],
    keys: () => [
      workspacesNavigationOptions({ organizationId: ORG, userId: USER })
        .queryKey,
      memoryMattersOptions({ organizationId: ORG, userId: USER }).queryKey,
    ],
    opaqueKeys: {
      "workspacesKeys.navigation(caller)": KEY_TYPE_HAS_USER,
      "memoryMatterKeys.all(caller)": KEY_TYPE_HAS_USER,
    },
  },
  "api-keys/personal/list.ts": {
    kind: "no-web-caller",
    calls: ['api["api-keys"].personal.get'],
  },
  "chat/messages/revisions/list.ts": {
    kind: "no-web-caller",
    calls: [],
  },
  "organization-settings/get.ts": {
    kind: "keyed",
    calls: ['api["organization-settings"].get'],
    files: ["queries/organization-settings.ts"],
    keys: () => [
      organizationSettingsOptions({ organizationId: ORG, userId: USER })
        .queryKey,
      optionalOrganizationSettingsOptions({ organizationId: ORG, userId: USER })
        .queryKey,
      optionalOrganizationSettingsOptions({
        organizationId: null,
        userId: USER,
      }).queryKey,
    ],
  },
  "organization-settings/feature-enrolments/get.ts": {
    kind: "keyed",
    calls: ['api["organization-settings"]["feature-enrolments"].get'],
    files: ["queries/feature-enrolments.ts"],
    keys: () => [
      featureEnrolmentsOptions({ organizationId: ORG, userId: USER }).queryKey,
    ],
  },
  "audit-logs/export.ts": { kind: "not-per-user", reason: DOWNLOAD },
  "audit-logs/list.ts": {
    kind: "keyed",
    calls: ['api["audit-logs"].get'],
    files: ["routes/_protected.settings/organization/-queries/audit-logs.ts"],
    keys: () => [
      auditLogOptions({
        viewer: { userId: USER, organizationId: ORG },
        key: {},
      }).queryKey,
    ],
    opaqueKeys: { "auditLogKeys.filtered(viewer, key)": KEY_TYPE_HAS_USER },
  },
  "lists/verifications/get.ts": {
    kind: "not-per-user",
    reason:
      "The actor determines the read-audit receipt; returned run content is shared within the matter.",
  },
  "lists/verifications/graph/get.ts": {
    kind: "not-per-user",
    reason:
      "The actor determines the read-audit receipts; the returned graph is shared within the matter.",
  },
  "lists/verifications/chronology/export.ts": {
    kind: "not-per-user",
    reason: DOWNLOAD,
  },
  "lists/graph/nodes/list.ts": {
    kind: "not-per-user",
    reason:
      "The actor determines the read-audit receipt; the matter's graph is shared within the matter.",
  },
  "lists/graph/neighbours/list.ts": {
    kind: "not-per-user",
    reason:
      "The actor determines the read-audit receipt; the matter's graph is shared within the matter.",
  },
  "lists/graph/paths/list.ts": {
    kind: "not-per-user",
    reason:
      "The actor determines the read-audit receipt; the matter's graph is shared within the matter.",
  },
  "case-law/analysis/generate.ts": { kind: "not-per-user", reason: USAGE_ONLY },
  "catalogue/list.ts": {
    kind: "keyed",
    calls: ["api.catalogue.get"],
    files: ["lib/knowledge/queries/catalogue.ts"],
    keys: () => [catalogueOptions(ORG, USER).queryKey],
  },
  "chat/link-icons/get.ts": {
    kind: "not-per-user",
    reason:
      "Public site icons are shared by hostname; the caller is used only for miss admission.",
  },
  "chat/link-icons/get-exact.ts": {
    kind: "not-per-user",
    reason:
      "Public icon bytes are shared by exact URL; the caller is used only for miss admission.",
  },
  "chat/get-suggested-prompts.ts": { kind: "owned-id", reason: OWNED_THREAD },
  "chat/get-thread-recap.ts": { kind: "owned-id", reason: OWNED_THREAD },
  "chat/get-thread-title.ts": { kind: "owned-id", reason: OWNED_THREAD },
  "chat/messages/list.ts": { kind: "owned-id", reason: OWNED_THREAD },
  "chat/messages/get.ts": { kind: "owned-id", reason: OWNED_THREAD },
  "chat/messages/revisions/span-edit.ts": {
    kind: "owned-id",
    reason:
      "An uncached rewrite proposal; its thread lookup is owner-filtered.",
  },
  "chat/older-messages/list.ts": { kind: "owned-id", reason: OWNED_THREAD },
  "chat/queue/read-message.ts": { kind: "owned-id", reason: OWNED_THREAD },
  "chat/queue/read.ts": { kind: "owned-id", reason: OWNED_THREAD },
  "chat/read-file-thread.ts": {
    kind: "keyed",
    calls: ['api.chat.workspaces()["file-thread"].get'],
    files: ["features/chat/queries.ts"],
    keys: () => [
      chatKeys.fileThread(ORG, {
        entityId: "entity",
        fieldId: "field",
        userId: USER,
        workspaceId: WORKSPACE,
      }),
    ],
    opaqueKeys: {
      "chatKeys.fileThread(activeOrganizationId, key)": KEY_TYPE_HAS_USER,
    },
  },
  "chat/resolve-file-thread.ts": {
    kind: "keyed",
    calls: ['api.chat.workspaces()["file-thread"].post'],
    files: ["features/chat/queries.ts"],
    keys: () => [
      chatKeys.fileThread(ORG, {
        entityId: "entity",
        fieldId: "field",
        userId: USER,
        workspaceId: WORKSPACE,
      }),
    ],
    opaqueKeys: {
      "chatKeys.fileThread(activeOrganizationId, key)": KEY_TYPE_HAS_USER,
    },
  },
  "chat/resolve-template-thread.ts": {
    kind: "keyed",
    calls: ['api.chat["template-thread"].post'],
    files: ["features/chat/queries.ts"],
    keys: () => [
      chatKeys.templateThread(ORG, { templateId: "template", userId: USER }),
    ],
    opaqueKeys: {
      "chatKeys.templateThread(activeOrganizationId, key)": KEY_TYPE_HAS_USER,
    },
  },
  "chat/saved-secret.ts": { kind: "owned-id", reason: OWNED_THREAD },
  "chat/tool-grants/list.ts": {
    kind: "keyed",
    calls: ['api.chat["tool-grants"].get'],
    files: ["features/chat/chat-tool-grants.ts"],
    keys: () => [
      chatToolGrantsOptions({
        activeOrganizationId: ORG,
        threadId: "thread",
        userId: USER,
      }).queryKey,
    ],
  },
  "chat/tool-grants/coverage.ts": { kind: "not-per-user", reason: READ_FRESH },
  "chat/limit-reminder/get.ts": {
    kind: "keyed",
    calls: ['api.chat.threads()["limit-reminder"].get'],
    files: ["features/chat/chat-limit-reminder.ts"],
    keys: () => [
      chatLimitReminderOptions({
        activeOrganizationId: ORG,
        threadRef: { scope: "global", threadId: toChatThreadId("thread") },
        userId: USER,
      }).queryKey,
    ],
  },
  "chat/browser-site-grants/list.ts": {
    kind: "keyed",
    calls: ['api.chat["browser-site-grants"].get'],
    files: ["features/chat/browser-control/browser-site-grants.ts"],
    keys: () => [
      browserSiteGrantsOptions({
        activeOrganizationId: ORG,
        userId: USER,
      }).queryKey,
    ],
  },
  "chat/skill-availability/list.ts": {
    kind: "keyed",
    calls: ['api.chat["skill-availability"].get'],
    files: ["lib/knowledge/queries.ts"],
    keys: () => [chatUnavailableSkillsOptions(ORG, USER).queryKey],
  },
  "chat/decision-threads/get.ts": {
    kind: "keyed",
    calls: ['api.chat["decision-threads"]().get'],
    files: ["features/chat/queries.ts"],
    keys: () => [
      chatKeys.decisionThread(ORG, { decisionId: "decision", userId: USER }),
    ],
    opaqueKeys: {
      "chatKeys.decisionThread(activeOrganizationId, key)": KEY_TYPE_HAS_USER,
    },
  },
  "chat/runs/list.ts": {
    kind: "keyed",
    calls: ["api.chat.runs.active.get"],
    files: ["features/chat/active-runs.ts"],
    keys: () => [chatKeys.activeRuns(ORG, USER)],
  },
  "chat/threads/list.ts": {
    kind: "keyed",
    calls: ["api.chat.threads.get"],
    files: ["features/chat/queries.ts"],
    keys: () => [
      chatKeys.groupedThreads({ activeOrganizationId: ORG, userId: USER }),
    ],
  },
  "document-reviews/parties.ts": { kind: "not-per-user", reason: USAGE_ONLY },
  "document-reviews/propose-positions-stream.ts": {
    kind: "not-per-user",
    reason: USAGE_ONLY,
  },
  "document-reviews/propose-positions.ts": {
    kind: "not-per-user",
    reason: USAGE_ONLY,
  },
  "docx-suggestions/resolve.ts": { kind: "not-per-user", reason: WRITE },
  "entities/filesystem-tree/get.ts": {
    kind: "caller-marker",
    reason: OWN_EDIT_SESSION,
  },
  "entities/list.ts": { kind: "caller-marker", reason: OWN_EDIT_SESSION },
  "entities/read-kanban-group.ts": {
    kind: "caller-marker",
    reason: OWN_EDIT_SESSION,
  },
  "entities/window/list.ts": {
    kind: "caller-marker",
    reason: OWN_EDIT_SESSION,
  },
  "entity-views/list.ts": {
    kind: "keyed",
    calls: ['api["entity-views"].get'],
    files: ["lib/workspaces/queries/entity-views.ts"],
    keys: () => [entityViewsOptions(ORG, USER).queryKey],
  },
  "entity-views/rows/list.ts": {
    kind: "keyed",
    calls: ['api["entity-views"]["query-window"].post'],
    files: ["lib/workspaces/queries/entity-views.ts"],
    keys: () => [entityViewKeys.all(ORG, USER)],
  },
  "expenses/list.ts": { kind: "not-per-user", reason: JOINS_NAMES },
  "legal-reader/annotations/list.ts": {
    kind: "keyed",
    calls: ["api.reader.annotations.get"],
    files: ["components/legal-reader/annotations/reader-annotations-query.ts"],
    keys: () => [
      readerAnnotationKeys.forTarget({
        activeOrganizationId: ORG,
        targetId: "target",
        targetType: "decision",
        userId: USER,
      }),
    ],
    opaqueKeys: { "readerAnnotationKeys.forTarget(key)": KEY_TYPE_HAS_USER },
  },
  "legal-reader/answers/list.ts": {
    kind: "keyed",
    calls: ["api.reader.answers.get"],
    files: ["features/case-law/components/case-viewer/reader-answers-query.ts"],
    keys: () => [
      readerAnswersOptions({
        organizationId: ORG,
        userId: USER,
        decisionId: "decision",
      }).queryKey,
    ],
  },
  "lists/verifications/claim-comments/list.ts": {
    kind: "keyed",
    calls: ['api.lists()["claim-comments"].get'],
    files: ["features/avt/claim-comments-query.ts"],
    keys: () => [
      claimCommentKeys.forClaim({
        claimId: "claim-probe",
        runId: "run-probe",
        viewer: { organizationId: ORG, userId: USER },
        workspaceId: WORKSPACE,
      }),
    ],
    opaqueKeys: { "claimCommentKeys.forClaim(key)": KEY_TYPE_HAS_USER },
  },
  "entities/annotations/list.ts": {
    kind: "keyed",
    calls: ["api.entities().entity().field().annotations.get"],
    files: ["components/pdf/annotations/document-annotations-query.ts"],
    keys: () => [
      documentAnnotationKeys.forFile({
        entityId: "entity-probe",
        fieldId: "field-probe",
        viewer: { organizationId: ORG, userId: USER },
        workspaceId: WORKSPACE,
      }),
    ],
    opaqueKeys: { "documentAnnotationKeys.forFile(key)": KEY_TYPE_HAS_USER },
  },
  "lists/items/list.ts": {
    kind: "keyed",
    calls: ["api.lists()().items.get"],
    files: ["lib/workspaces/queries/legal-lists.ts"],
    keys: () => [
      legalListItemsOptions({
        workspaceId: WORKSPACE,
        listId: "list-probe",
        viewer: { userId: USER, organizationId: ORG },
      }).queryKey,
    ],
  },
  "lists/items/activity/list.ts": {
    kind: "keyed",
    calls: ["api.lists()().items().activity.get"],
    files: ["lib/workspaces/queries/legal-lists.ts"],
    keys: () => [
      legalListActivityOptions({
        workspaceId: WORKSPACE,
        listId: "list-probe",
        itemEntityId: "item-probe",
        viewer: { userId: USER, organizationId: ORG },
      }).queryKey,
    ],
  },
  "lists/items/sources/list.ts": {
    kind: "keyed",
    calls: ["api.lists()().items().sources.get"],
    files: ["lib/workspaces/queries/legal-lists.ts"],
    keys: () => [
      legalListSourcesOptions({
        workspaceId: WORKSPACE,
        listId: "list-probe",
        itemEntityId: "item-probe",
        viewer: { userId: USER, organizationId: ORG },
      }).queryKey,
    ],
  },
  "mcp-connectors/list-connections.ts": {
    kind: "keyed",
    calls: ["api.mcp.connections.get"],
    files: ["lib/knowledge/queries.ts"],
    keys: () => [mcpConnectionsOptions(ORG, USER).queryKey],
  },
  "mcp-connectors/oauth-callback.ts": {
    kind: "not-per-user",
    reason: OAUTH_REDIRECT,
  },
  "me/list-oauth-connections.ts": {
    kind: "keyed",
    calls: ['api.me["oauth-connections"].get'],
    files: ["routes/_protected.settings/-queries/connections.ts"],
    keys: () => [connectedAppsOptions(USER).queryKey],
  },
  "me/professional-use.ts": {
    kind: "keyed",
    calls: ['api.me["professional-use"].get'],
    files: ["lib/auth-queries.ts"],
    keys: () => [professionalUseOptions(USER).queryKey],
  },
  "me/pending-tasks.ts": {
    kind: "keyed",
    calls: ['api.me.delete["pending-tasks"].get'],
    files: ["lib/account/queries.ts"],
    keys: () => [pendingDeletionTasksOptions(USER).queryKey],
  },
  // Filtered by row-level security rather than in the handler.
  "memories/list.ts": {
    kind: "keyed",
    calls: ["api.memories.get", "fetchMemoriesPage"],
    files: [
      "lib/memory-api.ts",
      "routes/_protected.settings/-queries/memories.ts",
    ],
    keys: () => [
      memoriesKeys.list({ activeOrganizationId: ORG, userId: USER }),
    ],
  },
  "notifications/list.ts": {
    kind: "keyed",
    calls: ["api.notifications.get"],
    files: ["lib/notification-queries.ts"],
    keys: () => [
      notificationsOptions({ organizationId: ORG, userId: USER }).queryKey,
    ],
  },
  "notifications/read-all.ts": { kind: "not-per-user", reason: WRITE },
  "notifications/read-state/update.ts": { kind: "not-per-user", reason: WRITE },
  "playbooks/recent/list.ts": {
    kind: "keyed",
    calls: ["api.playbooks.recent.get"],
    files: ["lib/knowledge/queries.ts"],
    keys: () => [recentPlaybooksOptions(ORG, USER).queryKey],
  },
  "rates/entries/list.ts": { kind: "not-per-user", reason: JOINS_NAMES },
  "reports/exports/get.ts": {
    kind: "keyed",
    calls: ["api.workspaces().reports().get"],
    files: [
      "lib/workspaces/queries/report-exports.ts",
      "routes/_protected.workspaces/$workspaceId/reports/$exportId.tsx",
    ],
    keys: () => [
      reportExportsKeys.detail({
        exportId: "export",
        userId: USER,
        workspaceId: WORKSPACE,
      }),
    ],
    opaqueKeys: { "reportExportsKeys.detail(key)": KEY_TYPE_HAS_USER },
  },
  "reports/exports/list.ts": {
    kind: "keyed",
    calls: ["api.workspaces().reports.get"],
    files: ["lib/workspaces/queries/report-exports.ts"],
    keys: () => [
      reportExportsKeys.history({
        limit: 1,
        userId: USER,
        workspaceId: WORKSPACE,
      }),
    ],
    opaqueKeys: { "reportExportsKeys.history(key)": KEY_TYPE_HAS_USER },
  },
  "saved-searches/list.ts": {
    kind: "keyed",
    calls: ['api["saved-searches"].get'],
    files: ["components/saved-searches.tsx"],
    keys: () => [savedSearchKeys.list({ organizationId: ORG, userId: USER })],
  },
  "saved-time-narratives/list.ts": {
    kind: "keyed",
    calls: ['api["saved-time-narratives"].get'],
    files: ["components/billing/saved-time-narratives.tsx"],
    keys: () => [savedTimeNarrativesKeys.list(ORG, USER)],
  },
  "search/preview.ts": {
    kind: "keyed",
    calls: ["api.search.preview.post"],
    files: ["lib/search.ts"],
    keys: () => [
      searchPreviewOptions({
        organizationId: ORG,
        query: "query",
        resultId: "result",
        type: "matter",
        updatedAt: "2026-01-01T00:00:00Z",
        userId: USER,
      }).queryKey,
    ],
  },
  // Facet buckets count only the matters and result types the caller may see.
  "search/facets/list.ts": {
    kind: "keyed",
    calls: ["api.search.facets.post"],
    files: ["lib/search.ts"],
    opaqueKeys: { "searchKeys.facet(params)": KEY_TYPE_HAS_USER },
    keys: () => [
      searchFacetOptions({ ...SEARCH_PROBE, facet: "workspace", search: "" })
        .queryKey,
    ],
  },
  "search/results/list.ts": {
    kind: "keyed",
    calls: ["api.search.post"],
    files: ["lib/search.ts"],
    opaqueKeys: { "searchKeys.query(params)": KEY_TYPE_HAS_USER },
    keys: () => [searchInfiniteOptions(SEARCH_PROBE).queryKey],
  },
  "sharepoint/drives/items/list.ts": {
    kind: "keyed",
    calls: ["api.sharepoint.drives().items().children.get"],
    files: [SHAREPOINT_QUERIES],
    keys: () => [
      sharepointChildrenOptions(SHAREPOINT_VIEWER, {
        driveId: "drive-probe",
        folderId: null,
      }).queryKey,
    ],
  },
  "sharepoint/drives/list.ts": {
    kind: "keyed",
    calls: ["api.sharepoint.drives.get"],
    files: [SHAREPOINT_QUERIES],
    keys: () => [sharepointDrivesOptions(SHAREPOINT_VIEWER, null).queryKey],
  },
  "sharepoint/oauth-callback.ts": {
    kind: "not-per-user",
    reason: OAUTH_REDIRECT,
  },
  "sharepoint/sites/list.ts": {
    kind: "keyed",
    calls: ["api.sharepoint.sites.get"],
    files: [SHAREPOINT_QUERIES],
    keys: () => [sharepointSitesOptions(SHAREPOINT_VIEWER, "").queryKey],
  },
  "sharepoint/status.ts": {
    kind: "keyed",
    calls: ["api.sharepoint.connection.get"],
    files: [SHAREPOINT_QUERIES],
    keys: () => [sharepointAccessOptions(SHAREPOINT_VIEWER).queryKey],
  },
  "signals/count.ts": {
    kind: "keyed",
    calls: ["api.signals.count.get"],
    files: ["lib/inbox/queries.ts"],
    keys: () => [inboxCountOptions(ORG, USER).queryKey],
  },
  "signals/list.ts": { kind: "no-web-caller", calls: ["api.signals.get"] },
  "skills/commands/list.ts": {
    kind: "no-web-caller",
    calls: ["api.skills.commands.get"],
  },
  "skills/get.ts": {
    kind: "keyed",
    calls: ["api.skills().get"],
    files: ["lib/knowledge/queries.ts"],
    keys: () => [skillDetailOptions(ORG, USER, "skill").queryKey],
  },
  "skills/list.ts": {
    kind: "keyed",
    calls: ["api.skills.get"],
    files: ["lib/knowledge/queries.ts"],
    keys: () => [skillsOptions(ORG, USER).queryKey],
  },
  "tasks/list.ts": { kind: "no-web-caller", calls: ["api.tasks.get"] },
  "templates/condition-decisions/get.ts": {
    kind: "not-per-user",
    reason: "the caller is recorded for usage only",
  },
  "templates/get.ts": { kind: "owned-id", reason: DOWNLOAD },
  "templates/fills/preview.ts": { kind: "not-per-user", reason: USAGE_ONLY },
  "templates/list.ts": { kind: "not-per-user", reason: JOINS_NAMES },
  "templates/lookup-formats/list.ts": {
    kind: "keyed",
    calls: ['api.templates["lookup-formats"].get'],
    files: ["components/company-format-library.tsx"],
    keys: () => [
      companyFormatKeys.list({
        organizationId: ORG,
        registry: "ares",
        userId: USER,
      }),
    ],
  },
  "templates/versions/get.ts": { kind: "owned-id", reason: DOWNLOAD },
  "style-sets/download.ts": { kind: "owned-id", reason: DOWNLOAD },
  "time-entries/get.ts": { kind: "not-per-user", reason: JOINS_NAMES },
  "time-entries/list.ts": {
    kind: "keyed",
    calls: ["fetchTimeEntries"],
    files: ["lib/workspaces/queries/time-entries.ts"],
    keys: () => [timeEntriesKeys.list(WORKSPACE, USER, {})],
  },
  "time-entries/approval-queue/list.ts": {
    kind: "keyed",
    calls: ['api["time-entries"]["approval-queue"].get'],
    files: ["lib/workspaces/queries/time-approvals.ts"],
    keys: () => [
      timeApprovalQueueOptions(ORG, USER, {}).queryKey,
      timeApprovalPendingOptions(ORG, USER).queryKey,
    ],
  },
  "time-entries/report/get.ts": {
    kind: "keyed",
    calls: ['api["time-entries"].report.get'],
    files: ["routes/_protected.time_.report/-components/report-query.ts"],
    keys: () => [
      timeReportOptions(ORG, USER, {
        bucket: "day",
        from: "2026-10-26",
        groupBy: "member",
        to: "2026-11-01",
      }).queryKey,
    ],
  },
  "time-entries/me/list.ts": {
    kind: "keyed",
    calls: ['api["time-entries"].me.get'],
    files: ["lib/workspaces/queries/my-time-entries.ts"],
    keys: () => [
      myTimeEntriesInfiniteOptions(ORG, USER, {
        startDate: "2026-01-05",
        endDate: "2026-01-11",
      }).queryKey,
    ],
  },
  "time-entries/me/suggestions/list.ts": {
    kind: "keyed",
    calls: ['api["time-entries"].me.suggestions.get'],
    files: ["lib/workspaces/queries/my-time-suggestions.ts"],
    keys: () => [
      myTimeSuggestionsOptions(ORG, USER, {
        startDate: "2026-01-05",
        endDate: "2026-01-11",
        timezoneId: "UTC",
      }).queryKey,
    ],
  },
  "time-entries/suggestions/list.ts": {
    kind: "keyed",
    calls: ["fetchTimeEntrySuggestions"],
    files: ["lib/workspaces/queries/time-entries.ts"],
    keys: () => [
      timeEntriesKeys.suggestions(WORKSPACE, USER, "2026-01-01", "UTC"),
    ],
  },
  "time-entries/summary/get.ts": {
    kind: "keyed",
    calls: ["fetchTimeEntrySummary"],
    files: ["lib/workspaces/queries/time-entries.ts"],
    keys: () => [
      timeEntriesKeys.summary(WORKSPACE, USER, "2026-01-01", "2026-01-31"),
      timeEntriesKeys.teamSummary(WORKSPACE, USER, "2026-01-01", "2026-01-31"),
    ],
  },
  // Matter visibility depends on the caller; a future cache key needs org + user.
  "time-timers/admin/list.ts": {
    kind: "no-web-caller",
    calls: ['api["time-timers"].admin.get'],
  },
  "time-timers/list.ts": {
    kind: "keyed",
    calls: ['api["time-timers"].get'],
    files: ["features/time-timers/queries.ts"],
    keys: () => [timeTimersOptions(ORG, USER).queryKey],
  },
  "usage/get-lane.ts": {
    kind: "keyed",
    calls: ["api.usage.lane.get"],
    files: ["lib/usage-queries.ts"],
    keys: () => [
      usageLaneOptions({ organizationId: ORG, userId: USER }).queryKey,
    ],
  },
  "user-files/read-visual.ts": {
    kind: "owned-id",
    reason:
      "Cached by attachment id; generated views are private and owner-filtered.",
  },
  "user-files/read-content.ts": { kind: "owned-id", reason: OWNED_FILE },
  "user-files/read-thumbnail.ts": { kind: "owned-id", reason: OWNED_FILE },
  "view-templates/list.ts": {
    kind: "keyed",
    calls: ['api["view-templates"]().get'],
    files: ["lib/workspaces/queries/view-templates.ts"],
    keys: () => [viewTemplateKeys.all({ organizationId: ORG, userId: USER })],
    opaqueKeys: { "viewTemplateKeys.all(key)": KEY_TYPE_HAS_USER },
  },
  "views/table/export.ts": { kind: "not-per-user", reason: DOWNLOAD },
  "work-obligations/queues/list.ts": {
    kind: "no-web-caller",
    calls: ['api["my-work"].get'],
  },
  "workspaces/member-previews/list.ts": {
    kind: "keyed",
    calls: ['api.workspaces["member-previews"].get'],
    files: ["lib/workspaces/queries/workspace-member-previews.ts"],
    keys: () => [
      workspaceMemberPreviewsOptions({
        organizationId: ORG,
        userId: USER,
        workspaceIds: [WORKSPACE],
      }).queryKey,
    ],
  },
  "workspaces/list.ts": { kind: "not-per-user", reason: JOINS_NAMES },
  "workspaces/member-candidates/list.ts": {
    kind: "not-per-user",
    reason: JOINS_NAMES,
  },
  "workspaces/read-active.ts": {
    kind: "no-web-caller",
    calls: ["api.workspaces.active.get"],
  },
  "workspaces/read-activity.ts": {
    kind: "keyed",
    calls: ["api.workspaces().activity.get"],
    files: ["lib/workspaces/queries.ts"],
    keys: () => [
      workspacesKeys.activity(ORG, { userId: USER, workspaceId: WORKSPACE }),
    ],
    opaqueKeys: {
      "workspacesKeys.activity(activeOrganizationId, key)": KEY_TYPE_HAS_USER,
    },
  },
  "workspaces/export-overview-activity.ts": {
    kind: "not-per-user",
    reason: DOWNLOAD,
  },
  "workspaces/read-overview-activity.ts": {
    kind: "keyed",
    calls: ["api.workspaces().overview.activity.get"],
    files: ["lib/workspaces/queries.ts"],
    keys: () => [
      overviewActivityOptions({
        viewer: { userId: USER, organizationId: ORG },
        workspaceId: WORKSPACE,
        filters: DEFAULT_MATTER_ACTIVITY_FILTERS,
      }).queryKey,
    ],
  },
  "workspaces/read-overview-activity-actors.query.ts": {
    kind: "not-per-user",
    reason: JOINS_NAMES,
  },
};

// Keyed by the auth client call; every `authClient` list/get call is here.
const AUTH_CLIENT_READS: Record<string, PerUserRead> = {
  "authClient.getLastUsedLoginMethod": {
    kind: "not-per-user",
    reason: "read from this browser, not the server",
  },
  "authClient.getSession": {
    kind: "session",
    reason: "the session itself",
  },
  "authClient.listAccounts": {
    kind: "keyed",
    calls: ["authClient.listAccounts"],
    files: ["lib/account/queries.ts"],
    keys: () => [linkedAccountsOptions(USER).queryKey],
  },
  "authClient.listSessions": {
    kind: "keyed",
    calls: ["authClient.listSessions", "listAuthSessions"],
    files: ["lib/auth-client.ts", "lib/account/queries.ts"],
    keys: () => [sessionsOptions(USER).queryKey],
  },
  "authClient.organization.getActiveMember": {
    kind: "session",
    reason: "the signed-in member's own membership grants",
  },
  "authClient.organization.getActiveMemberRole": {
    kind: "session",
    reason: "the signed-in member's role",
  },
  "authClient.organization.getFullOrganization": {
    kind: "not-per-user",
    reason: "the organization and its members, the same for every member",
  },
  "authClient.organization.getInvitation": {
    kind: "owned-id",
    reason: "loaded by invitation id in a route loader, not cached",
  },
  "authClient.organization.list": {
    kind: "keyed",
    calls: ["authClient.organization.list"],
    files: [
      "lib/organization/queries.ts",
      // Signs in and picks an organization; nothing is cached.
      "routes/auth/-components/dev-quick-start-button.tsx",
    ],
    keys: () => [organizationListOptions(USER).queryKey],
  },
};

const ALL_READS = { ...PER_USER_READS, ...AUTH_CLIENT_READS };

// A handler named like a read, for reads registered outside the route table.
const READ_HANDLER_NAME =
  /\/(?:list|get|read|count|resolve|summary|pending)[^/]*\.ts$/u;
// Any reference to the caller: `user.id`, `ctx.user.id`, `currentUser.id`,
// `currentUserId`, or a `…ForUser(` helper.
const REFERS_TO_CALLER =
  /\b(?:ctx\.|current)?[uU]ser\.id\b|\bcurrentUserId\b|ForUser\(/u;
const ROUTE_REGISTRATION =
  /\.(get|post)\(\s*(?:"[^"]*"|`[^`]*`),\s*([A-Za-z_$][\w$]*)\.handler\b/gu;
const HANDLER_IMPORT =
  /import ([A-Za-z_$][\w$]*) from "@\/api\/handlers\/([^"]+)"/gu;

const listFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = nodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "generated" ? [] : listFiles(path);
    }
    return /\.tsx?$/u.test(entry.name) && !TEST_FILE_PATTERN.test(entry.name)
      ? [path]
      : [];
  });

const readSource = (path: string) => readFileSync(path, "utf-8");

/**
 * Handlers (relative to handlers/) that serve reads: every GET route, every
 * POST route whose handler declares `access: "read"`, and every read-named
 * handler file.
 */
const readHandlers = () => {
  const reads = new Set<string>();
  for (const path of listFiles(API_SOURCE)) {
    const source = readSource(path);
    const imports = new Map(
      [...source.matchAll(HANDLER_IMPORT)].map(([, name, file]) => [
        name,
        `${file ?? ""}.ts`,
      ]),
    );
    for (const [, method, name] of source.matchAll(ROUTE_REGISTRATION)) {
      const handler = imports.get(name ?? "");
      if (handler === undefined) {
        continue;
      }
      if (
        method === "get" ||
        readSource(nodePath.join(API_HANDLERS, handler)).includes(
          'access: "read"',
        )
      ) {
        reads.add(handler);
      }
    }
  }
  for (const path of listFiles(API_HANDLERS)) {
    const handler = repoRelativePath(API_HANDLERS, path);
    if (READ_HANDLER_NAME.test(`/${handler}`)) {
      reads.add(handler);
    }
  }
  return reads;
};

type ReadBinding = {
  value: Node | null;
  stable: boolean;
  root: string | null;
};
type ReadCall = { chain: string; start: number; end: number };
const functionScope = (node: Node) =>
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression" ||
  node.type === "ArrowFunctionExpression";
const lexicalScope = (node: Node) =>
  functionScope(node) ||
  [
    "Program",
    "BlockStatement",
    "CatchClause",
    "ForStatement",
    "ForOfStatement",
    "ForInStatement",
    "SwitchStatement",
  ].includes(node.type);

const bindingNames = (node: Node): string[] => {
  if (node.type === "Identifier") {
    return [node.name];
  }
  if (node.type === "ObjectPattern") {
    return node.properties.flatMap((property) =>
      bindingNames(
        property.type === "RestElement" ? property.argument : property.value,
      ),
    );
  }
  if (node.type === "ArrayPattern") {
    return node.elements.flatMap((element) =>
      element ? bindingNames(element) : [],
    );
  }
  if (node.type === "AssignmentPattern") {
    return bindingNames(node.left);
  }
  if (node.type === "RestElement") {
    return bindingNames(node.argument);
  }
  if (node.type === "TSParameterProperty") {
    return bindingNames(node.parameter);
  }
  return [];
};
const clientModule = (name: string) => {
  if (name === "api" || name === "apiClient") {
    return "api";
  }
  if (name === "authClient") {
    return "auth-client";
  }
  return null;
};

/** Actual calls, with immutable route receivers resolved in their lexical scope. */
const readCalls = (
  source: string,
  roots: readonly string[],
  fileName = "per-user-read.tsx",
): ReadCall[] => {
  const { program } = parseSource(fileName, source);
  const parents = new Map<Node, Node>();
  const bindings = new Map<Node, Map<string, ReadBinding>>();
  const importedRoot = (module: string, name: string) => {
    if (!roots.includes(name)) {
      return null;
    }
    const owner = clientModule(name);
    if (owner === null) {
      return name;
    }
    return module === `@/lib/${owner}` ||
      (module.startsWith(".") &&
        nodePath
          .resolve(nodePath.dirname(fileName), module)
          .replace(/\.tsx?$/u, "") === nodePath.join(WEB_SOURCE, "lib", owner))
      ? name
      : null;
  };
  const dynamicImports = (
    pattern: Node,
    value: Node | null,
  ): Map<string, string> => {
    const imported = new Map<string, string>();
    if (value?.type === "AwaitExpression") {
      return dynamicImports(pattern, value.argument);
    }
    if (
      pattern.type === "ObjectPattern" &&
      value?.type === "ImportExpression" &&
      value.source.type === "Literal" &&
      typeof value.source.value === "string"
    ) {
      for (const property of pattern.properties) {
        if (
          property.type !== "Property" ||
          property.computed ||
          property.key.type !== "Identifier" ||
          property.value.type !== "Identifier"
        ) {
          continue;
        }
        const root = importedRoot(value.source.value, property.key.name);
        if (root !== null) {
          imported.set(property.value.name, root);
        }
      }
    }
    if (
      pattern.type === "ArrayPattern" &&
      value?.type === "CallExpression" &&
      value.callee.type === "MemberExpression" &&
      value.callee.object.type === "Identifier" &&
      value.callee.object.name === "Promise" &&
      !value.callee.computed &&
      value.callee.property.type === "Identifier" &&
      value.callee.property.name === "all"
    ) {
      const inputs = value.arguments.at(0);
      if (inputs?.type === "ArrayExpression") {
        for (const [index, element] of pattern.elements.entries()) {
          const input = inputs.elements.at(index);
          if (element && input) {
            for (const [name, root] of dynamicImports(element, input)) {
              imported.set(name, root);
            }
          }
        }
      }
    }
    return imported;
  };

  const declare = (scope: Node, name: string, binding: ReadBinding) => {
    let names = bindings.get(scope);
    if (!names) {
      names = new Map();
      bindings.set(scope, names);
    }
    names.set(
      name,
      names.has(name) ? { value: null, stable: false, root: null } : binding,
    );
  };
  const opaque = (scope: Node, pattern: Node) => {
    for (const name of bindingNames(pattern)) {
      declare(scope, name, { value: null, stable: false, root: null });
    }
  };
  walk(program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (parent) {
      parents.set(node, parent);
    }
    const scope = ancestors.findLast(lexicalScope) ?? program;
    if (
      node.type === "VariableDeclarator" &&
      parent?.type === "VariableDeclaration"
    ) {
      const owner =
        parent.kind === "var"
          ? (ancestors.findLast(
              (ancestor) =>
                functionScope(ancestor) || ancestor.type === "Program",
            ) ?? program)
          : scope;
      const imported = dynamicImports(node.id, node.init);
      for (const name of bindingNames(node.id)) {
        const ownClient = clientModule(name);
        const canonicalRoot =
          owner === program &&
          ownClient !== null &&
          nodePath.resolve(fileName).replace(/\.tsx?$/u, "") ===
            nodePath.join(WEB_SOURCE, "lib", ownClient) &&
          roots.includes(name)
            ? name
            : null;
        declare(owner, name, {
          value: node.id.type === "Identifier" ? node.init : null,
          stable:
            parent.kind === "const" &&
            (node.id.type === "Identifier" || imported.has(name)),
          root: imported.get(name) ?? canonicalRoot,
        });
      }
    }
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      if (node.type !== "ArrowFunctionExpression" && node.id) {
        opaque(node.type === "FunctionDeclaration" ? scope : node, node.id);
      }
      for (const parameter of node.params) {
        opaque(node, parameter);
      }
    }
    if (node.type === "CatchClause" && node.param) {
      opaque(node, node.param);
    }
    if (node.type === "ClassDeclaration" && node.id) {
      opaque(scope, node.id);
    }
    if (node.type === "ImportDeclaration") {
      const module = node.source.value;
      for (const specifier of node.specifiers) {
        let root: string | null = null;
        if (
          node.importKind !== "type" &&
          specifier.type === "ImportSpecifier" &&
          specifier.importKind !== "type"
        ) {
          const name =
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value;
          root = importedRoot(module, name);
        }
        declare(program, specifier.local.name, {
          value: null,
          stable: true,
          root,
        });
      }
    }
  });
  const bindingFor = (node: Node, name: string) => {
    for (
      let current: Node | undefined = node;
      current;
      current = parents.get(current)
    ) {
      const binding = bindings.get(current)?.get(name);
      if (binding) {
        return binding;
      }
    }
    return undefined;
  };
  walk(program, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "ArrayPattern") {
      const value =
        node.init?.type === "AwaitExpression" ? node.init.argument : node.init;
      if (
        value?.type === "CallExpression" &&
        value.callee.type === "MemberExpression" &&
        value.callee.object.type === "Identifier" &&
        value.callee.object.name === "Promise" &&
        bindingFor(value.callee.object, "Promise")
      ) {
        for (const name of bindingNames(node.id)) {
          const binding = bindingFor(node, name);
          if (binding) {
            binding.stable = false;
          }
        }
      }
    }
    let target: Node | null = null;
    if (node.type === "AssignmentExpression") {
      target = node.left;
    }
    if (node.type === "UpdateExpression") {
      target = node.argument;
    }
    if (target) {
      for (const name of bindingNames(target)) {
        const binding = bindingFor(node, name);
        if (binding) {
          binding.stable = false;
        }
      }
    }
  });
  const memberName = (node: Node) => {
    if (node.type !== "MemberExpression") {
      return null;
    }
    if (!node.computed && node.property.type === "Identifier") {
      return node.property.name;
    }
    return node.property.type === "Literal" &&
      typeof node.property.value === "string"
      ? node.property.value
      : null;
  };
  const chainOf = (
    node: Node,
    seen: Set<Node>,
    allowRequest: boolean,
  ): string | null => {
    if (seen.has(node)) {
      return null;
    }
    const nextSeen = new Set(seen).add(node);
    if (
      node.type !== "Identifier" &&
      node.type !== "MemberExpression" &&
      node.type !== "CallExpression" &&
      node.type !== "ParenthesizedExpression" &&
      node.type !== "TSAsExpression" &&
      node.type !== "TSSatisfiesExpression" &&
      node.type !== "TSNonNullExpression"
    ) {
      return null;
    }
    switch (node.type) {
      case "Identifier": {
        const binding = bindingFor(node, node.name);
        if (!binding) {
          return roots.includes(node.name) ? node.name : null;
        }
        if (!binding.stable) {
          return null;
        }
        return (
          binding.root ??
          (binding.value ? chainOf(binding.value, nextSeen, false) : null)
        );
      }
      case "MemberExpression": {
        const name = memberName(node);
        const owner = chainOf(node.object, nextSeen, false);
        return name !== null && owner !== null
          ? `${owner}${node.computed ? `[${JSON.stringify(name)}]` : `.${name}`}`
          : null;
      }
      case "CallExpression": {
        const name = memberName(node.callee);
        if (
          !allowRequest &&
          ((name === null && node.callee.type !== "CallExpression") ||
            (name !== null &&
              (API_CLIENT_REQUEST_METHODS.has(name) ||
                ((name.startsWith("get") || name.startsWith("list")) &&
                  chainOf(node.callee, nextSeen, false)?.startsWith(
                    "authClient.",
                  )))))
        ) {
          return null;
        }
        const callee = chainOf(node.callee, nextSeen, false);
        return callee === null ? null : `${callee}()`;
      }
      case "ParenthesizedExpression":
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
        return chainOf(node.expression, nextSeen, allowRequest);
      default:
        return null;
    }
  };
  const calls: ReadCall[] = [];
  walk(program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const chain = chainOf(node, new Set(), true);
    if (chain !== null) {
      calls.push({ chain, start: node.start, end: node.end });
    }
  });
  return calls;
};

const callChains = (
  source: string,
  roots: readonly string[],
  fileName?: string,
) => readCalls(source, roots, fileName).map(({ chain }) => chain);

const callsOf = (read: PerUserRead): readonly string[] =>
  "calls" in read ? read.calls : [];

const rootsOf = (calls: readonly string[]) => [
  ...new Set(calls.map((call) => call.split(/[.[(]/u)[0] ?? call)),
];

type ReachesOptions = {
  source: string;
  calls: readonly string[];
  helpers: ReadonlySet<string>;
  observed: readonly ReadCall[];
  start: number;
  end: number;
};
const reaches = ({
  source,
  calls,
  helpers,
  observed,
  start,
  end,
}: ReachesOptions) =>
  observed.some(
    (read) =>
      read.start >= start &&
      read.end <= end &&
      calls.some((call) => read.chain.startsWith(`${call}()`)),
  ) ||
  [...helpers].some((name) =>
    new RegExp(`\\b${name}\\b`, "u").test(source.slice(start, end)),
  );

/** Top-level declarations by name, each with the text up to the next one. */
const topLevelDeclarations = (source: string) => {
  const starts = [
    ...source.matchAll(
      /^(?:export )?(?:const|(?:async )?function) ([A-Za-z_$][\w$]*)/gmu,
    ),
  ];
  return starts.map((start, index) => ({
    name: start[1] ?? "",
    start: start.index,
    end: starts[index + 1]?.index ?? source.length,
  }));
};

/** Top-level helpers in `source` that end up calling one of `calls`. */
const helpersReaching = (
  source: string,
  calls: readonly string[],
  observed: readonly ReadCall[],
) => {
  const declarations = topLevelDeclarations(source);
  const helpers = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const { name, start, end } of declarations) {
      if (
        !helpers.has(name) &&
        reaches({ source, calls, helpers, observed, start, end })
      ) {
        helpers.add(name);
        grew = true;
      }
    }
  }
  return helpers;
};

const OPENERS = "([{";
const CLOSERS = ")]}";

/** The bracketed span around `index`, bounds inclusive. */
const enclosingObject = (source: string, index: number) => {
  let depth = 0;
  let start = index;
  for (; start >= 0; start -= 1) {
    const char = source[start] ?? "";
    if (CLOSERS.includes(char)) {
      depth += 1;
    } else if (OPENERS.includes(char)) {
      if (depth === 0) {
        break;
      }
      depth -= 1;
    }
  }
  depth = 0;
  for (let end = start; end < source.length; end += 1) {
    const char = source[end] ?? "";
    if (OPENERS.includes(char)) {
      depth += 1;
    } else if (CLOSERS.includes(char)) {
      depth -= 1;
      if (depth === 0) {
        return { start, end };
      }
    }
  }
  return { start, end: source.length - 1 };
};

/** The expression after `queryKey:` up to the next top-level comma. */
const keyExpression = (source: string, from: number, end: number) => {
  let depth = 0;
  for (let index = from; index < end; index += 1) {
    const char = source[index] ?? "";
    if (OPENERS.includes(char)) {
      depth += 1;
    } else if (CLOSERS.includes(char)) {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      return source.slice(from, index).trim();
    }
  }
  return source.slice(from, end).trim();
};

const NAMES_A_USER = /[uU]ser(?:Id\b|\.id\b)/u;

/**
 * Query keys, in `source`, of queries that reach one of `calls` without
 * naming a user. A key held in a local `const` is read from its declaration.
 */
const unkeyedQueries = (
  source: string,
  calls: readonly string[],
  fileName?: string,
) => {
  const observed = readCalls(source, rootsOf(calls), fileName);
  const helpers = helpersReaching(source, calls, observed);
  const unkeyed: string[] = [];
  for (const match of source.matchAll(/(?<![\w$.])queryKey\b(?=\s*[:,}])/gu)) {
    const object = enclosingObject(source, match.index);
    // A parameter or type named `queryKey` is not a query's key.
    if (source[object.start] !== "{") {
      continue;
    }
    if (
      !reaches({
        source,
        calls,
        helpers,
        observed,
        start: object.start,
        end: object.end + 1,
      })
    ) {
      continue;
    }
    const after = match.index + match[0].length;
    const colon = /^\s*:/u.exec(source.slice(after));
    const expression =
      colon === null
        ? "queryKey"
        : keyExpression(source, after + colon[0].length, object.end);
    const declared = /^[A-Za-z_$][\w$]*$/u.test(expression)
      ? new RegExp(`const ${expression} =([^;]*);`, "u").exec(source)?.[1]
      : undefined;
    if (!NAMES_A_USER.test(declared ?? expression)) {
      unkeyed.push(expression.replaceAll(/\s+/gu, " "));
    }
  }
  return unkeyed;
};

/** Web files calling each listed read, relative to src/. */
const webCallers = () => {
  const calls = Object.values(ALL_READS).flatMap(callsOf);
  const roots = rootsOf(calls);
  const callers = new Map<string, string[]>();
  for (const path of listFiles(WEB_SOURCE)) {
    const chains = callChains(readSource(path), roots, path);
    for (const call of calls) {
      if (chains.some((chain) => chain.startsWith(`${call}()`))) {
        callers.set(call, [
          ...(callers.get(call) ?? []),
          repoRelativePath(WEB_SOURCE, path),
        ]);
      }
    }
  }
  return callers;
};

const containsValue = (value: unknown, wanted: string): boolean => {
  if (value === wanted) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item: unknown) => containsValue(item, wanted));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item: unknown) =>
      containsValue(item, wanted),
    );
  }
  return false;
};

const refersToCaller = (handler: string) =>
  REFERS_TO_CALLER.test(readSource(nodePath.join(API_HANDLERS, handler)));

describe("per-user reads", () => {
  test("every read endpoint that refers to the caller is classified", () => {
    const unclassified = [...readHandlers()]
      .filter((handler) => refersToCaller(handler))
      .filter((handler) => !(handler in PER_USER_READS))
      .toSorted();

    expect(unclassified).toEqual([]);
  });

  test("every classified handler still exists", () => {
    const missing = Object.keys(PER_USER_READS).filter(
      (handler) => !existsSync(nodePath.join(API_HANDLERS, handler)),
    );

    expect(missing).toEqual([]);
  });

  test("every auth client list or get call is classified", () => {
    const found = new Set(
      listFiles(WEB_SOURCE).flatMap((path) =>
        callChains(readSource(path), ["authClient"], path)
          .map((chain) => chain.split("(")[0] ?? chain)
          .filter((chain) => /\.(?:list|get)[A-Za-z]*$/u.test(chain)),
      ),
    );

    expect([...found].toSorted()).toEqual(
      Object.keys(AUTH_CLIENT_READS).toSorted(),
    );
  });

  test("cached per-user reads are called only from the listed modules", () => {
    const callers = webCallers();
    for (const [handler, read] of Object.entries(ALL_READS)) {
      const calledFrom = [
        ...new Set(callsOf(read).flatMap((call) => callers.get(call) ?? [])),
      ].toSorted();
      const listed = "files" in read ? read.files.toSorted() : [];

      expect({ handler, calledFrom }).toEqual({ handler, calledFrom: listed });
    }
  });

  test("their key factories put the user id in the key", () => {
    for (const [handler, read] of Object.entries(ALL_READS)) {
      if (read.kind === "keyed") {
        for (const key of read.keys()) {
          expect({ handler, keyed: containsValue(key, USER) }).toEqual({
            handler,
            keyed: true,
          });
        }
      }
    }
  });

  test("every query reaching them names the user in its key", () => {
    const unkeyed = Object.entries(ALL_READS).flatMap(([handler, read]) =>
      read.kind === "keyed"
        ? read.files
            .flatMap((file) =>
              unkeyedQueries(
                readSource(nodePath.join(WEB_SOURCE, file)),
                read.calls,
                nodePath.join(WEB_SOURCE, file),
              ),
            )
            .filter((expression) => !(expression in (read.opaqueKeys ?? {})))
            .map((expression) => `${handler}: ${expression}`)
        : [],
    );

    expect(unkeyed).toEqual([]);
  });
});

test("list detail keys carry caller identity and retain broad invalidation", async () => {
  const scope = {
    workspaceId: WORKSPACE,
    listId: "list-probe",
    itemEntityId: "item-probe",
  };
  const caller = { organizationId: ORG, userId: USER };
  const reads = [
    {
      options: legalListItemsOptions,
      root: legalListKeys.items(scope.workspaceId, scope.listId),
    },
    {
      options: legalListSourcesOptions,
      root: legalListKeys.sources(
        scope.workspaceId,
        scope.listId,
        scope.itemEntityId,
      ),
    },
    {
      options: legalListActivityOptions,
      root: legalListKeys.activity(
        scope.workspaceId,
        scope.listId,
        scope.itemEntityId,
      ),
    },
  ];
  const queryClient = new QueryClient();
  for (const { options, root } of reads) {
    const callerKey = Array.from(
      options({ ...scope, viewer: caller }).queryKey,
    );
    expect(callerKey).toContain(caller.userId);
    expect(callerKey).toContain(caller.organizationId);
    queryClient.setQueryData(callerKey, { details: "visible" });
    await queryClient.invalidateQueries({
      queryKey: root,
      refetchType: "none",
    });
    expect(queryClient.getQueryState(callerKey)?.isInvalidated).toBe(true);
  }
});

test("matter overview activity keys carry caller identity and retain workspace invalidation", async () => {
  const scope = {
    workspaceId: WORKSPACE,
    filters: DEFAULT_MATTER_ACTIVITY_FILTERS,
  };
  const caller = { organizationId: ORG, userId: USER };
  const queryClient = new QueryClient();
  const callerKey = Array.from(
    overviewActivityOptions({ ...scope, viewer: caller }).queryKey,
  );
  expect(callerKey).toContain(caller.userId);
  expect(callerKey).toContain(caller.organizationId);
  queryClient.setQueryData(callerKey, { target: "caller" });
  await queryClient.invalidateQueries({
    queryKey: workspacesKeys.overviewActivityAll(WORKSPACE),
    refetchType: "none",
  });
  expect(queryClient.getQueryState(callerKey)?.isInvalidated).toBe(true);
});

test("organization settings isolate caller capabilities by user and organization", () => {
  const caller = { organizationId: ORG, userId: USER };
  const colleague = { organizationId: ORG, userId: "colleague-probe" };
  const otherOrganization = { organizationId: "other-org-probe", userId: USER };
  const queryClient = new QueryClient();
  const callerKey = Array.from(organizationSettingsOptions(caller).queryKey);
  const colleagueKey = Array.from(
    organizationSettingsOptions(colleague).queryKey,
  );
  const otherOrganizationKey = Array.from(
    organizationSettingsOptions(otherOrganization).queryKey,
  );
  const enabled = { capabilities: { fixture: { status: "enabled" } } };
  const hidden = { capabilities: { fixture: { status: "hidden" } } };
  queryClient.setQueryData(callerKey, enabled);
  expect(
    queryClient.getQueryCache().find({ queryKey: callerKey })?.state.data,
  ).toEqual(enabled);
  expect(
    queryClient.getQueryCache().find({ queryKey: colleagueKey })?.state.data,
  ).toBeUndefined();
  expect(
    queryClient.getQueryCache().find({ queryKey: otherOrganizationKey })?.state
      .data,
  ).toBeUndefined();
  queryClient.setQueryData(colleagueKey, hidden);
  expect(
    queryClient.getQueryCache().find({ queryKey: colleagueKey })?.state.data,
  ).toEqual(hidden);
  expect(
    queryClient.getQueryCache().find({ queryKey: callerKey })?.state.data,
  ).toEqual(enabled);
});

test("organization settings skip authenticated reads until an organization is selected", () => {
  const unselected = optionalOrganizationSettingsOptions({
    organizationId: null,
    userId: USER,
  });
  expect(unselected.queryFn).toBe(skipToken);
  expect(unselected.queryKey).toContain(USER);
  expect(unselected.queryKey).toContain(null);
  const selected = organizationSettingsOptions({
    organizationId: ORG,
    userId: USER,
  });
  expect(selected.queryKey).not.toEqual(unselected.queryKey);
  const selectedOptional = optionalOrganizationSettingsOptions({
    organizationId: ORG,
    userId: USER,
  });
  expect(selectedOptional.queryKey).toEqual(selected.queryKey);
  expect(selectedOptional.queryFn).toBe(selected.queryFn);
});

describe("the per-user read scan", () => {
  test("a defining client module keeps nested local shadows opaque", () => {
    const source = `
export const authClient = createAuthClient();
function local() {
  const authClient = localClient;
  return authClient.getSession();
}
authClient.listSessions();
`;
    expect(
      callChains(
        source,
        ["authClient"],
        nodePath.join(WEB_SOURCE, "lib/auth-client.ts"),
      ),
    ).toEqual(["authClient.listSessions()"]);
  });

  test("retains canonical dynamic imports and explicitly listed read helpers", () => {
    expect(
      callChains(
        'const { authClient: auth } = await import("@/lib/auth-client"); auth.organization.getActiveMember();',
        ["authClient"],
      ),
    ).toContain("authClient.organization.getActiveMember()");
    expect(
      callChains(
        'const [{ api }] = await Promise.all([import("@/lib/api")]); api.me.get();',
        ["api"],
      ),
    ).toContain("api.me.get()");
    expect(
      callChains(
        'import { fetchWorkspaceNavigationPage as read } from "@/lib/memory-api"; read({});',
        ["fetchWorkspaceNavigationPage"],
      ),
    ).toContain("fetchWorkspaceNavigationPage()");
  });

  test("an unrelated dynamic import or shadowed import aggregate is not an API root", () => {
    expect(
      callChains(
        'const { api } = await import("./local-client"); api.me.get();',
        ["api"],
      ),
    ).toEqual([]);
    expect(
      callChains(
        'async function read(Promise) { const [{ api }] = await Promise.all([import("@/lib/api")]); return api.me.get(); }',
        ["api"],
      ),
    ).not.toContain("api.me.get()");
  });

  test("a terminal auth request result cannot masquerade as a route", () => {
    expect(
      callChains(
        'import { authClient } from "@/lib/auth-client"; const result = authClient.getSession(); result.organization.list();',
        ["authClient"],
      ),
    ).not.toContain("authClient.getSession().organization.list()");
  });

  test("ignores strings and comments that merely name a request", () => {
    expect(
      callChains("const example = 'api.me.get()'; // api.me.get()\n", ["api"]),
    ).toEqual([]);
  });

  test("follows stable route receivers without losing the original call chain", () => {
    const source = `
import { api as client } from "@/lib/api";
const workspaceApi = client.chat.workspaces({ workspaceId });
const alias = workspaceApi;
async function read() {
  return alias["file-thread"].get({ query: { entityId, fieldId } });
}
`;
    expect(callChains(source, ["api"])).toContain(
      'api.chat.workspaces()["file-thread"].get()',
    );
  });

  test("an outer route receiver cannot hide a query that omits its user", () => {
    const source = `
import { api } from "@/lib/api";
export const options = (workspaceId: string, userId: string) => {
  const workspaceApi = api.chat.workspaces({ workspaceId });
  return queryOptions({
    queryKey: ["file-thread", workspaceId],
    queryFn: () => workspaceApi["file-thread"].get({}),
  });
};
`;
    const calls = ['api.chat.workspaces()["file-thread"].get'];
    expect(unkeyedQueries(source, calls)).toEqual([
      '["file-thread", workspaceId]',
    ]);
    expect(
      unkeyedQueries(
        source.replace(
          '["file-thread", workspaceId]',
          '["file-thread", workspaceId, userId]',
        ),
        calls,
      ),
    ).toEqual([]);
  });

  test("follows a receiver in a local fetch helper when checking caller keys", () => {
    const source = `
import { api } from "@/lib/api";
const route = api.chat.workspaces({ workspaceId });
const fetchFile = async () => await route["file-thread"].get({});
export const options = (workspaceId: string) =>
  queryOptions({ queryKey: ["file-thread", workspaceId], queryFn: fetchFile });
`;
    expect(
      unkeyedQueries(source, ['api.chat.workspaces()["file-thread"].get']),
    ).toEqual(['["file-thread", workspaceId]']);
  });

  for (const { name, source } of [
    {
      name: "a parameter shadows a route",
      source:
        'const route = api.chat.workspaces({}); function read(route) { return route["file-thread"].get({}); }',
    },
    {
      name: "a destructured parameter shadows a route",
      source:
        'const route = api.chat.workspaces({}); const read = ({ route }) => route["file-thread"].get({});',
    },
    {
      name: "a block shadows a route",
      source:
        'const route = api.chat.workspaces({}); { const route = localClient; route["file-thread"].get({}); }',
    },
    {
      name: "a mutable receiver",
      source:
        'let route = api.chat.workspaces({}); route["file-thread"].get({});',
    },
    {
      name: "a reassigned receiver",
      source:
        'const route = api.chat.workspaces({}); route = localClient; route["file-thread"].get({});',
    },
    {
      name: "cyclic aliases",
      source:
        'const first = second; const second = first; first["file-thread"].get({});',
    },
    {
      name: "a destructured value",
      source:
        'const { route } = api.chat.workspaces({}); route["file-thread"].get({});',
    },
    {
      name: "an awaited request result",
      source:
        'const route = await api.chat.workspaces({}).get(); route["file-thread"].get({});',
    },
    {
      name: "a request promise",
      source:
        'const route = api.chat.workspaces({}).post({}); route["file-thread"].get({});',
    },
    {
      name: "an opaque factory",
      source:
        'const make = () => api.chat.workspaces({}); const route = make(); route["file-thread"].get({});',
    },
    {
      name: "a shadowed API root",
      source:
        'function read(api) { const route = api.chat.workspaces({}); return route["file-thread"].get({}); }',
    },
    {
      name: "an unrelated API import",
      source:
        'import { api } from "./local-client"; const route = api.chat.workspaces({}); route["file-thread"].get({});',
    },
  ]) {
    test(`does not assign a per-user route to ${name}`, () => {
      expect(
        callChains(source, ["api"]).filter((chain) =>
          chain.endsWith('["file-thread"].get()'),
        ),
      ).toEqual([]);
    });
  }

  test("keeps the outer receiver visible after a shadowed block", () => {
    const source = `
const route = api.chat.workspaces({});
{ const route = localClient; route["file-thread"].get({}); }
route["file-thread"].get({});
`;
    expect(
      callChains(source, ["api"]).filter(
        (chain) => chain === 'api.chat.workspaces()["file-thread"].get()',
      ),
    ).toHaveLength(1);
  });

  test("sees the caller however a handler refers to it", () => {
    for (const reference of [
      "eq(timeEntries.userId, currentUser.id)",
      "eq(entityViews.userId, ctx.user.id)",
      "where: { userId: user.id }",
      "listOAuthConnectionsForUser(tx, ctx.user.id)",
      "currentUserId,",
    ]) {
      expect({ reference, seen: REFERS_TO_CALLER.test(reference) }).toEqual({
        reference,
        seen: true,
      });
    }
  });

  test("finds the my-day read among the read endpoints", () => {
    expect(readHandlers().has("time-entries/me/list.ts")).toBe(true);
    expect(refersToCaller("time-entries/me/list.ts")).toBe(true);
  });

  test("flags a my-day query keyed by organization and date only", () => {
    const source = `
export const myTimeEntriesInfiniteOptions = (organizationId: string, date: string) =>
  infiniteQueryOptions({
    queryKey: myTimeEntriesKeys.day(organizationId, date),
    queryFn: async ({ signal }) =>
      unwrapApiResponse(await api["time-entries"].me.get({ query: { date }, fetch: { signal } })),
  });
`;

    expect(unkeyedQueries(source, ['api["time-entries"].me.get'])).toEqual([
      "myTimeEntriesKeys.day(organizationId, date)",
    ]);
    expect(
      unkeyedQueries(
        source.replace(
          "(organizationId, date)",
          "(organizationId, userId, date)",
        ),
        ['api["time-entries"].me.get'],
      ),
    ).toEqual([]);
  });

  test("follows a local helper and a key held in a const", () => {
    const source = `
const fetchPage = async () => await api.notifications.get({});

export const useNotifications = (organizationId: string) => {
  const queryKey = ["notifications", organizationId];
  return useQuery({ queryKey, queryFn: fetchPage });
};
`;

    expect(unkeyedQueries(source, ["api.notifications.get"])).toEqual([
      "queryKey",
    ]);
  });
});
