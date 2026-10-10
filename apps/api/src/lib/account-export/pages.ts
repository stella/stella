import { panic } from "better-result";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { member } from "@/api/db/auth-schema";
import type { rootDb, rlsDb } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  agentSkillResources,
  agentSkillRevisions,
  agentSkills,
  aiMemories,
  chatMessageRevisions,
  chatMessages,
  chatThreads,
  legalReaderAnnotations,
  savedSearches,
  savedTimeNarratives,
  searchHistoryEntries,
  templateLookupFormatUserDefaults,
  userFiles,
  workspaceViewTemplates,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { ACCOUNT_EXPORT_REGISTRY } from "@/api/lib/account-export/registry";
import type { ExportedAccountTableName } from "@/api/lib/account-export/registry";
import type { SafeId } from "@/api/lib/branded-types";
import {
  listAccountMembershipPage,
  readAccountProfileForExport,
} from "@/api/lib/db/account-row";
import { readOwnFeedbackReportPage } from "@/api/lib/db/feedback-report-store";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";

export type AccountExportDataDb = Pick<typeof rootDb, "select">;
export const ACCOUNT_EXPORT_PAGE_SIZE = 10;

const resolveScopedDatabase = async () => {
  const { rlsDb } = await import("@/api/db/root");
  return rlsDb;
};

const after = (column: AnyPgColumn, cursor: string | null) =>
  cursor === null ? undefined : sql`${column} > ${cursor}`;
const stillMember = (
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
) => sql`EXISTS (
  SELECT 1 FROM ${member} WHERE ${member.organizationId} = ${organizationId} AND ${member.userId} = ${userId}
)`;
const personalThread = (userId: SafeId<"user">) =>
  and(
    eq(chatThreads.userId, userId),
    isNull(chatThreads.workspaceId),
    sql`cardinality(${chatThreads.dataWorkspaceIds}) = 0`,
  );

type ExportRow = { id: string; value: unknown };
type ExportOrganizationPageOptions = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  table: Exclude<
    ExportedAccountTableName,
    "user" | "member" | "feedback_reports"
  >;
  cursor: string | null;
};

const projectRows = <T extends { id: string }>(
  rows: T[],
  project: (row: T) => unknown,
): ExportRow[] => rows.map((row) => ({ id: row.id, value: project(row) }));

type OrganizationPageQueryOptions = Omit<
  ExportOrganizationPageOptions,
  "table"
>;

const readChatThreadsPage = async ({
  scopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await scopedDb(async (tx) => {
    const rows = await tx
      .select()
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.organizationId, organizationId),
          personalThread(userId),
          stillMember(organizationId, userId),
          after(chatThreads.id, cursor),
        ),
      )
      .orderBy(asc(chatThreads.id))
      .limit(ACCOUNT_EXPORT_PAGE_SIZE);
    return projectRows(rows, ACCOUNT_EXPORT_REGISTRY.chat_threads.project);
  });

const readChatMessagesPage = async ({
  scopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await scopedDb(async (tx) => {
    const rows = await tx
      .select({ row: chatMessages })
      .from(chatMessages)
      .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
      .where(
        and(
          eq(chatThreads.organizationId, organizationId),
          eq(chatMessages.userId, userId),
          eq(chatMessages.role, "user"),
          isNull(chatMessages.workspaceId),
          personalThread(userId),
          stillMember(organizationId, userId),
          after(chatMessages.id, cursor),
        ),
      )
      .orderBy(asc(chatMessages.id))
      .limit(ACCOUNT_EXPORT_PAGE_SIZE);
    return projectRows(
      rows.map(({ row }) => row),
      ACCOUNT_EXPORT_REGISTRY.chat_messages.project,
    );
  });

const readChatMessageRevisionsPage = async ({
  scopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await scopedDb(async (tx) => {
    const rows = await tx
      .select({ row: chatMessageRevisions, role: chatMessages.role })
      .from(chatMessageRevisions)
      .innerJoin(
        chatMessages,
        and(
          eq(chatMessages.id, chatMessageRevisions.messageId),
          eq(chatMessages.threadId, chatMessageRevisions.threadId),
        ),
      )
      .innerJoin(chatThreads, eq(chatThreads.id, chatMessageRevisions.threadId))
      .where(
        and(
          eq(chatThreads.organizationId, organizationId),
          eq(chatMessages.userId, userId),
          eq(chatMessageRevisions.createdBy, userId),
          eq(chatMessages.role, "user"),
          isNull(chatMessageRevisions.workspaceId),
          personalThread(userId),
          stillMember(organizationId, userId),
          after(chatMessageRevisions.id, cursor),
        ),
      )
      .orderBy(asc(chatMessageRevisions.id))
      .limit(ACCOUNT_EXPORT_PAGE_SIZE);
    return rows.map(({ row, role }) => ({
      id: row.id,
      value: ACCOUNT_EXPORT_REGISTRY.chat_message_revisions.project(row, role),
    }));
  });

const readAiMemoriesPage = async ({
  scopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await scopedDb(async (tx) => {
    const rows = await tx
      .select()
      .from(aiMemories)
      .where(
        and(
          eq(aiMemories.organizationId, organizationId),
          eq(aiMemories.userId, userId),
          eq(aiMemories.scope, "user"),
          eq(aiMemories.source, "user"),
          isNull(aiMemories.workspaceId),
          sql`cardinality(${aiMemories.sourceDataWorkspaceIds}) = 0`,
          stillMember(organizationId, userId),
          after(aiMemories.id, cursor),
        ),
      )
      .orderBy(asc(aiMemories.id))
      .limit(ACCOUNT_EXPORT_PAGE_SIZE);
    return projectRows(rows, ACCOUNT_EXPORT_REGISTRY.ai_memories.project);
  });

const readAgentSkillsPage = async ({
  scopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await scopedDb(async (tx) => {
    const rows = await tx
      .select()
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.organizationId, organizationId),
          eq(agentSkills.userId, userId),
          eq(agentSkills.scope, "private"),
          stillMember(organizationId, userId),
          after(agentSkills.id, cursor),
        ),
      )
      .orderBy(asc(agentSkills.id))
      .limit(ACCOUNT_EXPORT_PAGE_SIZE);
    if (rows.length === 0) {
      return [];
    }
    const maximumResources =
      ACCOUNT_EXPORT_PAGE_SIZE * LIMITS.agentSkillResourcesPerSkill;
    const resources = await tx
      .select()
      .from(agentSkillResources)
      .where(
        and(
          eq(agentSkillResources.organizationId, organizationId),
          inArray(
            agentSkillResources.skillId,
            rows.map(({ id }) => id),
          ),
        ),
      )
      .orderBy(asc(agentSkillResources.id))
      .limit(maximumResources + 1);
    if (resources.length > maximumResources) {
      panic("Skill resources exceed their owning limit");
    }
    return rows.map((row) => ({
      id: row.id,
      value: ACCOUNT_EXPORT_REGISTRY.agent_skills.project(
        row,
        resources.filter(({ skillId }) => skillId === row.id),
      ),
    }));
  });

const readAgentSkillRevisionsPage = async ({
  scopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await scopedDb(async (tx) => {
    const rows = await tx
      .select({ row: agentSkillRevisions })
      .from(agentSkillRevisions)
      .innerJoin(agentSkills, eq(agentSkills.id, agentSkillRevisions.skillId))
      .where(
        and(
          eq(agentSkills.organizationId, organizationId),
          eq(agentSkills.userId, userId),
          eq(agentSkills.scope, "private"),
          eq(agentSkillRevisions.createdBy, userId),
          stillMember(organizationId, userId),
          after(agentSkillRevisions.id, cursor),
        ),
      )
      .orderBy(asc(agentSkillRevisions.id))
      .limit(ACCOUNT_EXPORT_PAGE_SIZE);
    return projectRows(
      rows.map(({ row }) => row),
      ACCOUNT_EXPORT_REGISTRY.agent_skill_revisions.project,
    );
  });

const readSavedSearchesPage = async ({
  scopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await scopedDb(async (tx) => {
    const rows = await tx
      .select()
      .from(savedSearches)
      .where(
        and(
          eq(savedSearches.organizationId, organizationId),
          eq(savedSearches.userId, userId),
          stillMember(organizationId, userId),
          after(savedSearches.id, cursor),
        ),
      )
      .orderBy(asc(savedSearches.id))
      .limit(ACCOUNT_EXPORT_PAGE_SIZE);
    return rows.map((row) => ({
      id: row.id,
      value:
        row.criteria.workspaceIds.length === 0 &&
        row.criteria.editedByUserIds.every((id) => id === userId)
          ? ACCOUNT_EXPORT_REGISTRY.saved_searches.project(row)
          : null,
    }));
  });

const readSearchHistoryPage = async ({
  scopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await scopedDb(async (tx) => {
    const rows = await tx
      .select()
      .from(searchHistoryEntries)
      .where(
        and(
          eq(searchHistoryEntries.organizationId, organizationId),
          eq(searchHistoryEntries.userId, userId),
          stillMember(organizationId, userId),
          after(searchHistoryEntries.id, cursor),
        ),
      )
      .orderBy(asc(searchHistoryEntries.id))
      .limit(ACCOUNT_EXPORT_PAGE_SIZE);
    return await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        value: await ACCOUNT_EXPORT_REGISTRY.search_history_entries.project(
          organizationId,
          row,
        ),
      })),
    );
  });

const readLegalReaderAnnotationsPage = async ({
  scopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await scopedDb(async (tx) => {
    const rows = await tx
      .select()
      .from(legalReaderAnnotations)
      .where(
        and(
          eq(legalReaderAnnotations.organizationId, organizationId),
          eq(legalReaderAnnotations.userId, userId),
          eq(legalReaderAnnotations.visibility, "private"),
          stillMember(organizationId, userId),
          after(legalReaderAnnotations.id, cursor),
        ),
      )
      .orderBy(asc(legalReaderAnnotations.id))
      .limit(ACCOUNT_EXPORT_PAGE_SIZE);
    return projectRows(
      rows,
      ACCOUNT_EXPORT_REGISTRY.legal_reader_annotations.project,
    );
  });

const readSavedTimeNarrativesPage = async ({
  scopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await scopedDb(async (tx) => {
    const rows = await tx
      .select()
      .from(savedTimeNarratives)
      .where(
        and(
          eq(savedTimeNarratives.organizationId, organizationId),
          eq(savedTimeNarratives.userId, userId),
          stillMember(organizationId, userId),
          after(savedTimeNarratives.id, cursor),
        ),
      )
      .orderBy(asc(savedTimeNarratives.id))
      .limit(ACCOUNT_EXPORT_PAGE_SIZE);
    return projectRows(
      rows,
      ACCOUNT_EXPORT_REGISTRY.saved_time_narratives.project,
    );
  });

const readTemplateDefaultsPage = async ({
  scopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await scopedDb(async (tx) => {
    const rows = await tx
      .select()
      .from(templateLookupFormatUserDefaults)
      .where(
        and(
          eq(templateLookupFormatUserDefaults.organizationId, organizationId),
          eq(templateLookupFormatUserDefaults.userId, userId),
          stillMember(organizationId, userId),
          after(templateLookupFormatUserDefaults.registry, cursor),
        ),
      )
      .orderBy(asc(templateLookupFormatUserDefaults.registry))
      .limit(ACCOUNT_EXPORT_PAGE_SIZE);
    return rows.map((row) => ({
      id: row.registry,
      value:
        ACCOUNT_EXPORT_REGISTRY.template_lookup_format_user_defaults.project(
          row,
        ),
    }));
  });

const readWorkspaceViewTemplatesPage = async ({
  scopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await scopedDb(async (tx) => {
    const rows = await tx
      .select()
      .from(workspaceViewTemplates)
      .where(
        and(
          eq(workspaceViewTemplates.organizationId, organizationId),
          eq(workspaceViewTemplates.userId, userId),
          stillMember(organizationId, userId),
          after(workspaceViewTemplates.id, cursor),
        ),
      )
      .orderBy(asc(workspaceViewTemplates.id))
      .limit(ACCOUNT_EXPORT_PAGE_SIZE);
    return projectRows(
      rows,
      ACCOUNT_EXPORT_REGISTRY.workspace_view_templates.project,
    );
  });

const readUserFilesPage = async ({
  scopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await scopedDb(async (tx) => {
    const rows = await tx
      .select({ row: userFiles })
      .from(userFiles)
      .innerJoin(chatThreads, eq(chatThreads.id, userFiles.threadId))
      .where(
        and(
          eq(chatThreads.organizationId, organizationId),
          eq(userFiles.userId, userId),
          personalThread(userId),
          stillMember(organizationId, userId),
          after(userFiles.id, cursor),
        ),
      )
      .orderBy(asc(userFiles.id))
      .limit(ACCOUNT_EXPORT_PAGE_SIZE);
    return projectRows(
      rows.map(({ row }) => row),
      ACCOUNT_EXPORT_REGISTRY.user_files.project,
    );
  });

// Every page runs under the requesting user's RLS scope with an empty matter
// set. Table-specific readers preserve the matching owner and membership filters.
const readOrganizationPage = async ({
  table,
  ...options
}: ExportOrganizationPageOptions): Promise<ExportRow[]> => {
  switch (table) {
    case "chat_threads":
      return await readChatThreadsPage(options);
    case "chat_messages":
      return await readChatMessagesPage(options);
    case "chat_message_revisions":
      return await readChatMessageRevisionsPage(options);
    case "ai_memories":
      return await readAiMemoriesPage(options);
    case "agent_skills":
      return await readAgentSkillsPage(options);
    case "agent_skill_revisions":
      return await readAgentSkillRevisionsPage(options);
    case "saved_searches":
      return await readSavedSearchesPage(options);
    case "search_history_entries":
      return await readSearchHistoryPage(options);
    case "legal_reader_annotations":
      return await readLegalReaderAnnotationsPage(options);
    case "saved_time_narratives":
      return await readSavedTimeNarrativesPage(options);
    case "template_lookup_format_user_defaults":
      return await readTemplateDefaultsPage(options);
    case "workspace_view_templates":
      return await readWorkspaceViewTemplatesPage(options);
    case "user_files":
      return await readUserFilesPage(options);
    default: {
      table satisfies never;
      return panic("Unhandled account export table");
    }
  }
};

type AccountExportRowsOptions = {
  db: AccountExportDataDb;
  userId: SafeId<"user">;
  table: ExportedAccountTableName;
  scopedDatabase?: typeof rlsDb;
  signal: AbortSignal;
};

type AccountMembershipOptions = Pick<
  AccountExportRowsOptions,
  "db" | "userId" | "signal"
>;
async function* accountMemberships({
  db,
  userId,
  signal,
}: AccountMembershipOptions) {
  let cursor: string | null = null;
  while (true) {
    signal.throwIfAborted();
    const page = await listAccountMembershipPage({
      database: db,
      userId,
      ...(cursor === null ? {} : { afterId: cursor }),
    });
    for (const row of page.items) {
      yield row;
    }
    if (page.nextAfterId === null) {
      return;
    }
    if (page.nextAfterId === cursor) {
      panic("Account membership cursor did not advance");
    }
    cursor = page.nextAfterId;
  }
}

export async function* exportAccountRows({
  db,
  userId,
  table,
  signal,
  scopedDatabase,
}: AccountExportRowsOptions) {
  signal.throwIfAborted();
  if (table === "user") {
    const row = await readAccountProfileForExport(db, userId);
    if (row !== undefined) {
      yield ACCOUNT_EXPORT_REGISTRY.user.project(row);
    }
    return;
  }
  if (table === "feedback_reports") {
    let cursor: string | null = null;
    while (true) {
      signal.throwIfAborted();
      const page = await readOwnFeedbackReportPage({
        database: db,
        userId,
        ...(cursor === null ? {} : { afterId: cursor }),
      });
      for (const row of page.items) {
        yield ACCOUNT_EXPORT_REGISTRY.feedback_reports.project(row);
      }
      if (page.nextAfterId === null) {
        return;
      }
      if (page.nextAfterId === cursor) {
        panic("Feedback cursor did not advance");
      }
      cursor = page.nextAfterId;
    }
  }
  const database = scopedDatabase ?? (await resolveScopedDatabase());
  for await (const membership of accountMemberships({ db, userId, signal })) {
    signal.throwIfAborted();
    if (table === "member") {
      yield ACCOUNT_EXPORT_REGISTRY.member.project(membership);
      continue;
    }
    const organizationId = brandPersistedOrganizationId(
      membership.organizationId,
    );
    const scopedDb = createScopedDb(database, [], organizationId, userId);
    let cursor: string | null = null;
    while (true) {
      signal.throwIfAborted();
      const rows = await readOrganizationPage({
        scopedDb,
        organizationId,
        userId,
        table,
        cursor,
      });
      if (rows.length === 0) {
        break;
      }
      for (const { value } of rows) {
        if (value !== null && value !== undefined) {
          yield { organizationId, data: value };
        }
      }
      const next = rows.at(-1)?.id;
      if (next === undefined || next === cursor) {
        panic("Account export cursor did not advance");
      }
      cursor = next;
    }
  }
}

type AccountExportFilesOptions = Omit<AccountExportRowsOptions, "table">;
export async function* exportAccountFiles({
  db,
  userId,
  signal,
  scopedDatabase,
}: AccountExportFilesOptions) {
  const database = scopedDatabase ?? (await resolveScopedDatabase());
  for await (const membership of accountMemberships({ db, userId, signal })) {
    const organizationId = brandPersistedOrganizationId(
      membership.organizationId,
    );
    const scopedDb = createScopedDb(database, [], organizationId, userId);
    let cursor: string | null = null;
    while (true) {
      signal.throwIfAborted();
      const pageCursor: string | null = cursor;
      const rows = await scopedDb((tx) =>
        tx
          .select({ row: userFiles })
          .from(userFiles)
          .innerJoin(chatThreads, eq(chatThreads.id, userFiles.threadId))
          .where(
            and(
              eq(chatThreads.organizationId, organizationId),
              eq(userFiles.userId, userId),
              personalThread(userId),
              stillMember(organizationId, userId),
              after(userFiles.id, pageCursor),
            ),
          )
          .orderBy(asc(userFiles.id))
          .limit(ACCOUNT_EXPORT_PAGE_SIZE),
      );
      if (rows.length === 0) {
        break;
      }
      for (const { row } of rows) {
        yield {
          path: ACCOUNT_EXPORT_REGISTRY.user_files.project(row).archivePath,
          key: row.s3Key,
          sizeBytes: row.sizeBytes,
        };
      }
      const next = rows.at(-1)?.row.id;
      if (next === undefined || next === cursor) {
        panic("Account file cursor did not advance");
      }
      cursor = next;
    }
  }
}
