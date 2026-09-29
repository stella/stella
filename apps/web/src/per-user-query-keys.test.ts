import type { QueryKey } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import { readerAnnotationKeys } from "@/components/legal-reader/annotations/reader-annotations-query";
import { savedSearchKeys } from "@/components/saved-searches.logic";
import { chatKeys } from "@/features/chat/chat-query-contract";
import { sessionsOptions } from "@/lib/account/queries";
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
import { usageLaneOptions } from "@/lib/usage-queries";
import { workspacesKeys } from "@/lib/workspaces/queries.logic";
import {
  entityViewKeys,
  entityViewsOptions,
} from "@/lib/workspaces/queries/entity-views";
import { myTimeEntriesInfiniteOptions } from "@/lib/workspaces/queries/my-time-entries";
import { reportExportsKeys } from "@/lib/workspaces/queries/report-exports";
import { timeEntriesKeys } from "@/lib/workspaces/queries/time-entries";
import { viewTemplateKeys } from "@/lib/workspaces/queries/view-templates";

// API reads that answer for the signed-in user are cached under a key that
// names that user. The manifest below lists every such read: a new handler
// that filters by the caller fails here until it is classified, and a web
// module that starts calling a listed read fails until it is listed (and its
// key checked) too.
const WEB_SOURCE = import.meta.dirname;
const API_HANDLERS = nodePath.join(WEB_SOURCE, "../../api/src/handlers");
const TEST_FILE_PATTERN = /\.(?:test|spec)\.tsx?$/u;

const ORG = "org-probe";
const USER = "user-probe";
const WORKSPACE = "workspace-probe";

type PerUserRead =
  // Cached by the web under a key checked here to carry the user id.
  | { kind: "keyed"; calls: string[]; files: string[]; keys: () => QueryKey[] }
  // Cached under a key built in a module this test cannot import: the listed
  // source must keep the user id in it.
  | { kind: "keyed-in-file"; calls: string[]; files: string[]; key: string }
  // Cached under an id that only its owner can read.
  | { kind: "owned-id"; reason: string }
  // Not called by the web today.
  | { kind: "no-web-caller"; calls: string[] }
  // Matched by the scan but not a per-user read.
  | { kind: "not-per-user"; reason: string };

const OWNED_THREAD = "cached under the thread id; threads are owner-filtered";
const OWNED_FILE = "served by URL, not cached; files are owner-filtered";
const WRITE = "a write, not cached";
const JOINS_NAMES = "joins member names; not filtered by the caller";

// Keys are handler paths under apps/api/src/handlers, or `better-auth:*` for
// reads served by the auth client.
const PER_USER_READS: Record<string, PerUserRead> = {
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
  },
  "chat/resolve-template-thread.ts": {
    kind: "keyed",
    calls: ['api.chat["template-thread"].post'],
    files: ["features/chat/queries.ts"],
    keys: () => [
      chatKeys.templateThread(ORG, { templateId: "template", userId: USER }),
    ],
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
  "docx-suggestions/resolve.ts": { kind: "not-per-user", reason: WRITE },
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
  "me/list-oauth-connections.ts": {
    kind: "keyed-in-file",
    calls: ['api.me["oauth-connections"].get'],
    files: ["routes/_protected.settings/-queries/connections.ts"],
    key: "list:(userId:string)=>[...connectedAppsKeys.all,userId]",
  },
  "me/pending-tasks.ts": {
    kind: "keyed-in-file",
    calls: ['api.me.delete["pending-tasks"].get'],
    files: ["routes/_protected.settings/account.profile.tsx"],
    key: 'queryKey:["me","delete","pending-tasks",authenticatedUser.id]',
  },
  "memories/list.ts": {
    kind: "keyed-in-file",
    calls: ["memoriesApi.get", "fetchMemoriesPage"],
    files: [
      "lib/memory-api.ts",
      "routes/_protected.settings/-queries/memories.ts",
    ],
    key: '...memoriesKeys.all(key.activeOrganizationId),key.userId,"list"',
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
  },
  "saved-searches/list.ts": {
    kind: "keyed",
    calls: ['api["saved-searches"].get'],
    files: ["components/saved-searches.tsx"],
    keys: () => [savedSearchKeys.list({ organizationId: ORG, userId: USER })],
  },
  "saved-time-narratives/list.ts": {
    kind: "keyed-in-file",
    calls: ['api["saved-time-narratives"].get'],
    files: [
      "routes/_protected.workspaces/$workspaceId/-components/billing/saved-time-narratives.tsx",
    ],
    key: 'list:(organizationId:string,userId:string)=>["saved-time-narratives",organizationId,userId]',
  },
  "sharepoint/list-drive-root.ts": {
    kind: "no-web-caller",
    calls: ["api.sharepoint.drive.root.get"],
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
  "templates/lookup-formats/list.ts": {
    kind: "keyed-in-file",
    calls: ['api.templates["lookup-formats"].get'],
    files: ["components/company-format-library.tsx"],
    key: '["company-output-formats",organizationId,userId,registry]',
  },
  "time-entries/get.ts": { kind: "not-per-user", reason: JOINS_NAMES },
  "time-entries/list.ts": {
    kind: "keyed",
    calls: ["fetchTimeEntries"],
    files: ["lib/workspaces/queries/time-entries.ts"],
    keys: () => [
      timeEntriesKeys.personalList(WORKSPACE, USER, { scope: "me" }),
      timeEntriesKeys.activeTimer(WORKSPACE, USER),
    ],
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
  "usage/get-lane.ts": {
    kind: "keyed",
    calls: ["api.usage.lane.get"],
    files: ["lib/usage-queries.ts"],
    keys: () => [
      usageLaneOptions({ organizationId: ORG, userId: USER }).queryKey,
    ],
  },
  "user-files/read-content.ts": { kind: "owned-id", reason: OWNED_FILE },
  "user-files/read-thumbnail.ts": { kind: "owned-id", reason: OWNED_FILE },
  "view-templates/list.ts": {
    kind: "keyed",
    calls: ['api["view-templates"]().get'],
    files: ["lib/workspaces/queries/view-templates.ts"],
    keys: () => [viewTemplateKeys.all({ organizationId: ORG, userId: USER })],
  },
  "work-obligations/queues/list.ts": {
    kind: "no-web-caller",
    calls: ['api["my-work"].get'],
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
  },
  "better-auth:list-sessions": {
    kind: "keyed",
    calls: ["authClient.listSessions", "listAuthSessions"],
    files: ["lib/auth-client.ts", "lib/account/queries.ts"],
    keys: () => [sessionsOptions(USER).queryKey],
  },
  "better-auth:list-organizations": {
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

// A read handler (by file name) that filters rows by the caller.
const READ_HANDLER_NAME =
  /\/(?:list|get|read|count|resolve|summary|pending)[^/]*\.ts$/u;
const FILTERS_BY_CALLER =
  /(?:userId|requestedBy|ownerUserId|createdBy)[^\n]{0,20}(?:ctx\.)?user\.id|userId:\s*(?:ctx\.)?user\.id|currentUserId:\s*user\.id/u;

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

/** Whitespace-free source, so a key reads the same however it is wrapped. */
const compact = (source: string) =>
  source
    .replaceAll(/\s+/gu, " ")
    .replaceAll(/ ?([.,:;()[\]{}=>]) ?/gu, "$1")
    .replaceAll(/,([)\]}])/gu, "$1");

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

/** Web files calling each listed read, relative to src/. */
const webCallers = () => {
  const calls = Object.values(PER_USER_READS).flatMap(callsOf);
  const roots = [
    ...new Set(calls.map((call) => call.split(/[.[(]/u)[0] ?? call)),
  ];
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

describe("per-user reads", () => {
  test("every read handler that filters by the caller is classified", () => {
    const unclassified = listFiles(API_HANDLERS)
      .map((path) => nodePath.relative(API_HANDLERS, path))
      .filter((path) => READ_HANDLER_NAME.test(`/${path}`))
      .filter((path) =>
        FILTERS_BY_CALLER.test(readSource(nodePath.join(API_HANDLERS, path))),
      )
      .filter((path) => !(path in PER_USER_READS));

    expect(unclassified).toEqual([]);
  });

  test("every classified handler still exists", () => {
    const missing = Object.keys(PER_USER_READS)
      .filter((path) => !path.startsWith("better-auth:"))
      .filter((path) => !existsSync(nodePath.join(API_HANDLERS, path)));

    expect(missing).toEqual([]);
  });

  test("cached per-user reads are called only from the listed modules", () => {
    const callers = webCallers();
    for (const [handler, read] of Object.entries(PER_USER_READS)) {
      const calledFrom = [
        ...new Set(callsOf(read).flatMap((call) => callers.get(call) ?? [])),
      ].toSorted();
      const listed = "files" in read ? read.files.toSorted() : [];

      expect({ handler, calledFrom }).toEqual({ handler, calledFrom: listed });
    }
  });

  test("their query keys carry the user id", () => {
    for (const [handler, read] of Object.entries(PER_USER_READS)) {
      if (read.kind === "keyed") {
        for (const key of read.keys()) {
          expect({ handler, keyed: containsValue(key, USER) }).toEqual({
            handler,
            keyed: true,
          });
        }
      }
      if (read.kind === "keyed-in-file") {
        const sources = read.files.map((file) =>
          compact(readSource(nodePath.join(WEB_SOURCE, file))),
        );

        expect({
          handler,
          keyed: sources.some((source) => source.includes(read.key)),
        }).toEqual({ handler, keyed: true });
      }
    }
  });
});
