import { QueryClient, skipToken, type QueryKey } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import { savedTimeNarrativesKeys } from "@/components/billing/saved-time-narratives";
import { companyFormatKeys } from "@/components/company-format-library";
import { readerAnnotationKeys } from "@/components/legal-reader/annotations/reader-annotations-query";
import { savedSearchKeys } from "@/components/saved-searches.logic";
import { chatKeys } from "@/features/chat/chat-query-contract";
import { desktopPresenceOptions } from "@/features/desktop/desktop-presence";
import { timeTimersOptions } from "@/features/time-timers/queries";
import {
  linkedAccountsOptions,
  pendingDeletionTasksOptions,
  sessionsOptions,
} from "@/lib/account/queries";
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
import { organizationListOptions } from "@/lib/organization/queries";
import { searchPreviewOptions } from "@/lib/search";
import { usageLaneOptions } from "@/lib/usage-queries";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import { workspacesKeys } from "@/lib/workspaces/queries.logic";
import {
  entityViewKeys,
  entityViewsOptions,
} from "@/lib/workspaces/queries/entity-views";
import { myTimeEntriesInfiniteOptions } from "@/lib/workspaces/queries/my-time-entries";
import { reportExportsKeys } from "@/lib/workspaces/queries/report-exports";
import { timeEntriesKeys } from "@/lib/workspaces/queries/time-entries";
import { viewTemplateKeys } from "@/lib/workspaces/queries/view-templates";
import { workspaceMemberPreviewsOptions } from "@/lib/workspaces/queries/workspace-member-previews";
import { featureEnrolmentsOptions } from "@/queries/feature-enrolments";
import {
  organizationSettingsOptions,
  optionalOrganizationSettingsOptions,
} from "@/queries/organization-settings";
import { auditLogOptions } from "@/routes/_protected.settings/-queries/audit-logs";
import { connectedAppsOptions } from "@/routes/_protected.settings/-queries/connections";
import { memoriesKeys } from "@/routes/_protected.settings/-queries/memories";
import { memoryMattersOptions } from "@/routes/_protected.settings/-queries/memory-matters";

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

// Keyed by handler path under apps/api/src/handlers.
const PER_USER_READS: Record<string, PerUserRead> = {
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
  "lists/items/list.ts": {
    kind: "caller-marker",
    reason:
      "Shared list items carry caller-visible fields; session-cache-guard clears them on member changes.",
  },
  "lists/items/sources/list.ts": {
    kind: "caller-marker",
    reason:
      "Shared sources carry caller-visible fields; session-cache-guard clears them on member changes.",
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
    files: ["routes/_protected.settings/-queries/audit-logs.ts"],
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
  "case-law/analysis/generate.ts": { kind: "not-per-user", reason: USAGE_ONLY },
  "catalogue/list.ts": {
    kind: "keyed",
    calls: ["api.catalogue.get"],
    files: ["lib/knowledge/queries/catalogue.ts"],
    keys: () => [catalogueOptions(ORG, USER).queryKey],
  },
  "chat/get-suggested-prompts.ts": { kind: "owned-id", reason: OWNED_THREAD },
  "chat/get-thread-recap.ts": { kind: "owned-id", reason: OWNED_THREAD },
  "chat/get-thread-title.ts": { kind: "owned-id", reason: OWNED_THREAD },
  "chat/messages/list.ts": { kind: "owned-id", reason: OWNED_THREAD },
  "chat/older-messages/list.ts": { kind: "owned-id", reason: OWNED_THREAD },
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
  "chat/skill-availability/list.ts": {
    kind: "keyed",
    calls: ['api.chat["skill-availability"].get'],
    files: ["lib/knowledge/queries.ts"],
    keys: () => [chatUnavailableSkillsOptions(ORG, USER).queryKey],
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
  "lists/items/activity/list.ts": {
    kind: "not-per-user",
    reason: JOINS_NAMES,
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
  "me/pending-tasks.ts": {
    kind: "keyed",
    calls: ['api.me.delete["pending-tasks"].get'],
    files: ["lib/account/queries.ts"],
    keys: () => [pendingDeletionTasksOptions(USER).queryKey],
  },
  // Filtered by row-level security rather than in the handler.
  "memories/list.ts": {
    kind: "keyed",
    calls: ["memoriesApi.get", "fetchMemoriesPage"],
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
  "notifications/read.ts": { kind: "not-per-user", reason: WRITE },
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
  "sharepoint/list-drive-root.ts": {
    kind: "no-web-caller",
    calls: ["api.sharepoint.drive.root.get"],
  },
  "sharepoint/oauth-callback.ts": {
    kind: "not-per-user",
    reason: OAUTH_REDIRECT,
  },
  "sharepoint/status.ts": {
    kind: "no-web-caller",
    calls: ["api.sharepoint.connection.get"],
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
  "templates/condition-decisions/get.ts": {
    kind: "not-per-user",
    reason: "the caller is recorded for usage only",
  },
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
  "time-entries/get.ts": { kind: "not-per-user", reason: JOINS_NAMES },
  "time-entries/list.ts": {
    kind: "keyed",
    calls: ["fetchTimeEntries"],
    files: ["lib/workspaces/queries/time-entries.ts"],
    keys: () => [timeEntriesKeys.list(WORKSPACE, USER, {})],
  },
  "time-entries/approval-queue/list.ts": {
    kind: "no-web-caller",
    calls: ['api["time-entries"]["approval-queue"].get'],
  },
  "time-entries/me/list.ts": {
    kind: "keyed",
    calls: ["myTimeEntriesApi.get"],
    files: ["lib/workspaces/queries/my-time-entries.ts"],
    keys: () => [
      myTimeEntriesInfiniteOptions(ORG, USER, "2026-01-01").queryKey,
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
    const handler = nodePath.relative(API_HANDLERS, path);
    if (READ_HANDLER_NAME.test(`/${handler}`)) {
      reads.add(handler);
    }
  }
  return reads;
};

const IDENTIFIER = /[A-Za-z_$][\w$]*/uy;
const BRACKETED = /\[\s*"([^"]+)"\s*\]/uy;

const closingParen = (source: string, open: number) => {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") {
      depth += 1;
    } else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
};

/**
 * Member chains starting at one of `roots`, with call arguments dropped:
 * `api.workspaces({ workspaceId }).activity.get({ … })` reads
 * `api.workspaces().activity.get()`.
 */
const callChains = (source: string, roots: readonly string[]) => {
  const chains: string[] = [];
  const root = new RegExp(`(?<![\\w$.])(?:${roots.join("|")})(?![\\w$])`, "gu");
  for (const match of source.matchAll(root)) {
    let chain = match[0];
    let index = match.index + chain.length;
    for (;;) {
      while (/\s/u.test(source[index] ?? "")) {
        index += 1;
      }
      const next = source[index];
      if (next === ".") {
        IDENTIFIER.lastIndex = index + 1;
        const name = IDENTIFIER.exec(source);
        if (name === null) {
          break;
        }
        chain += `.${name[0]}`;
        index = IDENTIFIER.lastIndex;
      } else if (next === "[") {
        BRACKETED.lastIndex = index;
        const name = BRACKETED.exec(source);
        if (name === null) {
          break;
        }
        chain += `["${name[1] ?? ""}"]`;
        index = BRACKETED.lastIndex;
      } else if (next === "(") {
        const close = closingParen(source, index);
        if (close === -1) {
          break;
        }
        chain += "()";
        index = close + 1;
      } else {
        break;
      }
    }
    chains.push(chain);
  }
  return chains;
};

const callsOf = (read: PerUserRead): readonly string[] =>
  "calls" in read ? read.calls : [];

const rootsOf = (calls: readonly string[]) => [
  ...new Set(calls.map((call) => call.split(/[.[(]/u)[0] ?? call)),
];

const reaches = (
  source: string,
  calls: readonly string[],
  helpers: ReadonlySet<string>,
) =>
  callChains(source, rootsOf(calls)).some((chain) =>
    calls.some((call) => chain.startsWith(`${call}()`)),
  ) ||
  [...helpers].some((name) => new RegExp(`\\b${name}\\b`, "u").test(source));

/** Top-level declarations by name, each with the text up to the next one. */
const topLevelDeclarations = (source: string) => {
  const starts = [
    ...source.matchAll(
      /^(?:export )?(?:const|(?:async )?function) ([A-Za-z_$][\w$]*)/gmu,
    ),
  ];
  return starts.map((start, index) => ({
    name: start[1] ?? "",
    text: source.slice(start.index, starts[index + 1]?.index ?? source.length),
  }));
};

/** Top-level helpers in `source` that end up calling one of `calls`. */
const helpersReaching = (source: string, calls: readonly string[]) => {
  const declarations = topLevelDeclarations(source);
  const helpers = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const { name, text } of declarations) {
      if (!helpers.has(name) && reaches(text, calls, helpers)) {
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
const unkeyedQueries = (source: string, calls: readonly string[]) => {
  const helpers = helpersReaching(source, calls);
  const unkeyed: string[] = [];
  for (const match of source.matchAll(/(?<![\w$.])queryKey\b(?=\s*[:,}])/gu)) {
    const object = enclosingObject(source, match.index);
    // A parameter or type named `queryKey` is not a query's key.
    if (source[object.start] !== "{") {
      continue;
    }
    const text = source.slice(object.start, object.end + 1);
    if (!reaches(text, calls, helpers)) {
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
    const chains = callChains(readSource(path), roots);
    for (const call of calls) {
      if (chains.some((chain) => chain.startsWith(`${call}()`))) {
        callers.set(call, [
          ...(callers.get(call) ?? []),
          nodePath.relative(WEB_SOURCE, path),
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
        callChains(readSource(path), ["authClient"])
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
              ),
            )
            .filter((expression) => !(expression in (read.opaqueKeys ?? {})))
            .map((expression) => `${handler}: ${expression}`)
        : [],
    );

    expect(unkeyed).toEqual([]);
  });
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
  expect(typeof selected.queryFn).toBe("function");
  expect(selected.queryKey).not.toEqual(unselected.queryKey);
  const selectedOptional = optionalOrganizationSettingsOptions({
    organizationId: ORG,
    userId: USER,
  });
  expect(selectedOptional.queryKey).toEqual(selected.queryKey);
  expect(selectedOptional.queryFn).toBe(selected.queryFn);
});

describe("the per-user read scan", () => {
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
      unwrapEden(await myTimeEntriesApi.get({ query: { date }, fetch: { signal } })),
  });
`;

    expect(unkeyedQueries(source, ["myTimeEntriesApi.get"])).toEqual([
      "myTimeEntriesKeys.day(organizationId, date)",
    ]);
    expect(
      unkeyedQueries(
        source.replace(
          "(organizationId, date)",
          "(organizationId, userId, date)",
        ),
        ["myTimeEntriesApi.get"],
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
