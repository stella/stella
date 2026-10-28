import { panic } from "better-result";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { READER_MATTER_TARGET_TYPES } from "@stll/api-contract/legal-reader-annotations";
import { READER_ANSWER_MAX_MESSAGES } from "@stll/api-contract/reader-answers";

import { member } from "@/api/db/auth-schema";
import type { rlsDb, rootDb } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  agentSkillResources,
  agentSkillRevisions,
  agentSkills,
  aiMemories,
  billingDraftUserSettings,
  chatMessageRevisions,
  chatMessages,
  chatThreads,
  legalReaderAnnotations,
  legalReaderAnswerMessages,
  legalReaderAnswers,
  savedSearches,
  savedTimeNarratives,
  searchHistoryEntries,
  templateLookupFormatUserDefaults,
  userFiles,
  userProfessionalUseAcceptances,
  workspaceViewTemplates,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import type { AnyDrizzle } from "@/api/db/scoped";
import type { AccountExportReadTransaction } from "@/api/lib/account-export/owner-read";
import { readAccountExportAnnotationPage } from "@/api/lib/account-export/owner-read";
import type { AccountExportProjections } from "@/api/lib/account-export/projections";
import type { ExportedAccountTableName } from "@/api/lib/account-export/registry";
import type { SafeId } from "@/api/lib/branded-types";
import {
  listAccountMembershipPage,
  readAccountProfileForExport,
} from "@/api/lib/db/account-row";
import { readOwnFeedbackReportPage } from "@/api/lib/db/feedback-report-store";
import { LIMITS } from "@/api/lib/limits";
import { iterateCursorPages } from "@/api/lib/pagination";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";

// Selects keep the owner connection shape; owner reads take the shared
// transaction contract, so test databases satisfy it too.
export type AccountExportDataDb = Pick<typeof rootDb, "select"> &
  AnyDrizzle<AccountExportReadTransaction>;
const ACCOUNT_EXPORT_PAGE_SIZE = 10;

const resolveScopedDatabase = async () => {
  const { rlsDb } = await import("@/api/db/root");
  return rlsDb;
};

const after = (column: AnyPgColumn, cursor: string | null) =>
  cursor === null ? undefined : sql`${column} > ${cursor}`;

/**
 * Walk one id-keyed reader in bounded pages: each page starts after the last
 * id of the page before it, and an empty page ends the walk.
 *
 * @yields Each page's rows, in reader order.
 */
const idPages = <Cursor extends string, Row extends { id: Cursor }>(
  readPage: (after: Cursor | null) => Promise<Row[]>,
  signal: AbortSignal,
) => {
  let last: Cursor | null = null;
  return iterateCursorPages(async () => {
    signal.throwIfAborted();
    const items = await readPage(last);
    last = items.at(-1)?.id ?? null;
    return { items, nextCursor: last, limit: ACCOUNT_EXPORT_PAGE_SIZE };
  });
};
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
type FeedbackReportPageRow = Awaited<
  ReturnType<typeof readOwnFeedbackReportPage>
>[number];
type ExportOrganizationPageOptions = {
  projections: AccountExportProjections;
  narrowScopedDb: ScopedDb;
  db: AccountExportDataDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  table: Exclude<
    ExportedAccountTableName,
    | "user"
    | "member"
    | "feedback_reports"
    | "user_files"
    | "user_professional_use_acceptances"
  >;
  cursor: string | null;
};

const projectRows = <T extends { id: string }>(
  rows: T[],
  project: (row: T) => unknown,
): ExportRow[] => rows.map((row) => ({ id: row.id, value: project(row) }));

type OrganizationPageQueryOptions = Omit<
  ExportOrganizationPageOptions,
  "table" | "db"
>;
type AccountExportOrganizationPageQueryOptions = Omit<
  ExportOrganizationPageOptions,
  "table" | "narrowScopedDb"
>;

const readChatThreadsPage = async ({
  projections,
  narrowScopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await narrowScopedDb(async (tx) => {
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
    return projectRows(rows, projections.chat_threads);
  });

const readChatMessagesPage = async ({
  projections,
  narrowScopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await narrowScopedDb(async (tx) => {
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
      projections.chat_messages,
    );
  });

const readChatMessageRevisionsPage = async ({
  projections,
  narrowScopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await narrowScopedDb(async (tx) => {
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
      value: projections.chat_message_revisions(row, role),
    }));
  });

const readAiMemoriesPage = async ({
  projections,
  narrowScopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await narrowScopedDb(async (tx) => {
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
    return projectRows(rows, projections.ai_memories);
  });

const readAgentSkillsPage = async ({
  projections,
  narrowScopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await narrowScopedDb(async (tx) => {
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
      value: projections.agent_skills(
        row,
        resources.filter(({ skillId }) => skillId === row.id),
      ),
    }));
  });

const readAgentSkillRevisionsPage = async ({
  projections,
  narrowScopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await narrowScopedDb(async (tx) => {
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
      projections.agent_skill_revisions,
    );
  });

const readSavedSearchesPage = async ({
  projections,
  narrowScopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await narrowScopedDb(async (tx) => {
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
          ? projections.saved_searches(row)
          : null,
    }));
  });

const readSearchHistoryPage = async ({
  projections,
  narrowScopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await narrowScopedDb(async (tx) => {
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
        value: await projections.search_history_entries(organizationId, row),
      })),
    );
  });

const readLegalReaderAnnotationsPage = async ({
  projections,
  db,
  organizationId,
  userId,
  cursor,
}: AccountExportOrganizationPageQueryOptions) => {
  const rows = await readAccountExportAnnotationPage({
    database: db,
    organizationId,
    userId,
    limit: ACCOUNT_EXPORT_PAGE_SIZE,
    extraWhere: and(
      or(
        eq(legalReaderAnnotations.visibility, "private"),
        inArray(legalReaderAnnotations.targetType, [
          ...READER_MATTER_TARGET_TYPES,
        ]),
      ),
      stillMember(organizationId, userId),
      after(legalReaderAnnotations.id, cursor),
    ),
  });
  return projectRows(rows, projections.legal_reader_annotations);
};

const readLegalReaderAnswersPage = async ({
  projections,
  narrowScopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await narrowScopedDb(async (tx) => {
    const rows = await tx
      .select()
      .from(legalReaderAnswers)
      .where(
        and(
          eq(legalReaderAnswers.organizationId, organizationId),
          eq(legalReaderAnswers.userId, userId),
          eq(legalReaderAnswers.visibility, "private"),
          isNull(legalReaderAnswers.deletedAt),
          stillMember(organizationId, userId),
          after(legalReaderAnswers.id, cursor),
        ),
      )
      .orderBy(asc(legalReaderAnswers.id))
      .limit(ACCOUNT_EXPORT_PAGE_SIZE);
    if (rows.length === 0) {
      return [];
    }
    const maximumMessages =
      ACCOUNT_EXPORT_PAGE_SIZE * READER_ANSWER_MAX_MESSAGES;
    const messages = await tx
      .select()
      .from(legalReaderAnswerMessages)
      .where(
        and(
          eq(legalReaderAnswerMessages.role, "user"),
          inArray(
            legalReaderAnswerMessages.answerId,
            rows.map(({ id }) => id),
          ),
        ),
      )
      .orderBy(
        asc(legalReaderAnswerMessages.answerId),
        asc(legalReaderAnswerMessages.sequence),
      )
      .limit(maximumMessages + 1);
    if (messages.length > maximumMessages) {
      panic("Reader answer messages exceed their owning limit");
    }
    return rows.map((row) => ({
      id: row.id,
      value: projections.legal_reader_answers(
        row,
        messages.filter(({ answerId }) => answerId === row.id),
      ),
    }));
  });

const readSavedTimeNarrativesPage = async ({
  projections,
  narrowScopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await narrowScopedDb(async (tx) => {
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
    return projectRows(rows, projections.saved_time_narratives);
  });

// One row per organization and user; the user id pages it like any other id.
const readBillingDraftSettingsPage = async ({
  projections,
  narrowScopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await narrowScopedDb(async (tx) => {
    const rows = await tx
      .select()
      .from(billingDraftUserSettings)
      .where(
        and(
          eq(billingDraftUserSettings.organizationId, organizationId),
          eq(billingDraftUserSettings.userId, userId),
          stillMember(organizationId, userId),
          after(billingDraftUserSettings.userId, cursor),
        ),
      )
      .limit(1);
    return rows.map((row) => ({
      id: row.userId,
      value: projections.billing_draft_user_settings(row),
    }));
  });

const readTemplateDefaultsPage = async ({
  projections,
  narrowScopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await narrowScopedDb(async (tx) => {
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
      value: projections.template_lookup_format_user_defaults(row),
    }));
  });

const readWorkspaceViewTemplatesPage = async ({
  projections,
  narrowScopedDb,
  organizationId,
  userId,
  cursor,
}: OrganizationPageQueryOptions) =>
  await narrowScopedDb(async (tx) => {
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
    return projectRows(rows, projections.workspace_view_templates);
  });

// Only annotations need the export-only author scope. Every other organization
// page retains the narrower empty-workspace scope.
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
    case "legal_reader_answers":
      return await readLegalReaderAnswersPage(options);
    case "saved_time_narratives":
      return await readSavedTimeNarrativesPage(options);
    case "billing_draft_user_settings":
      return await readBillingDraftSettingsPage(options);
    case "template_lookup_format_user_defaults":
      return await readTemplateDefaultsPage(options);
    case "workspace_view_templates":
      return await readWorkspaceViewTemplatesPage(options);
    default: {
      table satisfies never;
      return panic("Unhandled account export table");
    }
  }
};

type AccountExportRowsOptions = {
  projections: AccountExportProjections;
  db: AccountExportDataDb;
  userId: SafeId<"user">;
  // File metadata and bytes come from one inventory: exportAccountFiles.
  table: Exclude<ExportedAccountTableName, "user_files">;
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
  const pages = idPages(
    async (cursor) =>
      await listAccountMembershipPage({
        database: db,
        userId,
        ...(cursor === null ? {} : { after: cursor }),
      }),
    signal,
  );
  for await (const rows of pages) {
    yield* rows;
  }
}

export async function* exportAccountRows({
  projections,
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
      yield projections.user(row);
    }
    return;
  }
  if (table === "user_professional_use_acceptances") {
    const [row] = await db
      .select()
      .from(userProfessionalUseAcceptances)
      .where(eq(userProfessionalUseAcceptances.userId, userId))
      .limit(1);
    if (row !== undefined) {
      yield projections.user_professional_use_acceptances(row);
    }
    return;
  }
  if (table === "feedback_reports") {
    const pages = idPages(
      async (cursor: FeedbackReportPageRow["id"] | null) =>
        await readOwnFeedbackReportPage({
          database: db,
          userId,
          ...(cursor === null ? {} : { after: cursor }),
        }),
      signal,
    );
    for await (const rows of pages) {
      for (const row of rows) {
        yield projections.feedback_reports(row);
      }
    }
    return;
  }
  const database = scopedDatabase ?? (await resolveScopedDatabase());
  for await (const membership of accountMemberships({ db, userId, signal })) {
    signal.throwIfAborted();
    if (table === "member") {
      yield projections.member(membership);
      continue;
    }
    const organizationId = brandPersistedOrganizationId(
      membership.organizationId,
    );
    const narrowScopedDb = createScopedDb(database, [], organizationId, userId);
    const pages = idPages(
      async (cursor) =>
        await readOrganizationPage({
          projections,
          narrowScopedDb,
          db,
          organizationId,
          userId,
          table,
          cursor,
        }),
      signal,
    );
    for await (const rows of pages) {
      for (const { value } of rows) {
        if (value !== null && value !== undefined) {
          yield { organizationId, data: value };
        }
      }
    }
  }
}

type UserFileObjectsPageOptions = Pick<
  OrganizationPageQueryOptions,
  "organizationId" | "userId" | "cursor"
> & { scopedDb: ScopedDb };
const readUserFileObjectsPage = async ({
  scopedDb,
  organizationId,
  userId,
  cursor,
}: UserFileObjectsPageOptions) =>
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
    return rows.map(({ row }) => row);
  });

type AccountExportFilesOptions = Omit<AccountExportRowsOptions, "table">;
export type AccountExportFile = {
  organizationId: SafeId<"organization">;
  data: ReturnType<AccountExportProjections["user_files"]>;
  key: string;
  sizeBytes: number;
};
/**
 * The account's file inventory: each row's exported metadata together with
 * the object that holds its bytes. The archive reads it once and derives both
 * user_files.json and the file entries from that single read.
 *
 * @yields One inventoried file per user_files row, in id order per organization.
 */
export async function* exportAccountFiles({
  projections,
  db,
  userId,
  signal,
  scopedDatabase,
}: AccountExportFilesOptions): AsyncGenerator<AccountExportFile> {
  const database = scopedDatabase ?? (await resolveScopedDatabase());
  for await (const membership of accountMemberships({ db, userId, signal })) {
    const organizationId = brandPersistedOrganizationId(
      membership.organizationId,
    );
    const scopedDb = createScopedDb(database, [], organizationId, userId);
    const pages = idPages(
      async (cursor) =>
        await readUserFileObjectsPage({
          scopedDb,
          organizationId,
          userId,
          cursor,
        }),
      signal,
    );
    for await (const rows of pages) {
      for (const row of rows) {
        yield {
          organizationId,
          data: projections.user_files(row),
          key: row.s3Key,
          sizeBytes: row.sizeBytes,
        };
      }
    }
  }
}
