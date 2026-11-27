/**
 * Adversarial runtime isolation suite for Search, RAG/passage retrieval, and
 * Chat context assembly running against a real PGlite database.
 *
 * Drives the production request handles (`createMembershipScopedDb`,
 * `createMembershipSafeDb`) through real handlers, retrieval queries, chat
 * history tools, and system-prompt/memory context builders across five
 * adversarial boundaries:
 *
 * 1. Cross-tenant (Org A owner -> Org B matters, documents, preview passages,
 *    contacts, chat threads, messages, revisions, file-thread mappings,
 *    active-draft contexts, and AI memories)
 * 2. Intra-org ethical wall & user privacy (Org A member assigned to
 *    accessible matters -> unassigned confidential matter documents, passages,
 *    contacts, other-user private chats/memories, spanning multi-matter threads
 *    via `data_workspace_ids`, matter-sourced memories via
 *    `source_data_workspace_ids`, and mention/attachment context leakage)
 * 3. Token scope (`grantedScopes`) & workspace narrowing
 * 4. Existence / type oracle uniformity across search, facets, preview,
 *    search-summary chat creation, and chat-history expansion
 * 5. Live membership revocation (removing a `workspace_members` row immediately
 *    denies search, RAG/passage previews, matter search context, chat reads,
 *    past-chat tools, and AI memory injection)
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import type { EntityKind } from "@stll/api-contract";
import { USER_FILE_URL_PREFIX } from "@stll/api-contract/user-file-url";

import { member, organization, user } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  aiMemories,
  chatMessageRevisions,
  chatMessages,
  chatThreads,
  contacts,
  contactSearchDocumentPreviewPassages,
  contactSearchDocuments,
  entities,
  entityVersions,
  fields,
  fileChatThreads,
  properties,
  searchDocumentPreviewPassages,
  searchDocuments,
  userFiles,
  workspaceMembers,
  workspaces,
  workspaceSearchDocumentPreviewPassages,
  workspaceSearchDocuments,
} from "@/api/db/schema";
import { TRANSACTION_DEADLINE } from "@/api/db/scoped";
import { buildChatSystemPromptParts } from "@/api/handlers/chat/chat-prompt";
import { readChatRevisionContextChanges } from "@/api/handlers/chat/chat-revision-context";
import { readFileChatThreadMapping } from "@/api/handlers/chat/file-thread-mapping";
import { buildMemoryPromptParts } from "@/api/handlers/chat/memory-context";
import { loadChatMessagePage } from "@/api/handlers/chat/message-page";
import { readChatThreadContexts } from "@/api/handlers/chat/threads/list-context";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import {
  createChatHistoryTools,
  EXPAND_CHAT_HISTORY_TOOL_NAME,
  SEARCH_CHAT_HISTORY_TOOL_NAME,
} from "@/api/handlers/chat/tools/chat-history-tools";
import {
  createPastChatTools,
  PAST_CHAT_SCOPE_TYPE,
  SEARCH_ALL_PAST_CHATS_TOOL_NAME,
  SEARCH_PAST_CHATS_TOOL_NAME,
} from "@/api/handlers/chat/tools/past-chat-tools";
import { buildMcpContextFromChat } from "@/api/handlers/chat/tools/registry-adapter/mcp-chat-context";
import { runRegistryReadTool } from "@/api/handlers/chat/tools/registry-adapter/run-registry-tool";
import {
  createSearchSummaryChatThread,
  loadMatterSearchContexts,
} from "@/api/handlers/search/ai";
import { searchFacetsHandler } from "@/api/handlers/search/facets";
import { searchPreviewHandler } from "@/api/handlers/search/preview";
import { searchHandler } from "@/api/handlers/search/search";
import { NO_SKILL_BINDING_SCOPE } from "@/api/lib/agent-skills/binding";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import {
  createGeneratedDocumentActiveDraftContext,
  hasPersistedGeneratedDocumentActiveDraftContext,
} from "@/api/lib/chat/active-draft-context";
import { proveTextOnlyPersistedChatMessageContent } from "@/api/lib/chat/persisted-message-content";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import {
  AI_MEMORY_FEATURE_ID,
  FEATURE_REGISTRY,
} from "@/api/lib/feature-access/registry";
import type { FileKey } from "@/api/lib/file-key";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";
import type { GlobalSearchResultType } from "@/api/lib/search/types";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { createMcpOperationDatabases } from "@/api/mcp/context";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  executeRowsDatabase,
  executeRowsSafeDb,
  executeRowsScopedDb,
} from "@/api/tests/helpers/pglite-rows-scoped-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// timeout: PGlite database bootstrap and multi-tenant search/chat fixture seeding
setDefaultTimeout(60_000);

const FIXED_CREATED_AT = new Date("2026-06-15T10:00:00.000Z");
const FIXED_UPDATED_AT = new Date("2026-06-16T10:00:00.000Z");
const SHARED_NEEDLE = "zephyrcanary";
const PREVIEW_GENERATION = "00000000-0000-4000-8000-00000000a111";

type Actor = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  email: string;
};

type Fixture = {
  orgA: SafeId<"organization">;
  orgB: SafeId<"organization">;
  ownerA: Actor;
  memberA: Actor;
  ownerB: Actor;
  matterA_accessible: SafeId<"workspace">;
  matterA_other: SafeId<"workspace">;
  matterA_restricted: SafeId<"workspace">;
  matterB: SafeId<"workspace">;
  contactA_accessible: SafeId<"contact">;
  contactA_restricted: SafeId<"contact">;
  contactB: SafeId<"contact">;
  docA1: SafeId<"entity">;
  docA_other: SafeId<"entity">;
  docA_secret: SafeId<"entity">;
  docB: SafeId<"entity">;
  fieldA1: SafeId<"field">;
  fieldA_secret: SafeId<"field">;
  fieldB: SafeId<"field">;
  threadA_member_accessible: SafeId<"chatThread">;
  threadA_member_accessible_second: SafeId<"chatThread">;
  threadA_member_other: SafeId<"chatThread">;
  threadA_member_restricted: SafeId<"chatThread">;
  threadA_member_spanning: SafeId<"chatThread">;
  threadA_member_global_mentions: SafeId<"chatThread">;
  threadA_owner_accessible: SafeId<"chatThread">;
  threadB_owner: SafeId<"chatThread">;
  msgA_member_accessible: SafeId<"chatMessage">;
  msgA_member_accessible_second: SafeId<"chatMessage">;
  msgA_member_other: SafeId<"chatMessage">;
  msgA_member_restricted: SafeId<"chatMessage">;
  msgA_member_spanning: SafeId<"chatMessage">;
  msgA_owner_accessible: SafeId<"chatMessage">;
  msgA_owner_assistant_revised: SafeId<"chatMessage">;
  msgB_owner: SafeId<"chatMessage">;
  msgB_owner_assistant_revised: SafeId<"chatMessage">;
  fileA_member_own: SafeId<"userFile">;
  fileA_owner_private: SafeId<"userFile">;
  fileB_owner: SafeId<"userFile">;
  draftToolCallId_ownerA: string;
  draftToolCallId_ownerB: string;
  memA_org: SafeId<"aiMemory">;
  memA_member_user: SafeId<"aiMemory">;
  memA_owner_user: SafeId<"aiMemory">;
  memA_matter_accessible: SafeId<"aiMemory">;
  memA_matter_other: SafeId<"aiMemory">;
  memA_matter_restricted: SafeId<"aiMemory">;
  memA_user_sourced_from_restricted: SafeId<"aiMemory">;
  memA_user_sourced_from_accessible: SafeId<"aiMemory">;
  memB_org: SafeId<"aiMemory">;
};

let testDb: TestDatabase;
let fx: Fixture;

const operationDbsFor = (
  actor: Actor,
  options?: { tokenWorkspaceIds?: SafeId<"workspace">[] | undefined },
): { safeDb: SafeDb; scopedDb: ScopedDb } => {
  const { safeDb: rawSafeDb, scopedDb: rawScopedDb } =
    createMcpOperationDatabases(
      asTestRaw<Parameters<typeof createMcpOperationDatabases>[0]>(testDb),
      {
        deadline: TRANSACTION_DEADLINE.request,
        organizationId: actor.organizationId,
        serverValidatedWorkspaceIds: [],
        tokenWorkspaceIds: options?.tokenWorkspaceIds,
        userId: actor.userId,
      },
    );
  const scopedDb = executeRowsScopedDb(asTestRaw(rawScopedDb));
  const baseSafeDb = executeRowsSafeDb(rawSafeDb);
  const safeDb: SafeDb = async (fn) =>
    await baseSafeDb(async (tx) => {
      const wrappedTx = new Proxy(tx, {
        get: (target, property) => {
          if (property === "execute") {
            return async (query: Parameters<typeof tx.execute>[0]) => {
              const rows = await target.execute(query);
              if (!Array.isArray(rows)) {
                return rows;
              }
              return rows.map((row: unknown) => {
                if (
                  typeof row === "object" &&
                  row !== null &&
                  "createdAt" in row &&
                  typeof row.createdAt === "string"
                ) {
                  return {
                    ...row,
                    createdAt: new Date(row.createdAt),
                  };
                }
                return row;
              });
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function"
            ? (...args: readonly unknown[]): unknown =>
                Reflect.apply(value, target, args)
            : value;
        },
      });
      return await fn(asTestRaw(wrappedTx));
    });
  return { safeDb, scopedDb };
};

const scopedDbFor = (
  actor: Actor,
  options?: { tokenWorkspaceIds?: SafeId<"workspace">[] | undefined },
): ScopedDb => operationDbsFor(actor, options).scopedDb;

const safeDbFor = (
  actor: Actor,
  options?: { tokenWorkspaceIds?: SafeId<"workspace">[] | undefined },
): SafeDb => operationDbsFor(actor, options).safeDb;

const accessibleWorkspaceIdsFor = async (
  actor: Actor,
): Promise<SafeId<"workspace">[]> => {
  const scoped = scopedDbFor(actor);
  const rows = await scoped((tx) =>
    tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.organizationId, actor.organizationId)),
  );
  return rows.map((row) => row.id);
};

const aiMemorySnapshotFor = (actor: Actor) =>
  createFeatureAccessSnapshot({
    organizationId: actor.organizationId,
    userId: actor.userId,
    decisions: new Map([
      [
        AI_MEMORY_FEATURE_ID,
        decideFeatureAccess({
          registry: FEATURE_REGISTRY,
          featureId: AI_MEMORY_FEATURE_ID,
          organizationId: actor.organizationId,
          userId: actor.userId,
          membership: true,
          user: { email: actor.email, emailVerified: true },
          grants: {
            [AI_MEMORY_FEATURE_ID]: [
              { type: "organization", organizationId: actor.organizationId },
            ],
          },
        }),
      ],
    ]),
  });

type SearchBodyInput = Parameters<typeof searchHandler>[0]["body"];

const defaultSearchBody = (
  overrides: Partial<SearchBodyInput> = {},
): SearchBodyInput => ({
  query: SHARED_NEEDLE,
  workspaceIds: [],
  types: [] as GlobalSearchResultType[],
  kinds: [] as EntityKind[],
  editedByUserIds: [],
  mimeTypes: [],
  limit: 20,
  ...overrides,
});

const createOrgAndOwner = async (
  firmName: string,
): Promise<{ organizationId: SafeId<"organization">; owner: Actor }> => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const email = `${userId}@test.local`;
  await testDb
    .insert(user)
    .values({ id: userId, name: `${firmName} Owner`, email });
  await testDb.insert(organization).values({
    id: organizationId,
    name: firmName,
    slug: `firm-${organizationId}`,
    createdAt: FIXED_CREATED_AT,
  });
  await recordNewOrganizationAccessState(testDb, {
    organizationId,
    now: FIXED_CREATED_AT,
  });
  await testDb.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "owner",
    createdAt: FIXED_CREATED_AT,
  });
  return {
    organizationId,
    owner: { organizationId, userId, email },
  };
};

const addOrgMember = async (
  organizationId: SafeId<"organization">,
  name: string,
): Promise<Actor> => {
  const userId = mintAuthProviderId<"user">();
  const email = `${userId}@test.local`;
  await testDb.insert(user).values({ id: userId, name, email });
  await testDb.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "member",
    createdAt: FIXED_CREATED_AT,
  });
  return { organizationId, userId, email };
};

const seedContactWithSearch = async (params: {
  organizationId: SafeId<"organization">;
  displayName: string;
  searchableText: string;
}): Promise<SafeId<"contact">> => {
  const contactId = createSafeId<"contact">();
  await testDb.insert(contacts).values({
    id: contactId,
    organizationId: params.organizationId,
    type: "organization",
    displayName: params.displayName,
    createdAt: FIXED_CREATED_AT,
    updatedAt: FIXED_UPDATED_AT,
  });
  await testDb.insert(contactSearchDocuments).values({
    contactId,
    organizationId: params.organizationId,
    contactType: "organization",
    title: params.displayName,
    searchableText: params.searchableText,
    previewGeneration: PREVIEW_GENERATION,
    tsv: sql`to_tsvector('simple', unaccent(arabic_normalize(${`${params.displayName} ${params.searchableText}`})))`,
    updatedAt: FIXED_UPDATED_AT,
  });
  await testDb.insert(contactSearchDocumentPreviewPassages).values({
    contactId,
    organizationId: params.organizationId,
    generation: PREVIEW_GENERATION,
    ordinal: 0,
    content: `${params.displayName} ${params.searchableText}`,
    tsv: sql`to_tsvector('simple', unaccent(arabic_normalize(${`${params.displayName} ${params.searchableText}`})))`,
  });
  return contactId;
};

const seedMatterWithSearch = async (params: {
  organizationId: SafeId<"organization">;
  name: string;
  clientId?: SafeId<"contact">;
  searchableText: string;
}): Promise<SafeId<"workspace">> => {
  const workspaceId = createSafeId<"workspace">();
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId: params.organizationId,
    name: params.name,
    reference: `REF-${workspaceId.slice(-12)}`,
    clientId: params.clientId ?? null,
    visibility: "admins_and_assigned",
    status: "active",
    createdAt: FIXED_CREATED_AT,
  });
  await testDb.insert(workspaceSearchDocuments).values({
    workspaceId,
    organizationId: params.organizationId,
    title: params.name,
    searchableText: params.searchableText,
    previewGeneration: PREVIEW_GENERATION,
    tsv: sql`to_tsvector('simple', unaccent(arabic_normalize(${`${params.name} ${params.searchableText}`})))`,
    updatedAt: FIXED_UPDATED_AT,
  });
  await testDb.insert(workspaceSearchDocumentPreviewPassages).values({
    workspaceId,
    organizationId: params.organizationId,
    generation: PREVIEW_GENERATION,
    ordinal: 0,
    content: `${params.name} ${params.searchableText}`,
    tsv: sql`to_tsvector('simple', unaccent(arabic_normalize(${`${params.name} ${params.searchableText}`})))`,
  });
  return workspaceId;
};

const seedDocumentWithSearch = async (params: {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  name: string;
  body: string;
  editedBy: SafeId<"user">;
}): Promise<{ entityId: SafeId<"entity">; fieldId: SafeId<"field"> }> => {
  const entityId = createSafeId<"entity">();
  const versionId = createSafeId<"entityVersion">();
  const propertyId = createSafeId<"property">();
  const fieldId = createSafeId<"field">();
  const fileId = Bun.randomUUIDv7();

  await testDb.insert(properties).values({
    id: propertyId,
    workspaceId: params.workspaceId,
    name: `File Prop ${params.name}`,
    status: "fresh",
    content: { version: 1, type: "file" },
    tool: { version: 1, type: "manual-input" },
    createdAt: FIXED_CREATED_AT,
  });
  await testDb.insert(entities).values({
    id: entityId,
    workspaceId: params.workspaceId,
    kind: "document",
    name: params.name,
    displayName: params.name,
    createdBy: params.editedBy,
    lastEditedBy: params.editedBy,
    createdAt: FIXED_CREATED_AT,
    updatedAt: FIXED_UPDATED_AT,
  });
  await testDb.insert(entityVersions).values({
    id: versionId,
    entityId,
    workspaceId: params.workspaceId,
    versionNumber: 1,
    createdAt: FIXED_CREATED_AT,
  });
  await testDb
    .update(entities)
    .set({ currentVersionId: versionId })
    .where(eq(entities.id, entityId));
  await testDb.insert(fields).values({
    id: fieldId,
    entityVersionId: versionId,
    propertyId,
    workspaceId: params.workspaceId,
    content: {
      version: 1,
      type: "file",
      id: fileId,
      fileName: `${params.name}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: 1024,
      sha256Hex: "a".repeat(64),
      encrypted: false,
      pdfFileId: null,
    },
  });
  await testDb.insert(searchDocuments).values({
    entityId,
    organizationId: params.organizationId,
    workspaceId: params.workspaceId,
    kind: "document",
    title: params.name,
    searchableText: params.body,
    language: "simple",
    previewGeneration: PREVIEW_GENERATION,
    tsv: sql`to_tsvector('simple', unaccent(arabic_normalize(${`${params.name} ${params.body}`})))`,
    updatedAt: FIXED_UPDATED_AT,
  });
  await testDb.insert(searchDocumentPreviewPassages).values({
    entityId,
    organizationId: params.organizationId,
    workspaceId: params.workspaceId,
    generation: PREVIEW_GENERATION,
    ordinal: 0,
    content: `${params.name} ${params.body}`,
    tsv: sql`to_tsvector('simple', unaccent(arabic_normalize(${`${params.name} ${params.body}`})))`,
  });
  return { entityId, fieldId };
};

const seedChatThreadWithMessage = async (params: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
  dataWorkspaceIds?: SafeId<"workspace">[];
  title: string;
  userText: string;
  assistantText?: string;
  activeDraftToolCallId?: string;
  addAssistantRevision?: { beforeText: string };
}): Promise<{
  threadId: SafeId<"chatThread">;
  userMessageId: SafeId<"chatMessage">;
  assistantMessageId: SafeId<"chatMessage"> | null;
}> => {
  const threadId = createSafeId<"chatThread">();
  const userMessageId = createSafeId<"chatMessage">();
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: params.organizationId,
    userId: params.userId,
    workspaceId: params.workspaceId,
    dataWorkspaceIds: params.dataWorkspaceIds ?? [],
    title: params.title,
    createdAt: FIXED_CREATED_AT,
    updatedAt: FIXED_UPDATED_AT,
  });

  const userMetadata = params.activeDraftToolCallId
    ? {
        activeDraftContext: createGeneratedDocumentActiveDraftContext({
          originChatMessageId: userMessageId,
          originChatThreadId: threadId,
          toolCallId: params.activeDraftToolCallId,
        }),
      }
    : undefined;

  await testDb.insert(chatMessages).values({
    id: userMessageId,
    threadId,
    workspaceId: params.workspaceId,
    userId: params.userId,
    role: "user",
    content: proveTextOnlyPersistedChatMessageContent({
      version: 3,
      data: [{ type: "text", content: params.userText }],
      ...(userMetadata ? { metadata: userMetadata } : {}),
    }),
    createdAt: FIXED_CREATED_AT,
  });

  let assistantMessageId: SafeId<"chatMessage"> | null = null;
  if (params.assistantText !== undefined) {
    assistantMessageId = createSafeId<"chatMessage">();
    const hasRevision = params.addAssistantRevision !== undefined;
    await testDb.insert(chatMessages).values({
      id: assistantMessageId,
      threadId,
      workspaceId: params.workspaceId,
      userId: params.userId,
      role: "assistant",
      revision: hasRevision ? 1 : 0,
      content: proveTextOnlyPersistedChatMessageContent({
        version: 3,
        data: [{ type: "text", content: params.assistantText }],
      }),
      createdAt: new Date(FIXED_CREATED_AT.getTime() + 1000),
    });
    if (params.addAssistantRevision) {
      await testDb.insert(chatMessageRevisions).values({
        id: createSafeId<"chatMessageRevision">(),
        messageId: assistantMessageId,
        threadId,
        workspaceId: params.workspaceId,
        revision: 0,
        edit: asTestRaw({ type: "manual-edit" }),
        createdBy: params.userId,
        content: proveTextOnlyPersistedChatMessageContent({
          version: 3,
          data: [
            { type: "text", content: params.addAssistantRevision.beforeText },
          ],
        }),
        createdAt: new Date(FIXED_CREATED_AT.getTime() + 500),
      });
    }
  }

  await executeRowsDatabase(testDb).transaction(async (tx) => {
    await upsertChatThreadSearchDocument(threadId, tx);
  });

  return { threadId, userMessageId, assistantMessageId };
};

const seedMemory = async (params: {
  organizationId: SafeId<"organization">;
  scope: "organization" | "user" | "workspace";
  userId?: SafeId<"user"> | null;
  workspaceId?: SafeId<"workspace"> | null;
  sourceDataWorkspaceIds?: SafeId<"workspace">[];
  content: string;
}): Promise<SafeId<"aiMemory">> => {
  const id = createSafeId<"aiMemory">();
  await testDb.insert(aiMemories).values({
    id,
    organizationId: params.organizationId,
    scope: params.scope,
    userId: params.userId ?? null,
    workspaceId: params.workspaceId ?? null,
    sourceDataWorkspaceIds: params.sourceDataWorkspaceIds ?? [],
    kind: params.scope === "workspace" ? "fact" : "preference",
    content: params.content,
    dedupKey: id.replaceAll("-", "").padEnd(64, "0"),
    status: "active",
    pinned: false,
    source: "user",
    createdAt: FIXED_CREATED_AT,
    updatedAt: FIXED_UPDATED_AT,
    lastUsedAt: FIXED_UPDATED_AT,
  });
  return id;
};

beforeAll(async () => {
  testDb = await getTestDb();
  await testDb.execute(
    sql`CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple)`,
  );

  const firmA = await createOrgAndOwner("Firm Alpha");
  const firmB = await createOrgAndOwner("Firm Beta");
  const memberA = await addOrgMember(firmA.organizationId, "Alpha Associate");

  const contactA_accessible = await seedContactWithSearch({
    organizationId: firmA.organizationId,
    displayName: "Alpha Public Client",
    searchableText: `${SHARED_NEEDLE} ALPHA_CLIENT_ACCESSIBLE_SECRET`,
  });
  const contactA_restricted = await seedContactWithSearch({
    organizationId: firmA.organizationId,
    displayName: "Alpha Confidential Target",
    searchableText: `${SHARED_NEEDLE} ALPHA_CLIENT_RESTRICTED_SECRET`,
  });
  const contactB = await seedContactWithSearch({
    organizationId: firmB.organizationId,
    displayName: "Beta Privileged Client",
    searchableText: `${SHARED_NEEDLE} BETA_CLIENT_SECRET`,
  });

  const matterA_accessible = await seedMatterWithSearch({
    organizationId: firmA.organizationId,
    name: "Alpha Accessible Matter",
    clientId: contactA_accessible,
    searchableText: `${SHARED_NEEDLE} ALPHA_MATTER_ACCESSIBLE_BODY`,
  });
  const matterA_other = await seedMatterWithSearch({
    organizationId: firmA.organizationId,
    name: "Alpha Second Assigned Matter",
    clientId: contactA_accessible,
    searchableText: `${SHARED_NEEDLE} ALPHA_MATTER_OTHER_BODY`,
  });
  const matterA_restricted = await seedMatterWithSearch({
    organizationId: firmA.organizationId,
    name: "Alpha Ethical Wall Matter",
    clientId: contactA_restricted,
    searchableText: `${SHARED_NEEDLE} ALPHA_MATTER_RESTRICTED_BODY`,
  });
  const matterB = await seedMatterWithSearch({
    organizationId: firmB.organizationId,
    name: "Beta Foreign Matter",
    clientId: contactB,
    searchableText: `${SHARED_NEEDLE} BETA_MATTER_FOREIGN_BODY`,
  });

  // Assign memberA ONLY to matterA_accessible and matterA_other
  await testDb.insert(workspaceMembers).values([
    { workspaceId: matterA_accessible, userId: memberA.userId },
    { workspaceId: matterA_other, userId: memberA.userId },
  ]);

  const docA1Seed = await seedDocumentWithSearch({
    organizationId: firmA.organizationId,
    workspaceId: matterA_accessible,
    name: "Alpha Accessible Brief",
    body: `${SHARED_NEEDLE} ALPHA_DOC_ACCESSIBLE_PASSAGE`,
    editedBy: memberA.userId,
  });
  const docAOtherSeed = await seedDocumentWithSearch({
    organizationId: firmA.organizationId,
    workspaceId: matterA_other,
    name: "Alpha Other Assigned Brief",
    body: `${SHARED_NEEDLE} ALPHA_DOC_OTHER_PASSAGE`,
    editedBy: memberA.userId,
  });
  const docASecretSeed = await seedDocumentWithSearch({
    organizationId: firmA.organizationId,
    workspaceId: matterA_restricted,
    name: "Alpha Restricted Deal Memo",
    body: `${SHARED_NEEDLE} ALPHA_DOC_RESTRICTED_PASSAGE`,
    editedBy: firmA.owner.userId,
  });
  const docBSeed = await seedDocumentWithSearch({
    organizationId: firmB.organizationId,
    workspaceId: matterB,
    name: "Beta Foreign Brief",
    body: `${SHARED_NEEDLE} BETA_DOC_FOREIGN_PASSAGE`,
    editedBy: firmB.owner.userId,
  });

  const threadA_member_accessible = await seedChatThreadWithMessage({
    organizationId: firmA.organizationId,
    userId: memberA.userId,
    workspaceId: matterA_accessible,
    title: "Member Accessible Chat One",
    userText: `${SHARED_NEEDLE} MEMBER_ACCESSIBLE_CHAT_ONE`,
    assistantText: "Accessible answer one",
  });
  const threadA_member_accessible_second = await seedChatThreadWithMessage({
    organizationId: firmA.organizationId,
    userId: memberA.userId,
    workspaceId: matterA_accessible,
    title: "Member Accessible Chat Two",
    userText: `${SHARED_NEEDLE} MEMBER_ACCESSIBLE_CHAT_TWO`,
    assistantText: "Accessible answer two",
  });
  const threadA_member_other = await seedChatThreadWithMessage({
    organizationId: firmA.organizationId,
    userId: memberA.userId,
    workspaceId: matterA_other,
    title: "Member Other Matter Chat",
    userText: `${SHARED_NEEDLE} MEMBER_OTHER_MATTER_CHAT`,
    assistantText: "Other matter answer",
  });
  const threadA_member_restricted = await seedChatThreadWithMessage({
    organizationId: firmA.organizationId,
    userId: memberA.userId,
    workspaceId: matterA_restricted,
    title: "Member Formerly Restricted Chat",
    userText: `${SHARED_NEEDLE} MEMBER_RESTRICTED_CHAT_SECRET`,
    assistantText: "Restricted chat answer",
  });
  const threadA_member_spanning = await seedChatThreadWithMessage({
    organizationId: firmA.organizationId,
    userId: memberA.userId,
    workspaceId: null,
    dataWorkspaceIds: [matterA_accessible, matterA_restricted],
    title: "Member Spanning Ethical Wall Chat",
    userText: `${SHARED_NEEDLE} MEMBER_SPANNING_CHAT_SECRET`,
    assistantText: "Spanning answer referencing restricted matter",
  });

  const draftToolCallId_ownerA = "tc_ownerA_draft_1";
  const threadA_owner_accessible = await seedChatThreadWithMessage({
    organizationId: firmA.organizationId,
    userId: firmA.owner.userId,
    workspaceId: matterA_accessible,
    title: "Owner Private Strategy Chat",
    userText: `${SHARED_NEEDLE} OWNER_A_PRIVATE_CHAT_SECRET`,
    assistantText: "Owner private revised answer",
    activeDraftToolCallId: draftToolCallId_ownerA,
    addAssistantRevision: {
      beforeText: "Owner private BEFORE revision secret",
    },
  });

  const draftToolCallId_ownerB = "tc_ownerB_draft_1";
  const threadB_owner = await seedChatThreadWithMessage({
    organizationId: firmB.organizationId,
    userId: firmB.owner.userId,
    workspaceId: matterB,
    title: "Beta Foreign Owner Chat",
    userText: `${SHARED_NEEDLE} BETA_OWNER_CHAT_SECRET`,
    assistantText: "Beta foreign revised answer",
    activeDraftToolCallId: draftToolCallId_ownerB,
    addAssistantRevision: { beforeText: "Beta BEFORE revision secret" },
  });

  await testDb.insert(fileChatThreads).values([
    {
      id: createSafeId<"fileChatThread">(),
      organizationId: firmA.organizationId,
      workspaceId: matterA_accessible,
      entityId: docA1Seed.entityId,
      fieldId: docA1Seed.fieldId,
      userId: firmA.owner.userId,
      chatThreadId: threadA_owner_accessible.threadId,
      createdAt: FIXED_CREATED_AT,
    },
    {
      id: createSafeId<"fileChatThread">(),
      organizationId: firmB.organizationId,
      workspaceId: matterB,
      entityId: docBSeed.entityId,
      fieldId: docBSeed.fieldId,
      userId: firmB.owner.userId,
      chatThreadId: threadB_owner.threadId,
      createdAt: FIXED_CREATED_AT,
    },
  ]);

  const fileA_member_own = createSafeId<"userFile">();
  const fileA_owner_private = createSafeId<"userFile">();
  const fileB_owner = createSafeId<"userFile">();

  const threadA_member_global_mentions_id = createSafeId<"chatThread">();
  await testDb.insert(chatThreads).values({
    id: threadA_member_global_mentions_id,
    organizationId: firmA.organizationId,
    userId: memberA.userId,
    workspaceId: null,
    contextMatterIds: [matterA_accessible, matterA_restricted, matterB],
    dataWorkspaceIds: [],
    title: "Member Global Mention Probe Thread",
    createdAt: FIXED_CREATED_AT,
    updatedAt: FIXED_UPDATED_AT,
  });

  await testDb.insert(userFiles).values([
    {
      id: fileA_member_own,
      userId: memberA.userId,
      threadId: threadA_member_global_mentions_id,
      fileName: "member-own-upload.pdf",
      mimeType: "application/pdf",
      sizeBytes: 512,
      sha256Hex: "1".repeat(64),
      s3Key: asTestRaw<FileKey>(
        `${firmA.organizationId}/${fileA_member_own}.pdf`,
      ),
      createdAt: FIXED_CREATED_AT,
      updatedAt: FIXED_UPDATED_AT,
    },
    {
      id: fileA_owner_private,
      userId: firmA.owner.userId,
      threadId: threadA_owner_accessible.threadId,
      fileName: "owner-private-upload.pdf",
      mimeType: "application/pdf",
      sizeBytes: 512,
      sha256Hex: "2".repeat(64),
      s3Key: asTestRaw<FileKey>(
        `${firmA.organizationId}/${fileA_owner_private}.pdf`,
      ),
      createdAt: FIXED_CREATED_AT,
      updatedAt: FIXED_UPDATED_AT,
    },
    {
      id: fileB_owner,
      userId: firmB.owner.userId,
      threadId: threadB_owner.threadId,
      fileName: "beta-foreign-upload.pdf",
      mimeType: "application/pdf",
      sizeBytes: 512,
      sha256Hex: "3".repeat(64),
      s3Key: asTestRaw<FileKey>(`${firmB.organizationId}/${fileB_owner}.pdf`),
      createdAt: FIXED_CREATED_AT,
      updatedAt: FIXED_UPDATED_AT,
    },
  ]);

  await testDb.insert(chatMessages).values({
    id: createSafeId<"chatMessage">(),
    threadId: threadA_member_global_mentions_id,
    workspaceId: null,
    userId: memberA.userId,
    role: "user",
    content: asTestRaw({
      version: 3,
      data: [
        {
          type: "text",
          content: "Check these mentioned docs and uploads.",
        },
        {
          type: "document",
          source: {
            type: "url",
            value: `${USER_FILE_URL_PREFIX}${fileA_member_own}`,
          },
          metadata: { mimeType: "application/pdf" },
        },
        {
          type: "document",
          source: {
            type: "url",
            value: `${USER_FILE_URL_PREFIX}${fileA_owner_private}`,
          },
          metadata: { mimeType: "application/pdf" },
        },
        {
          type: "document",
          source: {
            type: "url",
            value: `${USER_FILE_URL_PREFIX}${fileB_owner}`,
          },
          metadata: { mimeType: "application/pdf" },
        },
      ],
      metadata: {
        mentions: {
          mentions: [
            { category: "entity", id: docA1Seed.entityId },
            { category: "entity", id: docASecretSeed.entityId },
            { category: "entity", id: docBSeed.entityId },
            { category: "workspace", id: matterA_accessible },
            { category: "workspace", id: matterA_restricted },
            { category: "workspace", id: matterB },
          ],
        },
      },
    }),
    createdAt: FIXED_CREATED_AT,
  });

  const memA_org = await seedMemory({
    organizationId: firmA.organizationId,
    scope: "organization",
    content: "ALPHA_FIRM_WIDE_MEMORY",
  });
  const memA_member_user = await seedMemory({
    organizationId: firmA.organizationId,
    scope: "user",
    userId: memberA.userId,
    content: "ALPHA_MEMBER_PERSONAL_MEMORY",
  });
  const memA_owner_user = await seedMemory({
    organizationId: firmA.organizationId,
    scope: "user",
    userId: firmA.owner.userId,
    content: "ALPHA_OWNER_PRIVATE_MEMORY",
  });
  const memA_matter_accessible = await seedMemory({
    organizationId: firmA.organizationId,
    scope: "workspace",
    workspaceId: matterA_accessible,
    sourceDataWorkspaceIds: [matterA_accessible],
    content: "ALPHA_MATTER_ACCESSIBLE_MEMORY",
  });
  const memA_matter_other = await seedMemory({
    organizationId: firmA.organizationId,
    scope: "workspace",
    workspaceId: matterA_other,
    sourceDataWorkspaceIds: [matterA_other],
    content: "ALPHA_MATTER_OTHER_MEMORY",
  });
  const memA_matter_restricted = await seedMemory({
    organizationId: firmA.organizationId,
    scope: "workspace",
    workspaceId: matterA_restricted,
    sourceDataWorkspaceIds: [matterA_restricted],
    content: "ALPHA_MATTER_RESTRICTED_MEMORY",
  });
  const memA_user_sourced_from_restricted = await seedMemory({
    organizationId: firmA.organizationId,
    scope: "user",
    userId: memberA.userId,
    sourceDataWorkspaceIds: [matterA_restricted],
    content: "ALPHA_MEMBER_MEMORY_DERIVED_FROM_RESTRICTED",
  });
  const memA_user_sourced_from_accessible = await seedMemory({
    organizationId: firmA.organizationId,
    scope: "user",
    userId: memberA.userId,
    sourceDataWorkspaceIds: [matterA_accessible],
    content: "ALPHA_MEMBER_MEMORY_DERIVED_FROM_ACCESSIBLE",
  });
  const memB_org = await seedMemory({
    organizationId: firmB.organizationId,
    scope: "organization",
    content: "BETA_FOREIGN_ORG_MEMORY",
  });

  if (
    !threadA_owner_accessible.assistantMessageId ||
    !threadB_owner.assistantMessageId
  ) {
    throw new TypeError("Expected assistant messages for revised threads");
  }

  fx = {
    orgA: firmA.organizationId,
    orgB: firmB.organizationId,
    ownerA: firmA.owner,
    memberA,
    ownerB: firmB.owner,
    matterA_accessible,
    matterA_other,
    matterA_restricted,
    matterB,
    contactA_accessible,
    contactA_restricted,
    contactB,
    docA1: docA1Seed.entityId,
    docA_other: docAOtherSeed.entityId,
    docA_secret: docASecretSeed.entityId,
    docB: docBSeed.entityId,
    fieldA1: docA1Seed.fieldId,
    fieldA_secret: docASecretSeed.fieldId,
    fieldB: docBSeed.fieldId,
    threadA_member_accessible: threadA_member_accessible.threadId,
    threadA_member_accessible_second: threadA_member_accessible_second.threadId,
    threadA_member_other: threadA_member_other.threadId,
    threadA_member_restricted: threadA_member_restricted.threadId,
    threadA_member_spanning: threadA_member_spanning.threadId,
    threadA_member_global_mentions: threadA_member_global_mentions_id,
    threadA_owner_accessible: threadA_owner_accessible.threadId,
    threadB_owner: threadB_owner.threadId,
    msgA_member_accessible: threadA_member_accessible.userMessageId,
    msgA_member_accessible_second:
      threadA_member_accessible_second.userMessageId,
    msgA_member_other: threadA_member_other.userMessageId,
    msgA_member_restricted: threadA_member_restricted.userMessageId,
    msgA_member_spanning: threadA_member_spanning.userMessageId,
    msgA_owner_accessible: threadA_owner_accessible.userMessageId,
    msgA_owner_assistant_revised: threadA_owner_accessible.assistantMessageId,
    msgB_owner: threadB_owner.userMessageId,
    msgB_owner_assistant_revised: threadB_owner.assistantMessageId,
    fileA_member_own,
    fileA_owner_private,
    fileB_owner,
    draftToolCallId_ownerA,
    draftToolCallId_ownerB,
    memA_org,
    memA_member_user,
    memA_owner_user,
    memA_matter_accessible,
    memA_matter_other,
    memA_matter_restricted,
    memA_user_sourced_from_restricted,
    memA_user_sourced_from_accessible,
    memB_org,
  };
});

afterAll(async () => {
  await releaseTestDb();
});

describe("1. Cross-tenant isolation (Org A owner -> Org B)", () => {
  test("global search, facets, RAG previews, and matter search contexts never leak Org B rows", async () => {
    const ownerScoped = scopedDbFor(fx.ownerA);
    const ownerWorkspaces = await accessibleWorkspaceIdsFor(fx.ownerA);

    const searchRes = await searchHandler({
      scopedDb: ownerScoped,
      organizationId: fx.ownerA.organizationId,
      userId: fx.ownerA.userId,
      accessibleWorkspaceIds: ownerWorkspaces,
      grantedScopes: undefined,
      body: defaultSearchBody(),
    });
    expect("hits" in searchRes).toBe(true);
    if ("hits" in searchRes) {
      const hitIds = searchRes.hits.map((h) => h.resource.id);
      expect(hitIds).toContain(fx.docA1);
      expect(hitIds).toContain(fx.docA_secret);
      expect(hitIds).toContain(fx.threadA_owner_accessible);
      expect(hitIds).not.toContain(fx.docB);
      expect(hitIds).not.toContain(fx.matterB);
      expect(hitIds).not.toContain(fx.contactB);
      expect(hitIds).not.toContain(fx.threadB_owner);
    }

    const facetRes = await searchFacetsHandler({
      scopedDb: ownerScoped,
      organizationId: fx.ownerA.organizationId,
      accessibleWorkspaceIds: ownerWorkspaces,
      grantedScopes: undefined,
      body: {
        facet: "workspace",
        search: "",
        ...defaultSearchBody(),
      },
    });
    expect("buckets" in facetRes).toBe(true);
    if ("buckets" in facetRes) {
      const bucketValues = facetRes.buckets.map((b) => b.value);
      expect(bucketValues).toContain(fx.matterA_accessible);
      expect(bucketValues).not.toContain(fx.matterB);
    }

    for (const [type, resultId] of [
      ["document", fx.docB],
      ["matter", fx.matterB],
      ["contact", fx.contactB],
      ["chat", fx.threadB_owner],
    ] as const) {
      const preview = await searchPreviewHandler({
        scopedDb: ownerScoped,
        query: {
          query: SHARED_NEEDLE,
          resultId,
          type,
          organizationId: fx.ownerA.organizationId,
          userId: fx.ownerA.userId,
          accessibleWorkspaceIds: ownerWorkspaces,
        },
      });
      expect(preview.isErr()).toBe(true);
      if (preview.isErr()) {
        expect(preview.error.status).toBe(404);
      }
    }

    const matterCtx = await loadMatterSearchContexts({
      accessibleWorkspaceIds: ownerWorkspaces,
      grantedScopes: undefined,
      organizationId: fx.ownerA.organizationId,
      query: SHARED_NEEDLE,
      scopedDb: ownerScoped,
      userId: fx.ownerA.userId,
      workspaceId: fx.matterB,
    });
    expect(matterCtx.isOk()).toBe(true);
    if (matterCtx.isOk()) {
      expect(matterCtx.value).toEqual([]);
    }

    // Positive authorized control: ownerB CAN search, preview, and load RAG context for Org B
    const ownerBScoped = scopedDbFor(fx.ownerB);
    const ownerBWorkspaces = await accessibleWorkspaceIdsFor(fx.ownerB);
    const ownerBSearch = await searchHandler({
      scopedDb: ownerBScoped,
      organizationId: fx.ownerB.organizationId,
      userId: fx.ownerB.userId,
      accessibleWorkspaceIds: ownerBWorkspaces,
      grantedScopes: undefined,
      body: defaultSearchBody(),
    });
    expect("hits" in ownerBSearch).toBe(true);
    if ("hits" in ownerBSearch) {
      const ownerBHitIds = ownerBSearch.hits.map((h) => h.resource.id);
      expect(ownerBHitIds).toContain(fx.docB);
      expect(ownerBHitIds).toContain(fx.matterB);
      expect(ownerBHitIds).toContain(fx.contactB);
      expect(ownerBHitIds).toContain(fx.threadB_owner);
    }
    const ownerBPreview = await searchPreviewHandler({
      scopedDb: ownerBScoped,
      query: {
        query: SHARED_NEEDLE,
        resultId: fx.docB,
        type: "document",
        organizationId: fx.ownerB.organizationId,
        userId: fx.ownerB.userId,
        accessibleWorkspaceIds: ownerBWorkspaces,
      },
    });
    expect(ownerBPreview.isOk()).toBe(true);
    if (ownerBPreview.isOk() && ownerBPreview.value.type !== "chat-messages") {
      expect(ownerBPreview.value.content).toContain("BETA_DOC_FOREIGN_PASSAGE");
    }
    const ownerBMatterCtx = await loadMatterSearchContexts({
      accessibleWorkspaceIds: ownerBWorkspaces,
      grantedScopes: undefined,
      organizationId: fx.ownerB.organizationId,
      query: SHARED_NEEDLE,
      scopedDb: ownerBScoped,
      userId: fx.ownerB.userId,
      workspaceId: fx.matterB,
    });
    expect(ownerBMatterCtx.isOk()).toBe(true);
    if (ownerBMatterCtx.isOk()) {
      expect(ownerBMatterCtx.value.map((c) => c.hit.resource.id)).toEqual([
        fx.docB,
      ]);
    }
  });

  test("chat message page, revisions, file-thread mapping, active draft, history tools, and memories deny Org B", async () => {
    const ownerSafe = safeDbFor(fx.ownerA);

    const pageRes = await loadChatMessagePage({
      safeDb: ownerSafe,
      threadId: fx.threadB_owner,
      userId: fx.ownerA.userId,
    });
    expect(pageRes.isOk()).toBe(true);
    if (pageRes.isOk()) {
      expect(pageRes.value.messages).toEqual([]);
    }

    const revRes = await readChatRevisionContextChanges({
      safeDb: ownerSafe,
      threadId: fx.threadB_owner,
      messages: [{ id: fx.msgB_owner_assistant_revised, role: "assistant" }],
    });
    expect(revRes.isOk()).toBe(true);
    if (revRes.isOk()) {
      expect(revRes.value).toEqual([]);
    }

    const mappingRes = await ownerSafe(
      async (tx) =>
        await readFileChatThreadMapping(tx, {
          entityId: fx.docB,
          fieldId: fx.fieldB,
          organizationId: fx.ownerA.organizationId,
          userId: fx.ownerA.userId,
          workspaceId: fx.matterB,
        }),
    );
    expect(mappingRes.isOk()).toBe(true);
    if (mappingRes.isOk()) {
      expect(mappingRes.value).toBeUndefined();
    }

    const draftRes = await ownerSafe(
      async (tx) =>
        await hasPersistedGeneratedDocumentActiveDraftContext({
          generatedDraft: {
            originChatMessageId: fx.msgB_owner,
            originChatThreadId: fx.threadB_owner,
            toolCallId: fx.draftToolCallId_ownerB,
          },
          organizationId: fx.ownerA.organizationId,
          threadId: fx.threadB_owner,
          tx,
          userId: fx.ownerA.userId,
        }),
    );
    expect(draftRes.isOk()).toBe(true);
    if (draftRes.isOk()) {
      expect(draftRes.value).toBe(false);
    }

    const refRegistry = createChatRefRegistry();
    const pastTools = createPastChatTools({
      organizationId: fx.ownerA.organizationId,
      refRegistry,
      safeDb: ownerSafe,
      scope: { type: PAST_CHAT_SCOPE_TYPE.allChats },
      threadId: fx.threadA_owner_accessible,
      userId: fx.ownerA.userId,
    });
    const pastRes = await pastTools[SEARCH_PAST_CHATS_TOOL_NAME].execute?.({
      query: SHARED_NEEDLE,
      limit: 20,
    });
    expect(JSON.stringify(pastRes)).not.toContain("BETA_OWNER_CHAT_SECRET");

    const historyTools = createChatHistoryTools({
      organizationId: fx.ownerA.organizationId,
      pastChatScope: { type: PAST_CHAT_SCOPE_TYPE.allChats },
      refRegistry,
      safeDb: ownerSafe,
      threadId: fx.threadA_owner_accessible,
      userId: fx.ownerA.userId,
    });
    const expandB = await historyTools[EXPAND_CHAT_HISTORY_TOOL_NAME].execute?.(
      {
        messageId: fx.msgB_owner,
        before: 2,
        after: 2,
      },
    );
    expect(expandB?.messages).toEqual([]);

    const memoryRes = await buildMemoryPromptParts({
      featureAccessSnapshot: aiMemorySnapshotFor(fx.ownerA),
      hydrateRefs: refRegistry.hydrateAssistantTextRefs,
      organizationId: fx.ownerA.organizationId,
      userId: fx.ownerA.userId,
      contextMatterIds: [fx.matterB],
      workspaceId: fx.matterA_accessible,
      safeDb: ownerSafe,
    });
    expect(memoryRes.isOk()).toBe(true);
    if (memoryRes.isOk()) {
      expect(memoryRes.value).toContain("ALPHA_FIRM_WIDE_MEMORY");
      expect(memoryRes.value).not.toContain("BETA_FOREIGN_ORG_MEMORY");
    }

    // Positive authorized control: ownerB CAN read own thread, revision, file mapping, active draft, and memory
    const ownerBSafe = safeDbFor(fx.ownerB);
    const ownerBPage = await loadChatMessagePage({
      safeDb: ownerBSafe,
      threadId: fx.threadB_owner,
      userId: fx.ownerB.userId,
    });
    expect(ownerBPage.isOk()).toBe(true);
    if (ownerBPage.isOk()) {
      expect(ownerBPage.value.messages.length).toBe(2);
    }
    const ownerBRev = await readChatRevisionContextChanges({
      safeDb: ownerBSafe,
      threadId: fx.threadB_owner,
      messages: [{ id: fx.msgB_owner_assistant_revised, role: "assistant" }],
    });
    expect(ownerBRev.isOk()).toBe(true);
    if (ownerBRev.isOk()) {
      expect(ownerBRev.value.length).toBe(1);
    }
    const ownerBMapping = await ownerBSafe(
      async (tx) =>
        await readFileChatThreadMapping(tx, {
          entityId: fx.docB,
          fieldId: fx.fieldB,
          organizationId: fx.ownerB.organizationId,
          userId: fx.ownerB.userId,
          workspaceId: fx.matterB,
        }),
    );
    expect(ownerBMapping.isOk()).toBe(true);
    if (ownerBMapping.isOk()) {
      expect(ownerBMapping.value?.mappedChatThreadId).toBe(fx.threadB_owner);
    }
    const ownerBDraft = await ownerBSafe(
      async (tx) =>
        await hasPersistedGeneratedDocumentActiveDraftContext({
          generatedDraft: {
            originChatMessageId: fx.msgB_owner,
            originChatThreadId: fx.threadB_owner,
            toolCallId: fx.draftToolCallId_ownerB,
          },
          organizationId: fx.ownerB.organizationId,
          threadId: fx.threadB_owner,
          tx,
          userId: fx.ownerB.userId,
        }),
    );
    expect(ownerBDraft.isOk()).toBe(true);
    if (ownerBDraft.isOk()) {
      expect(ownerBDraft.value).toBe(true);
    }
    const ownerBMem = await buildMemoryPromptParts({
      featureAccessSnapshot: aiMemorySnapshotFor(fx.ownerB),
      hydrateRefs: createChatRefRegistry().hydrateAssistantTextRefs,
      organizationId: fx.ownerB.organizationId,
      userId: fx.ownerB.userId,
      contextMatterIds: [],
      workspaceId: fx.matterB,
      safeDb: ownerBSafe,
    });
    expect(ownerBMem.isOk()).toBe(true);
    if (ownerBMem.isOk()) {
      expect(ownerBMem.value).toContain("BETA_FOREIGN_ORG_MEMORY");
    }
  });
});

describe("2. Intra-org ethical wall & user privacy (memberA)", () => {
  test("global search, facets, RAG previews, and matter search contexts enforce ethical wall & chat privacy", async () => {
    const memberScoped = scopedDbFor(fx.memberA);
    const memberWorkspaces = await accessibleWorkspaceIdsFor(fx.memberA);
    expect(memberWorkspaces.toSorted()).toEqual(
      [fx.matterA_accessible, fx.matterA_other].toSorted(),
    );

    const searchRes = await searchHandler({
      scopedDb: memberScoped,
      organizationId: fx.memberA.organizationId,
      userId: fx.memberA.userId,
      accessibleWorkspaceIds: memberWorkspaces,
      grantedScopes: undefined,
      body: defaultSearchBody(),
    });
    expect("hits" in searchRes).toBe(true);
    if ("hits" in searchRes) {
      const hitIds = searchRes.hits.map((h) => h.resource.id);
      expect(hitIds).toContain(fx.docA1);
      expect(hitIds).toContain(fx.docA_other);
      expect(hitIds).toContain(fx.matterA_accessible);
      expect(hitIds).toContain(fx.contactA_accessible);
      expect(hitIds).toContain(fx.threadA_member_accessible);
      expect(hitIds).not.toContain(fx.docA_secret);
      expect(hitIds).not.toContain(fx.matterA_restricted);
      expect(hitIds).not.toContain(fx.contactA_restricted);
      expect(hitIds).not.toContain(fx.threadA_owner_accessible);
      expect(hitIds).not.toContain(fx.threadA_member_restricted);
      expect(hitIds).not.toContain(fx.threadA_member_spanning);
    }

    const facetRes = await searchFacetsHandler({
      scopedDb: memberScoped,
      organizationId: fx.memberA.organizationId,
      accessibleWorkspaceIds: memberWorkspaces,
      grantedScopes: undefined,
      body: {
        facet: "workspace",
        search: "",
        ...defaultSearchBody(),
      },
    });
    expect("buckets" in facetRes).toBe(true);
    if ("buckets" in facetRes) {
      const bucketValues = facetRes.buckets.map((b) => b.value);
      expect(bucketValues).toContain(fx.matterA_accessible);
      expect(bucketValues).not.toContain(fx.matterA_restricted);
    }

    const okPreview = await searchPreviewHandler({
      scopedDb: memberScoped,
      query: {
        query: SHARED_NEEDLE,
        resultId: fx.docA1,
        type: "document",
        organizationId: fx.memberA.organizationId,
        userId: fx.memberA.userId,
        accessibleWorkspaceIds: memberWorkspaces,
      },
    });
    expect(okPreview.isOk()).toBe(true);
    if (okPreview.isOk() && okPreview.value.type !== "chat-messages") {
      expect(okPreview.value.content).toContain("ALPHA_DOC_ACCESSIBLE_PASSAGE");
    }

    for (const [type, resultId] of [
      ["document", fx.docA_secret],
      ["matter", fx.matterA_restricted],
      ["contact", fx.contactA_restricted],
      ["chat", fx.threadA_owner_accessible],
      ["chat", fx.threadA_member_restricted],
      ["chat", fx.threadA_member_spanning],
    ] as const) {
      const deniedPreview = await searchPreviewHandler({
        scopedDb: memberScoped,
        query: {
          query: SHARED_NEEDLE,
          resultId,
          type,
          organizationId: fx.memberA.organizationId,
          userId: fx.memberA.userId,
          accessibleWorkspaceIds: memberWorkspaces,
        },
      });
      expect(deniedPreview.isErr()).toBe(true);
      if (deniedPreview.isErr()) {
        expect(deniedPreview.error.status).toBe(404);
      }
    }

    const okMatterCtx = await loadMatterSearchContexts({
      accessibleWorkspaceIds: memberWorkspaces,
      grantedScopes: undefined,
      organizationId: fx.memberA.organizationId,
      query: SHARED_NEEDLE,
      scopedDb: memberScoped,
      userId: fx.memberA.userId,
      workspaceId: fx.matterA_accessible,
    });
    expect(okMatterCtx.isOk()).toBe(true);
    if (okMatterCtx.isOk()) {
      expect(okMatterCtx.value.map((c) => c.hit.resource.id)).toEqual([
        fx.docA1,
      ]);
      expect(okMatterCtx.value[0]?.content).toContain(
        "ALPHA_DOC_ACCESSIBLE_PASSAGE",
      );
    }

    const deniedMatterCtx = await loadMatterSearchContexts({
      accessibleWorkspaceIds: memberWorkspaces,
      grantedScopes: undefined,
      organizationId: fx.memberA.organizationId,
      query: SHARED_NEEDLE,
      scopedDb: memberScoped,
      userId: fx.memberA.userId,
      workspaceId: fx.matterA_restricted,
    });
    expect(deniedMatterCtx.isOk()).toBe(true);
    if (deniedMatterCtx.isOk()) {
      expect(deniedMatterCtx.value).toEqual([]);
    }

    // Positive authorized control: ownerA CAN preview & load RAG context for matterA_restricted
    const ownerAScoped = scopedDbFor(fx.ownerA);
    const ownerAWorkspaces = await accessibleWorkspaceIdsFor(fx.ownerA);
    const ownerRestrictedPreview = await searchPreviewHandler({
      scopedDb: ownerAScoped,
      query: {
        query: SHARED_NEEDLE,
        resultId: fx.docA_secret,
        type: "document",
        organizationId: fx.ownerA.organizationId,
        userId: fx.ownerA.userId,
        accessibleWorkspaceIds: ownerAWorkspaces,
      },
    });
    expect(ownerRestrictedPreview.isOk()).toBe(true);
    if (
      ownerRestrictedPreview.isOk() &&
      ownerRestrictedPreview.value.type !== "chat-messages"
    ) {
      expect(ownerRestrictedPreview.value.content).toContain(
        "ALPHA_DOC_RESTRICTED_PASSAGE",
      );
    }
    const ownerRestrictedCtx = await loadMatterSearchContexts({
      accessibleWorkspaceIds: ownerAWorkspaces,
      grantedScopes: undefined,
      organizationId: fx.ownerA.organizationId,
      query: SHARED_NEEDLE,
      scopedDb: ownerAScoped,
      userId: fx.ownerA.userId,
      workspaceId: fx.matterA_restricted,
    });
    expect(ownerRestrictedCtx.isOk()).toBe(true);
    if (ownerRestrictedCtx.isOk()) {
      expect(ownerRestrictedCtx.value.map((c) => c.hit.resource.id)).toEqual([
        fx.docA_secret,
      ]);
    }
  });

  test("chat threads, mentions/attachments context, revisions, active draft, and history tools enforce ethical wall & privacy", async () => {
    const memberSafe = safeDbFor(fx.memberA);

    const ownPage = await loadChatMessagePage({
      safeDb: memberSafe,
      threadId: fx.threadA_member_accessible,
      userId: fx.memberA.userId,
    });
    expect(ownPage.isOk()).toBe(true);
    if (ownPage.isOk()) {
      expect(ownPage.value.messages.length).toBeGreaterThan(0);
    }

    for (const threadId of [
      fx.threadA_owner_accessible,
      fx.threadA_member_restricted,
      fx.threadA_member_spanning,
    ]) {
      const page = await loadChatMessagePage({
        safeDb: memberSafe,
        threadId,
        userId: fx.memberA.userId,
      });
      expect(page.isOk()).toBe(true);
      if (page.isOk()) {
        expect(page.value.messages).toEqual([]);
      }
    }

    const ctxResult = await memberSafe(
      async (tx) =>
        await readChatThreadContexts({
          previewLimit: 8,
          threadIds: [fx.threadA_member_global_mentions],
          tx,
        }),
    );
    expect(ctxResult.isOk()).toBe(true);
    if (ctxResult.isOk()) {
      const threadCtx = ctxResult.value.get(fx.threadA_member_global_mentions);
      expect(threadCtx).toBeDefined();
      const matterIds = threadCtx?.matters.map((m) => m.id) ?? [];
      const fileIds = threadCtx?.files.map((f) => f.id) ?? [];
      expect(matterIds).toEqual([fx.matterA_accessible]);
      expect(matterIds).not.toContain(fx.matterA_restricted);
      expect(matterIds).not.toContain(fx.matterB);
      expect(fileIds).toContain(fx.docA1);
      expect(fileIds).toContain(fx.fileA_member_own);
      expect(fileIds).not.toContain(fx.docA_secret);
      expect(fileIds).not.toContain(fx.docB);
      expect(fileIds).not.toContain(fx.fileA_owner_private);
      expect(fileIds).not.toContain(fx.fileB_owner);
    }

    const revRes = await readChatRevisionContextChanges({
      safeDb: memberSafe,
      threadId: fx.threadA_owner_accessible,
      messages: [{ id: fx.msgA_owner_assistant_revised, role: "assistant" }],
    });
    expect(revRes.isOk()).toBe(true);
    if (revRes.isOk()) {
      expect(revRes.value).toEqual([]);
    }

    const mappingRes = await memberSafe(
      async (tx) =>
        await readFileChatThreadMapping(tx, {
          entityId: fx.docA1,
          fieldId: fx.fieldA1,
          organizationId: fx.memberA.organizationId,
          userId: fx.memberA.userId,
          workspaceId: fx.matterA_accessible,
        }),
    );
    expect(mappingRes.isOk()).toBe(true);
    if (mappingRes.isOk()) {
      expect(mappingRes.value).toBeUndefined();
    }

    const draftRes = await memberSafe(
      async (tx) =>
        await hasPersistedGeneratedDocumentActiveDraftContext({
          generatedDraft: {
            originChatMessageId: fx.msgA_owner_accessible,
            originChatThreadId: fx.threadA_owner_accessible,
            toolCallId: fx.draftToolCallId_ownerA,
          },
          organizationId: fx.memberA.organizationId,
          threadId: fx.threadA_owner_accessible,
          tx,
          userId: fx.memberA.userId,
        }),
    );
    expect(draftRes.isOk()).toBe(true);
    if (draftRes.isOk()) {
      expect(draftRes.value).toBe(false);
    }

    const refRegistry = createChatRefRegistry();
    const matterScope = {
      type: PAST_CHAT_SCOPE_TYPE.matters,
      workspaceIds: [fx.matterA_accessible],
    } as const;
    const pastTools = createPastChatTools({
      organizationId: fx.memberA.organizationId,
      refRegistry,
      safeDb: memberSafe,
      scope: matterScope,
      threadId: fx.threadA_member_accessible,
      userId: fx.memberA.userId,
    });

    const narrowRes = await pastTools[SEARCH_PAST_CHATS_TOOL_NAME].execute?.({
      query: SHARED_NEEDLE,
      limit: 20,
    });
    expect(narrowRes?.results.map((r) => r.threadId)).toEqual([
      fx.threadA_member_accessible_second,
    ]);

    const wideTool = pastTools[SEARCH_ALL_PAST_CHATS_TOOL_NAME];
    expect(wideTool).toBeDefined();
    const wideRes = await wideTool.execute?.({
      query: SHARED_NEEDLE,
      limit: 20,
    });
    const wideThreadIds = wideRes?.results.map((r) => r.threadId) ?? [];
    expect(wideThreadIds).toContain(fx.threadA_member_accessible_second);
    expect(wideThreadIds).toContain(fx.threadA_member_other);
    expect(wideThreadIds).not.toContain(fx.threadA_member_restricted);
    expect(wideThreadIds).not.toContain(fx.threadA_member_spanning);
    expect(wideThreadIds).not.toContain(fx.threadA_owner_accessible);
    expect(wideThreadIds).not.toContain(fx.threadB_owner);

    const historyTools = createChatHistoryTools({
      organizationId: fx.memberA.organizationId,
      pastChatScope: matterScope,
      refRegistry,
      safeDb: memberSafe,
      threadId: fx.threadA_member_accessible,
      userId: fx.memberA.userId,
    });
    const selfHistory = await historyTools[
      SEARCH_CHAT_HISTORY_TOOL_NAME
    ].execute?.({ query: SHARED_NEEDLE, limit: 10 });
    expect(selfHistory?.results.map((r) => r.messageId)).toEqual([
      fx.msgA_member_accessible,
    ]);

    const expandSameMatter = await historyTools[
      EXPAND_CHAT_HISTORY_TOOL_NAME
    ].execute?.({
      messageId: fx.msgA_member_accessible_second,
      before: 1,
      after: 1,
    });
    expect(expandSameMatter?.messages.map((m) => m.messageId)).toContain(
      fx.msgA_member_accessible_second,
    );

    for (const forbiddenMsgId of [
      fx.msgA_member_other,
      fx.msgA_member_restricted,
      fx.msgA_member_spanning,
      fx.msgA_owner_accessible,
      fx.msgB_owner,
    ]) {
      const expanded = await historyTools[
        EXPAND_CHAT_HISTORY_TOOL_NAME
      ].execute?.({
        messageId: forbiddenMsgId,
        before: 2,
        after: 2,
      });
      expect(expanded?.messages).toEqual([]);
    }
  });

  test("AI memory injection & system prompt assembly enforce ethical wall, user privacy, and active-file isolation", async () => {
    const memberSafe = safeDbFor(fx.memberA);
    const refRegistry = createChatRefRegistry();
    const snapshot = aiMemorySnapshotFor(fx.memberA);

    const memoryRes = await buildMemoryPromptParts({
      featureAccessSnapshot: snapshot,
      hydrateRefs: refRegistry.hydrateAssistantTextRefs,
      organizationId: fx.memberA.organizationId,
      userId: fx.memberA.userId,
      contextMatterIds: [fx.matterA_restricted, fx.matterB],
      workspaceId: fx.matterA_accessible,
      safeDb: memberSafe,
    });
    expect(memoryRes.isOk()).toBe(true);
    if (memoryRes.isOk()) {
      expect(memoryRes.value).toContain("ALPHA_FIRM_WIDE_MEMORY");
      expect(memoryRes.value).toContain("ALPHA_MEMBER_PERSONAL_MEMORY");
      expect(memoryRes.value).toContain("ALPHA_MATTER_ACCESSIBLE_MEMORY");
      expect(memoryRes.value).toContain(
        "ALPHA_MEMBER_MEMORY_DERIVED_FROM_ACCESSIBLE",
      );
      expect(memoryRes.value).not.toContain("ALPHA_OWNER_PRIVATE_MEMORY");
      expect(memoryRes.value).not.toContain("ALPHA_MATTER_OTHER_MEMORY");
      expect(memoryRes.value).not.toContain("ALPHA_MATTER_RESTRICTED_MEMORY");
      expect(memoryRes.value).not.toContain(
        "ALPHA_MEMBER_MEMORY_DERIVED_FROM_RESTRICTED",
      );
      expect(memoryRes.value).not.toContain("BETA_FOREIGN_ORG_MEMORY");
    }

    for (const [label, entityId, fileFieldId, forbiddenName] of [
      [
        "restricted-doc",
        fx.docA_secret,
        fx.fieldA_secret,
        "Alpha Restricted Deal Memo",
      ],
      ["foreign-doc", fx.docB, fx.fieldB, "Beta Foreign Brief"],
    ] as const) {
      const promptRes = await buildChatSystemPromptParts({
        activeDecision: undefined,
        activeDraft: undefined,
        activeExternal: undefined,
        activeFile: {
          entityId,
          fileFieldId,
          fileName: "spoofed-client-name.pdf",
        },
        activeSkillContext: null,
        activeStatute: undefined,
        activeTemplate: undefined,
        contextMatterIds: [fx.matterA_restricted, fx.matterB],
        featureAccessContext: {
          featureAccessSnapshot: snapshot,
          organizationId: fx.memberA.organizationId,
          userId: fx.memberA.userId,
        },
        hasReachableMatter: true,
        messages: [],
        offeredToolNamesForSkills: () => new Set(),
        organizationId: fx.memberA.organizationId,
        organizationAIInstructions: "",
        practiceJurisdictions: [],
        refRegistry: createChatRefRegistry(),
        requestedSkillNames: new Set<string>(),
        safeDb: memberSafe,
        skillBindingScope: NO_SKILL_BINDING_SCOPE,
        threadId: fx.threadA_member_accessible,
        toolAvailability: {
          docxEditMode: null,
          folioAgentDocTools: false,
          subagents: false,
          templateAuthoring: false,
          webResearch: false,
        },
        userContext: undefined,
        userId: fx.memberA.userId,
        workspaceId: fx.matterA_accessible,
      });
      expect({ label, isOk: promptRes.isOk() }).toEqual({ label, isOk: true });
      if (promptRes.isOk()) {
        const combined = String(promptRes.value.fullPrompt);
        expect(combined).not.toContain(forbiddenName);
        expect(combined).not.toContain("spoofed-client-name.pdf");
        expect(combined).not.toContain("ALPHA_MATTER_RESTRICTED_MEMORY");
        expect(combined).not.toContain("BETA_FOREIGN_ORG_MEMORY");
      }
    }
  });
});

describe("3. Token scope (grantedScopes) & workspace narrowing", () => {
  test("grantedScopes strictly separates stella:read from stella:chat hits", async () => {
    const memberScoped = scopedDbFor(fx.memberA);
    const memberWorkspaces = await accessibleWorkspaceIdsFor(fx.memberA);

    const readOnlyRes = await searchHandler({
      scopedDb: memberScoped,
      organizationId: fx.memberA.organizationId,
      userId: fx.memberA.userId,
      accessibleWorkspaceIds: memberWorkspaces,
      grantedScopes: ["stella:read"],
      body: defaultSearchBody({ types: ["chat"] }),
    });
    expect("hits" in readOnlyRes).toBe(true);
    if ("hits" in readOnlyRes) {
      expect(readOnlyRes.hits).toEqual([]);
    }

    const chatOnlyRes = await searchHandler({
      scopedDb: memberScoped,
      organizationId: fx.memberA.organizationId,
      userId: fx.memberA.userId,
      accessibleWorkspaceIds: memberWorkspaces,
      grantedScopes: ["stella:chat"],
      body: defaultSearchBody(),
    });
    expect("hits" in chatOnlyRes).toBe(true);
    if ("hits" in chatOnlyRes) {
      expect(chatOnlyRes.hits.length).toBeGreaterThan(0);
      expect(chatOnlyRes.hits.every((h) => h.type === "chat")).toBe(true);
      expect(chatOnlyRes.hits.map((h) => h.resource.id)).toContain(
        fx.threadA_member_accessible,
      );
      expect(chatOnlyRes.hits.map((h) => h.resource.id)).not.toContain(
        fx.docA1,
      );
    }
  });

  test("tokenWorkspaceIds via createMcpOperationDatabases and chat registry-adapter pins search, previews, and MCP chat tools to the granted matter", async () => {
    const narrowedWorkspaces = [fx.matterA_accessible];
    const attenuatedScoped = scopedDbFor(fx.memberA, {
      tokenWorkspaceIds: narrowedWorkspaces,
    });

    const searchRes = await searchHandler({
      scopedDb: attenuatedScoped,
      organizationId: fx.memberA.organizationId,
      userId: fx.memberA.userId,
      accessibleWorkspaceIds: narrowedWorkspaces,
      grantedScopes: ["stella:read", "stella:chat"],
      body: defaultSearchBody(),
    });
    expect("hits" in searchRes).toBe(true);
    if ("hits" in searchRes) {
      const hitIds = searchRes.hits.map((h) => h.resource.id);
      expect(hitIds).toContain(fx.docA1);
      expect(hitIds).toContain(fx.threadA_member_accessible);
      expect(hitIds).not.toContain(fx.docA_other);
      expect(hitIds).not.toContain(fx.matterA_other);
      expect(hitIds).not.toContain(fx.threadA_member_other);
    }

    const otherPreview = await searchPreviewHandler({
      scopedDb: attenuatedScoped,
      query: {
        query: SHARED_NEEDLE,
        resultId: fx.docA_other,
        type: "document",
        organizationId: fx.memberA.organizationId,
        userId: fx.memberA.userId,
        accessibleWorkspaceIds: narrowedWorkspaces,
      },
    });
    expect(otherPreview.isErr()).toBe(true);
    if (otherPreview.isErr()) {
      expect(otherPreview.error.status).toBe(404);
    }

    // Chat registry-adapter (`buildMcpContextFromChat`) narrows toolWorkspaceIds to matterA_accessible
    // while forwarding memberA's membership DB handles: search_across_matters, list_matters, and read_document
    // must still enforce the pinned matter boundary against matterA_other, matterA_restricted, and matterB.
    const memberWorkspaces = await accessibleWorkspaceIdsFor(fx.memberA);
    const { safeDb: memberSafe, scopedDb: memberScoped } = operationDbsFor(
      fx.memberA,
    );
    const pinnedToolWorkspaces = resolveToolWorkspaceIds({
      pinnedIds: [fx.matterA_accessible],
      accessibleWorkspaceIds: memberWorkspaces,
    });
    const chatMcpContext = buildMcpContextFromChat({
      organizationId: fx.memberA.organizationId,
      userId: fx.memberA.userId,
      userEmail: fx.memberA.email,
      memberRole: sessionMemberRole("member"),
      safeDb: memberSafe,
      scopedDb: memberScoped,
      toolWorkspaceIds: pinnedToolWorkspaces,
      workspaceStatusById: new Map([
        [fx.matterA_accessible, "active"],
        [fx.matterA_other, "active"],
      ]),
    });
    const chatRefRegistry = createChatRefRegistry();

    const searchAcrossRes = await runRegistryReadTool({
      toolName: "search_across_matters",
      args: { query: SHARED_NEEDLE },
      context: chatMcpContext,
      refRegistry: chatRefRegistry,
    });
    expect(searchAcrossRes.isOk()).toBe(true);
    if (searchAcrossRes.isOk()) {
      const searchAcrossJson = JSON.stringify(searchAcrossRes.value);
      expect(searchAcrossJson).toContain("Alpha Accessible Brief");
      expect(searchAcrossJson).not.toContain("Alpha Other Assigned Brief");
      expect(searchAcrossJson).not.toContain("Alpha Restricted Deal Memo");
      expect(searchAcrossJson).not.toContain("Beta Foreign Brief");
    }

    const listMattersRes = await runRegistryReadTool({
      toolName: "list_matters",
      args: {},
      context: chatMcpContext,
      refRegistry: chatRefRegistry,
    });
    expect(listMattersRes.isOk()).toBe(true);
    if (listMattersRes.isOk()) {
      const listMattersJson = JSON.stringify(listMattersRes.value);
      expect(listMattersJson).toContain("Alpha Accessible Matter");
      expect(listMattersJson).not.toContain("Alpha Second Assigned Matter");
      expect(listMattersJson).not.toContain("Alpha Ethical Wall Matter");
      expect(listMattersJson).not.toContain("Beta Foreign Matter");
    }

    // Even if a caller pre-registers refs to out-of-scope docs, read_document must reject them
    const otherDocRef = chatRefRegistry.toEntityRef({
      entityId: fx.docA_other,
      workspaceId: fx.matterA_other,
    });
    const secretDocRef = chatRefRegistry.toEntityRef({
      entityId: fx.docA_secret,
      workspaceId: fx.matterA_restricted,
    });
    const foreignDocRef = chatRefRegistry.toEntityRef({
      entityId: fx.docB,
      workspaceId: fx.matterB,
    });
    for (const forbiddenRef of [otherDocRef, secretDocRef, foreignDocRef]) {
      const readDocRes = await runRegistryReadTool({
        toolName: "read_document",
        args: { entity_id: forbiddenRef },
        context: chatMcpContext,
        refRegistry: chatRefRegistry,
      });
      expect(readDocRes.isErr()).toBe(true);
    }
  });
});

describe("4. Existence & type oracle uniformity", () => {
  test("search, facets, preview, search-summary chat, and expand-chat-history return identical errors/empty shapes for foreign, restricted, wrong-type, and nonexistent IDs", async () => {
    const memberScoped = scopedDbFor(fx.memberA);
    const memberSafe = safeDbFor(fx.memberA);
    const memberWorkspaces = await accessibleWorkspaceIdsFor(fx.memberA);
    const missingWorkspaceId = createSafeId<"workspace">();
    const missingEntityId = createSafeId<"entity">();
    const missingMessageId = createSafeId<"chatMessage">();

    const searchErrors = await Promise.all(
      [fx.matterA_restricted, fx.matterB, missingWorkspaceId].map(
        async (workspaceId) =>
          await searchHandler({
            scopedDb: memberScoped,
            organizationId: fx.memberA.organizationId,
            userId: fx.memberA.userId,
            accessibleWorkspaceIds: memberWorkspaces,
            grantedScopes: undefined,
            body: defaultSearchBody({ workspaceIds: [workspaceId] }),
          }),
      ),
    );
    expect(searchErrors[0]).toEqual(searchErrors[2]);
    expect(searchErrors[1]).toEqual(searchErrors[2]);

    const facetErrors = await Promise.all(
      [fx.matterA_restricted, fx.matterB, missingWorkspaceId].map(
        async (workspaceId) =>
          await searchFacetsHandler({
            scopedDb: memberScoped,
            organizationId: fx.memberA.organizationId,
            accessibleWorkspaceIds: memberWorkspaces,
            grantedScopes: undefined,
            body: {
              facet: "workspace",
              search: "",
              ...defaultSearchBody({ workspaceIds: [workspaceId] }),
            },
          }),
      ),
    );
    expect(facetErrors[0]).toEqual(facetErrors[2]);
    expect(facetErrors[1]).toEqual(facetErrors[2]);

    const previewResults = await Promise.all(
      [fx.docA_secret, fx.docB, fx.matterA_accessible, missingEntityId].map(
        async (resultId) => {
          const res = await searchPreviewHandler({
            scopedDb: memberScoped,
            query: {
              query: SHARED_NEEDLE,
              resultId,
              type: "document",
              organizationId: fx.memberA.organizationId,
              userId: fx.memberA.userId,
              accessibleWorkspaceIds: memberWorkspaces,
            },
          });
          return res.isErr()
            ? {
                status: res.error.status,
                code: res.error.code,
                message: res.error.message,
              }
            : null;
        },
      ),
    );
    for (const entry of previewResults) {
      expect(entry).toEqual({
        status: 404,
        code: "not_found",
        message: "Search result not found",
      });
    }

    const summaryErrors = await Promise.all(
      [fx.matterA_restricted, fx.matterB, missingWorkspaceId].map(
        async (workspaceId) =>
          await createSearchSummaryChatThread({
            accessibleWorkspaceIds: memberWorkspaces,
            grantedScopes: undefined,
            organizationId: fx.memberA.organizationId,
            safeDb: memberSafe,
            scopedDb: memberScoped,
            userId: fx.memberA.userId,
            recordAuditEvent: async () => undefined,
            upsertSearchDocument: async () => undefined,
            body: {
              query: SHARED_NEEDLE,
              title: "Oracle Probe",
              summary: "Summary",
              citations: [{ number: 1 }],
              workspaceIds: [workspaceId],
              types: [],
              editedByUserIds: [],
              mimeTypes: [],
              limit: 5,
            },
          }),
      ),
    );
    expect(summaryErrors[0]).toEqual(summaryErrors[2]);
    expect(summaryErrors[1]).toEqual(summaryErrors[2]);

    const historyTools = createChatHistoryTools({
      organizationId: fx.memberA.organizationId,
      pastChatScope: { type: PAST_CHAT_SCOPE_TYPE.allChats },
      refRegistry: createChatRefRegistry(),
      safeDb: memberSafe,
      threadId: fx.threadA_member_accessible,
      userId: fx.memberA.userId,
    });
    for (const probeId of [
      fx.msgB_owner,
      fx.msgA_owner_accessible,
      fx.msgA_member_restricted,
      fx.msgA_member_spanning,
      missingMessageId,
    ]) {
      const res = await historyTools[EXPAND_CHAT_HISTORY_TOOL_NAME].execute?.({
        messageId: probeId,
        before: 2,
        after: 2,
      });
      expect(res).toEqual({ targetMessageId: probeId, messages: [] });
    }
  });
});

describe("5. Live membership revocation", () => {
  test("removing workspace_members immediately denies search, previews, RAG context, summary thread, chat reads, past-chat tools, and memories", async () => {
    const memberScoped = scopedDbFor(fx.memberA);
    const memberSafe = safeDbFor(fx.memberA);
    const beforeWorkspaces = await accessibleWorkspaceIdsFor(fx.memberA);

    const summaryRes = await createSearchSummaryChatThread({
      accessibleWorkspaceIds: beforeWorkspaces,
      grantedScopes: undefined,
      organizationId: fx.memberA.organizationId,
      safeDb: memberSafe,
      scopedDb: memberScoped,
      userId: fx.memberA.userId,
      featureAccessSnapshot: aiMemorySnapshotFor(fx.memberA),
      recordAuditEvent: async () => undefined,
      upsertSearchDocument: async () => undefined,
      body: {
        query: SHARED_NEEDLE,
        title: "Accessible Summary Thread",
        summary: "Summary of accessible brief [1].",
        citations: [{ number: 1 }],
        workspaceIds: [fx.matterA_accessible],
        types: ["document"],
        editedByUserIds: [],
        mimeTypes: [],
        limit: 5,
      },
    });
    expect("threadId" in summaryRes).toBe(true);
    const summaryThreadId =
      "threadId" in summaryRes ? summaryRes.threadId : null;
    expect(summaryThreadId).not.toBeNull();
    if (!summaryThreadId) {
      return;
    }

    const summaryPageBefore = await loadChatMessagePage({
      safeDb: memberSafe,
      threadId: summaryThreadId,
      userId: fx.memberA.userId,
    });
    expect(summaryPageBefore.isOk()).toBe(true);
    if (summaryPageBefore.isOk()) {
      expect(summaryPageBefore.value.messages.length).toBe(2);
    }

    await testDb
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, fx.matterA_accessible),
          eq(workspaceMembers.userId, fx.memberA.userId),
        ),
      );

    try {
      const afterWorkspaces = await accessibleWorkspaceIdsFor(fx.memberA);
      expect(afterWorkspaces).toEqual([fx.matterA_other]);

      const searchAfter = await searchHandler({
        scopedDb: memberScoped,
        organizationId: fx.memberA.organizationId,
        userId: fx.memberA.userId,
        accessibleWorkspaceIds: afterWorkspaces,
        grantedScopes: undefined,
        body: defaultSearchBody(),
      });
      expect("hits" in searchAfter).toBe(true);
      if ("hits" in searchAfter) {
        const hitIds = searchAfter.hits.map((h) => h.resource.id);
        expect(hitIds).not.toContain(fx.docA1);
        expect(hitIds).not.toContain(fx.matterA_accessible);
        expect(hitIds).not.toContain(fx.threadA_member_accessible);
        expect(hitIds).toContain(fx.docA_other);
      }

      for (const [type, resultId] of [
        ["document", fx.docA1],
        ["matter", fx.matterA_accessible],
        ["chat", fx.threadA_member_accessible],
      ] as const) {
        const previewAfter = await searchPreviewHandler({
          scopedDb: memberScoped,
          query: {
            query: SHARED_NEEDLE,
            resultId,
            type,
            organizationId: fx.memberA.organizationId,
            userId: fx.memberA.userId,
            accessibleWorkspaceIds: beforeWorkspaces,
          },
        });
        expect(previewAfter.isErr()).toBe(true);
        if (previewAfter.isErr()) {
          expect(previewAfter.error.status).toBe(404);
        }
      }

      const matterCtxAfter = await loadMatterSearchContexts({
        accessibleWorkspaceIds: beforeWorkspaces,
        grantedScopes: undefined,
        organizationId: fx.memberA.organizationId,
        query: SHARED_NEEDLE,
        scopedDb: memberScoped,
        userId: fx.memberA.userId,
        workspaceId: fx.matterA_accessible,
      });
      expect(matterCtxAfter.isOk()).toBe(true);
      if (matterCtxAfter.isOk()) {
        expect(matterCtxAfter.value).toEqual([]);
      }

      for (const threadId of [fx.threadA_member_accessible, summaryThreadId]) {
        const pageAfter = await loadChatMessagePage({
          safeDb: memberSafe,
          threadId,
          userId: fx.memberA.userId,
        });
        expect(pageAfter.isOk()).toBe(true);
        if (pageAfter.isOk()) {
          expect(pageAfter.value.messages).toEqual([]);
        }
      }

      const refRegistry = createChatRefRegistry();
      const pastToolsAfter = createPastChatTools({
        organizationId: fx.memberA.organizationId,
        refRegistry,
        safeDb: memberSafe,
        scope: { type: PAST_CHAT_SCOPE_TYPE.allChats },
        threadId: fx.threadA_member_other,
        userId: fx.memberA.userId,
      });
      const pastAfter = await pastToolsAfter[
        SEARCH_PAST_CHATS_TOOL_NAME
      ].execute?.({
        query: SHARED_NEEDLE,
        limit: 20,
      });
      const pastThreadIds = pastAfter?.results.map((r) => r.threadId) ?? [];
      expect(pastThreadIds).not.toContain(fx.threadA_member_accessible);
      expect(pastThreadIds).not.toContain(fx.threadA_member_accessible_second);

      const historyToolsAfter = createChatHistoryTools({
        organizationId: fx.memberA.organizationId,
        pastChatScope: { type: PAST_CHAT_SCOPE_TYPE.allChats },
        refRegistry,
        safeDb: memberSafe,
        threadId: fx.threadA_member_other,
        userId: fx.memberA.userId,
      });
      const expandAfter = await historyToolsAfter[
        EXPAND_CHAT_HISTORY_TOOL_NAME
      ].execute?.({
        messageId: fx.msgA_member_accessible,
        before: 2,
        after: 2,
      });
      expect(expandAfter?.messages).toEqual([]);

      const memoryAfter = await buildMemoryPromptParts({
        featureAccessSnapshot: aiMemorySnapshotFor(fx.memberA),
        hydrateRefs: refRegistry.hydrateAssistantTextRefs,
        organizationId: fx.memberA.organizationId,
        userId: fx.memberA.userId,
        contextMatterIds: [fx.matterA_accessible],
        workspaceId: fx.matterA_other,
        safeDb: memberSafe,
      });
      expect(memoryAfter.isOk()).toBe(true);
      if (memoryAfter.isOk()) {
        expect(memoryAfter.value).toContain("ALPHA_FIRM_WIDE_MEMORY");
        expect(memoryAfter.value).toContain("ALPHA_MATTER_OTHER_MEMORY");
        expect(memoryAfter.value).not.toContain(
          "ALPHA_MATTER_ACCESSIBLE_MEMORY",
        );
        expect(memoryAfter.value).not.toContain(
          "ALPHA_MEMBER_MEMORY_DERIVED_FROM_ACCESSIBLE",
        );
      }
    } finally {
      await testDb
        .insert(workspaceMembers)
        .values({
          workspaceId: fx.matterA_accessible,
          userId: fx.memberA.userId,
        })
        .onConflictDoNothing();
    }
  });
});
