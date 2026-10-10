import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { CHAT_SKILL_DOCUMENT } from "@stll/api-contract";
import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";
import {
  SIGNAL_KIND,
  SIGNAL_KIND_ORIGIN,
  SIGNAL_SEVERITY,
} from "@stll/api-contract/signals";

import { member, user as authUser } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  billingArrangements,
  caseLawResearchAnswers,
  caseLawResearchColumns,
  chatMessages,
  chatThreads,
  chatTurns,
  documentTranslationRuns,
  desktopPresence,
  entities,
  entityViews,
  entityVersions,
  fields,
  invoiceLines,
  invoices,
  legalLists,
  legalReaderAnnotations,
  numberSeries,
  notifications,
  savedTimeNarratives,
  savedSearches,
  sellerProfiles,
  signals,
  timeTimers,
  vatRates,
  WORK_OBLIGATION_STATUS,
  workObligations,
  featureEnrolments,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import readBilingualRun from "@/api/handlers/bilingual-translations/read-run";
import readBillingCodes from "@/api/handlers/billing-codes/list";
import lookupResearchAnswers from "@/api/handlers/case-law/research/answers-lookup";
import exportChatMessage from "@/api/handlers/chat/export/create";
import forkChatThread from "@/api/handlers/chat/fork/create";
import readSuggestedChatPrompts from "@/api/handlers/chat/get-suggested-prompts";
import readChatThreadRecap from "@/api/handlers/chat/get-thread-recap";
import readChatThreadTitle from "@/api/handlers/chat/get-thread-title";
import { encodeMessagePageCursor } from "@/api/handlers/chat/message-page";
import listChatMessages from "@/api/handlers/chat/messages/list";
import listOlderChatMessages from "@/api/handlers/chat/older-messages/list";
import readFileChatThread from "@/api/handlers/chat/read-file-thread";
import resolveFileChatThread from "@/api/handlers/chat/resolve-file-thread";
import resolveTemplateChatThread from "@/api/handlers/chat/resolve-template-thread";
import rotateTemplateChatThread from "@/api/handlers/chat/rotate-template-thread";
import { createSendMessage } from "@/api/handlers/chat/send-message";
import { compactMessagesForContext } from "@/api/handlers/chat/send-message-compaction";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import listUnavailableChatSkills from "@/api/handlers/chat/skill-availability/list";
import { createSuggestThreadTitle } from "@/api/handlers/chat/suggest-thread-title";
import { RECAP_PROMPT_VERSION } from "@/api/handlers/chat/thread-recap";
import deleteChatThread from "@/api/handlers/chat/threads/delete";
import listChatThreads from "@/api/handlers/chat/threads/list";
import renameChatThread from "@/api/handlers/chat/threads/rename";
import updateChatThread from "@/api/handlers/chat/threads/update";
import * as externalMcpToolsModule from "@/api/handlers/chat/tools/external-mcp-tools";
import cancelChatTurn from "@/api/handlers/chat/turns/cancel";
import { joinChatTurn, probeChatTurn } from "@/api/handlers/chat/turns/resume";
import updateChatThreadModel from "@/api/handlers/chat/update-thread-model";
import readContactById from "@/api/handlers/contacts/get";
import readDesktopPresence from "@/api/handlers/desktop-presence/read";
import listDocumentReviewSources from "@/api/handlers/document-reviews/list-sources";
import readDocumentTranslationRun from "@/api/handlers/document-translations/runs/get";
import { createDocumentCompareHandler } from "@/api/handlers/documents/compare";
import listDocxSuggestions from "@/api/handlers/docx-suggestions/read";
import readEntityById from "@/api/handlers/entities/get";
import readVersionById from "@/api/handlers/entities/versions/get";
import readVersions from "@/api/handlers/entities/versions/list";
import listEntityViews from "@/api/handlers/entity-views/list";
import readExpenses from "@/api/handlers/expenses/list";
import { readEmailHtmlPreviewHandler } from "@/api/handlers/files/get";
import createInvoice from "@/api/handlers/invoices/create";
import readInvoiceById from "@/api/handlers/invoices/get";
import createInvoiceLine from "@/api/handlers/invoices/lines/create";
import updateInvoiceLine from "@/api/handlers/invoices/lines/update";
import listReaderAnnotations from "@/api/handlers/legal-reader/annotations/list";
import listLegalLists from "@/api/handlers/lists/list";
import listMemories from "@/api/handlers/memories/list";
import listNotifications from "@/api/handlers/notifications/list";
import getNumberSeries from "@/api/handlers/number-series/get";
import listNumberSeries from "@/api/handlers/number-series/list";
import getBillingArrangement from "@/api/handlers/rates/arrangement/get";
import readRateEntries from "@/api/handlers/rates/entries/list";
import listSavedSearches from "@/api/handlers/saved-searches/list";
import listSavedTimeNarratives from "@/api/handlers/saved-time-narratives/list";
import getSellerProfile from "@/api/handlers/seller-profiles/get";
import listSellerProfiles from "@/api/handlers/seller-profiles/list";
import listSignals from "@/api/handlers/signals/list";
import readTaskById from "@/api/handlers/tasks/get";
import getTemplate from "@/api/handlers/templates/get";
import readTimeEntryById from "@/api/handlers/time-entries/get";
import listAdminTimers from "@/api/handlers/time-timers/admin/list";
import stopAdminTimer from "@/api/handlers/time-timers/admin/stop";
import listMyTimeTimers from "@/api/handlers/time-timers/list";
import readUserFileContent from "@/api/handlers/user-files/read-content";
import readUserFileThumbnail from "@/api/handlers/user-files/read-thumbnail";
import listVatRates from "@/api/handlers/vat-rates/list";
import updateVatRate from "@/api/handlers/vat-rates/update";
import listMyWork from "@/api/handlers/work-obligations/queues/list";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { readFileHandler } from "@/api/lib/files/read-file";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import type { SavedSearchCriteria } from "@/api/lib/saved-searches";
import type { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

type TestHandlerContext = {
  createAuditRecorder: () => AuditRecorder;
  getActiveWorkspaceIds: () => Promise<SafeId<"workspace">[]>;
  getAccessibleWorkspaces: () => Promise<
    { id: SafeId<"workspace">; status: "active" }[]
  >;
  getWorkspaceAccess: (
    workspaceId: SafeId<"workspace">,
  ) => Promise<{ id: SafeId<"workspace">; status: "active" } | null>;
  memberRole: AuthorizedMemberRole;
  orgAIConfig: null;
  orgAIConfigStatus: "ok";
  managedAIResidency: "eu";
  promptCachingEnabled: false;
  recordAuditEvent: AuditRecorder;
  request: Request;
  route: string;
  safeDb: ReturnType<typeof createSafeDb<TestDatabaseTransaction>>;
  scopedDb: ReturnType<typeof createScopedDb<TestDatabaseTransaction>>;
  session: { activeOrganizationId: SafeId<"organization"> };
  user: { id: SafeId<"user"> };
  workspaceId: SafeId<"workspace">;
};

type IsolationContext = {
  ids: TestIds;
  sameUserWorkspaceB: TestHandlerContext;
  workspaceA: TestHandlerContext;
  workspaceB: TestHandlerContext;
};

type IsolationCase = {
  name: string;
  runAAgainstB: (context: IsolationContext) => Promise<unknown>;
  runBPositive: (context: IsolationContext) => Promise<unknown>;
  expectDenied: (result: unknown, context: IsolationContext) => void;
  expectPositive: (result: unknown, context: IsolationContext) => void;
};

const legalListAccess = ({ session, user }: TestHandlerContext) =>
  createFeatureAccessSnapshot({
    organizationId: session.activeOrganizationId,
    userId: user.id,
    decisions: new Map([
      [
        LEGAL_LISTS_FEATURE_ID,
        decideFeatureAccess({
          registry: FEATURE_REGISTRY,
          featureId: LEGAL_LISTS_FEATURE_ID,
          grants: {
            [LEGAL_LISTS_FEATURE_ID]: [
              {
                type: "organization",
                organizationId: session.activeOrganizationId,
              },
            ],
          },
          organizationId: session.activeOrganizationId,
          userId: user.id,
          user: { email: "member@example.test", emailVerified: true },
          membership: true,
        }),
      ],
    ]),
  });

let testDb: TestDatabase;
let ids: TestIds;

const noopAuditRecorder: AuditRecorder = async () => undefined;
const savedSearchA = toSafeId<"savedSearch">(
  "11111111-1111-4111-8111-111111111145",
);
const savedSearchB = toSafeId<"savedSearch">(
  "22222222-2222-4222-8222-222222222245",
);
const creditOriginalB = toSafeId<"invoice">(
  "22222222-2222-4222-8222-222222222261",
);
const sellerProfileB = toSafeId<"sellerProfile">(
  "22222222-2222-4222-8222-222222222257",
);
const invoiceLineB = toSafeId<"invoiceLine">(
  "22222222-2222-4222-8222-222222222259",
);
const manualInvoiceLineBody = {
  source: {
    type: "manual",
    description: "Isolation line",
    quantity: "1",
    unitPriceMinor: 100,
  },
  vatRateBps: 0,
  vatTreatment: "domestic_vat",
} as const;
const savedTimeNarrativeB = toSafeId<"savedTimeNarrative">(
  "22222222-2222-4222-8222-222222222258",
);
const numberSeriesB = toSafeId<"numberSeries">(
  "22222222-2222-4222-8222-222222222259",
);
const vatRateB = toSafeId<"vatRate">("22222222-2222-4222-8222-222222222260");
const entityViewB = toSafeId<"workspaceView">(
  "22222222-2222-4222-8222-222222222255",
);
const foreignSignalB = toSafeId<"signal">(
  "22222222-2222-4222-8222-222222222248",
);
const researchColumnB = toSafeId<"caseLawResearchColumn">(
  "22222222-2222-4222-8222-222222222253",
);
const visibleSignalB = toSafeId<"signal">(
  "22222222-2222-4222-8222-222222222247",
);
const legalListA = toSafeId<"legalList">(
  "11111111-1111-4111-8111-111111111146",
);
const legalListB = toSafeId<"legalList">(
  "22222222-2222-4222-8222-222222222246",
);
const documentTranslationRunB = toSafeId<"documentTranslationRun">(
  "22222222-2222-4222-8222-222222222248",
);
const documentTranslationSourceFileB = toSafeId<"userFile">(
  "22222222-2222-4222-8222-222222222249",
);
const workObligationEntityB = toSafeId<"entity">(
  "22222222-2222-4222-8222-222222222250",
);
const adminTimeTimerB = toSafeId<"timeTimer">(
  "22222222-2222-4222-8222-222222222273",
);
const stopTimeTimerB = toSafeId<"timeTimer">(
  "22222222-2222-4222-8222-222222222274",
);
const timeTimerB = toSafeId<"timeTimer">(
  "22222222-2222-4222-8222-222222222260",
);
const notificationB = toSafeId<"notification">(
  "22222222-2222-4222-8222-222222222251",
);
const readerAnnotationB = toSafeId<"legalReaderAnnotation">(
  "22222222-2222-4222-8222-222222222254",
);
const compareTargetVersionB = toSafeId<"entityVersion">(
  "22222222-2222-4222-8222-222222222253",
);
const compareTargetFieldB = toSafeId<"field">(
  "22222222-2222-4222-8222-222222222254",
);
const compareTargetFileB = toSafeId<"userFile">(
  "22222222-2222-4222-8222-222222222255",
);
const compareRedlineVersionB = toSafeId<"entityVersion">(
  "22222222-2222-4222-8222-222222222256",
);

type CompareDocumentDependencies = NonNullable<
  Parameters<typeof createDocumentCompareHandler>[0]
>;

const compareDocumentDependencies = {
  applyDisposition: async (file) => file,
  compareDocx: async () =>
    Result.ok({
      buffer: new ArrayBuffer(1),
      changes: [],
      verification: { status: "verified" },
      unsupported: [],
      compatibility: { status: "standard-ooxml" },
    }),
  createEntityVersionFromBuffer: async ({ entityId }) =>
    Result.ok({
      entityId,
      entityVersionId: compareRedlineVersionB,
      fieldId: compareTargetFieldB,
      fileName: "comparison.docx",
      versionNumber: 3,
    }),
  readEntityVersionFile: async () =>
    Result.ok(
      testScannedFile({ bytes: new ArrayBuffer(1), mimeType: DOCX_MIME_TYPE }),
    ),
  readFileHandler: async () => ({
    fileId: compareTargetFileB,
    mimeType: DOCX_MIME_TYPE,
    originalMimeType: DOCX_MIME_TYPE,
    fileName: "comparison.docx",
    encrypted: false,
    presignedUrl: "https://files.example/comparison.docx",
    stampable: false,
  }),
  resolveDocxEditAuthorName: async () => "Cross-tenant test user",
  // The isolation cases all ask for a saved version; a temporary redline never
  // reaches another tenant because the object key leads with the organization.
  deliverTemporaryRedline: async () =>
    Result.ok({
      downloadUrl: "https://files.example/redline.docx",
      expiresAt: "2026-09-20T00:00:00.000Z",
    }),
  withTimeout: async (operation) =>
    await operation(new AbortController().signal),
} satisfies CompareDocumentDependencies;

const compareDocumentVersions = createDocumentCompareHandler(
  compareDocumentDependencies,
);

// Chat threads are private to one person in one organization. The chat rows
// below belong to user A1 working in organization B, so workspace A (user
// A1, organization A) differs from their owner by the organization alone: a
// handler that filtered on the user and left the firm to chance would pass a
// case built on user B1's rows. The turn, delete and send cases get threads
// of their own, so no positive case removes what another case reads.
const chatThreadB = toSafeId<"chatThread">(
  "22222222-2222-4222-8222-222222222260",
);
const chatUserMessageB = toSafeId<"chatMessage">(
  "22222222-2222-4222-8222-222222222261",
);
const chatAssistantMessageB = toSafeId<"chatMessage">(
  "22222222-2222-4222-8222-222222222262",
);
const chatTurnThreadB = toSafeId<"chatThread">(
  "22222222-2222-4222-8222-222222222263",
);
const chatTurnUserMessageB = toSafeId<"chatMessage">(
  "22222222-2222-4222-8222-222222222264",
);
const chatTurnB = toSafeId<"chatTurn">("22222222-2222-4222-8222-222222222265");
const chatDeleteThreadB = toSafeId<"chatThread">(
  "22222222-2222-4222-8222-222222222266",
);
const chatSendThreadB = toSafeId<"chatThread">(
  "22222222-2222-4222-8222-222222222267",
);
const chatForkFromA = toSafeId<"chatThread">(
  "11111111-1111-4111-8111-111111111268",
);
const chatForkFromB = toSafeId<"chatThread">(
  "22222222-2222-4222-8222-222222222268",
);
const chatThreadTitleB = "Chat thread B";
const chatRenameFromA = "Renamed from organization A";
/** Thread B's stored model, so a foreign "auto" selection is observable. */
const chatModelB = "openai::gpt-5.4-mini";

const chatOrgAIConfig = {
  providers: [{ provider: "openai", apiKey: "test-api-key" }],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-5.4-mini" },
    fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    pdf: { provider: "openai", modelId: "gpt-5.4" },
    reasoning: { provider: "openai", modelId: "gpt-5.4" },
  },
  decision: null,
} satisfies OrgAIConfig;

// The model call is the only seam replaced: thread resolution, scope checks
// and persistence all run as they do in production, so a send that reaches
// the stream has passed every tenant boundary on the way.
const streamChatStub = mock(
  async () =>
    ({
      type: "streaming",
      response: new Response("stream started", {
        headers: { "Content-Type": "text/event-stream" },
      }),
    }) as const,
);

const sendChatMessage = createSendMessage({
  compactMessagesForContext,
  createRefRegistry: createChatRefRegistry,
  indexThread: async () => undefined,
  loadExternalMcpTools: async () => {
    const close = async () => undefined;
    return {
      close,
      connectors: [],
      source: externalMcpToolsModule.createStellaMcpToolSource({
        closeClients: close,
        sourceTools: {},
      }),
      tools: {},
    };
  },
  loadWebSearchProviders: async () => ({
    urlFetcher: null,
    webSearchProvider: null,
  }),
  rollbackSideEffects: rollbackUnpersistedChatSideEffects,
  streamResponse: asTestRaw(streamChatStub),
  uploadMessageFiles: uploadMessageFilesWithRollback,
});

const chatRecapB = "Recap of thread B";

// The model sees only the transcript the handler loaded. Answering with a
// title only when thread B's answer is in it shows the read reached B's rows.
const generateTitleFromTranscript: typeof generateTanStackTextForRole = async (
  options,
) =>
  "prompt" in options && options.prompt.includes("Here is the summary.")
    ? "Matter summary"
    : "";

const suggestChatThreadTitle = createSuggestThreadTitle({
  generateTextForRole: generateTitleFromTranscript,
});

type SendChatMessageBody = Parameters<
  typeof sendChatMessage.handler
>[0]["body"];

const chatSendRequest = (threadId: SafeId<"chatThread">, messageId: string) => {
  const message = {
    id: messageId,
    parts: [{ content: "Summarise the matter.", type: "text" }],
    role: "user",
  };
  const forwardedProps = {
    contextMatterIds: [],
    message,
    runId: `run-${messageId}`,
    sendMode: CHAT_SEND_MODE.rawOverride,
    threadId,
  };
  return {
    body: asTestRaw<SendChatMessageBody>({
      context: [],
      data: forwardedProps,
      forwardedProps,
      messages: [message],
      runId: forwardedProps.runId,
      state: {},
      threadId,
      tools: [],
    }),
    orgAIConfig: chatOrgAIConfig,
    pinServerValidatedWorkspaceId: () => false,
  };
};

/** The owner's view of a chat thread, read past RLS after a handler ran. */
const readChatThreadRow = async (threadId: SafeId<"chatThread">) =>
  (
    await testDb
      .select({
        chatModel: chatThreads.chatModel,
        title: chatThreads.title,
        webSearchEnabled: chatThreads.webSearchEnabled,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
  ).at(0) ?? null;

const countChatMessages = async (threadId: SafeId<"chatThread">) =>
  (
    await testDb
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
  ).length;

const readChatTurnRow = async (turnId: SafeId<"chatTurn">) =>
  (
    await testDb
      .select({
        cancelRequestedAt: chatTurns.cancelRequestedAt,
        status: chatTurns.status,
      })
      .from(chatTurns)
      .where(eq(chatTurns.id, turnId))
  ).at(0) ?? null;

const savedSearchCriteria = (
  workspaceId: SafeId<"workspace">,
): SavedSearchCriteria => ({
  version: 1,
  query: "agreement",
  workspaceIds: [workspaceId],
  types: ["document"],
  kinds: [],
  editedByUserIds: [],
  mimeTypes: [],
  sort: "relevance",
});

const isolationCases: IsolationCase[] = [
  ...desktopPresenceIsolationCases(),
  {
    name: "user file content",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readUserFileContent, workspaceA, {
        params: { fileId: testIds.userFileWorkspaceB1UserA1 },
      }),
    runBPositive: async ({ ids: testIds, sameUserWorkspaceB }) =>
      await runHandler(readUserFileContent, sameUserWorkspaceB, {
        params: { fileId: testIds.userFileWorkspaceB1UserA1 },
      }),
    expectDenied: expectStatus(404),
    expectPositive: expectStatus(302),
  },
  {
    name: "user file thumbnail",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readUserFileThumbnail, workspaceA, {
        params: { fileId: testIds.userFileWorkspaceB1UserA1 },
      }),
    runBPositive: async ({ ids: testIds, sameUserWorkspaceB }) =>
      await runHandler(readUserFileThumbnail, sameUserWorkspaceB, {
        params: { fileId: testIds.userFileWorkspaceB1UserA1 },
      }),
    expectDenied: expectStatus(404),
    expectPositive: expectStatus(302),
  },
  {
    name: "entity read by id",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readEntityById, workspaceA, {
        params: {
          workspaceId: testIds.wsA1,
          entityId: testIds.entityB1,
        },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readEntityById, workspaceB, {
        params: {
          workspaceId: testIds.wsB1,
          entityId: testIds.entityB1,
        },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expectRecordFieldEquals(result, "entityId", testIds.entityB1),
  },
  {
    name: "entity version list",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readVersions, workspaceA, {
        params: {
          workspaceId: testIds.wsA1,
          entityId: testIds.entityB1,
        },
        query: {},
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readVersions, workspaceB, {
        params: {
          workspaceId: testIds.wsB1,
          entityId: testIds.entityB1,
        },
        query: {},
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) => {
      expectRecordFieldEquals(result, "entityId", testIds.entityB1);
      expectVersionsContainId(result, testIds.entityVersionB1);
    },
  },
  {
    name: "entity version read by id",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readVersionById, workspaceA, {
        params: {
          workspaceId: testIds.wsA1,
          entityId: testIds.entityB1,
          versionId: testIds.entityVersionB1,
        },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readVersionById, workspaceB, {
        params: {
          workspaceId: testIds.wsB1,
          entityId: testIds.entityB1,
          versionId: testIds.entityVersionB1,
        },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expectRecordFieldEquals(result, "id", testIds.entityVersionB1),
  },
  {
    name: "document version comparison",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(compareDocumentVersions, workspaceA, {
        params: {
          workspaceId: testIds.wsA1,
          documentId: testIds.entityB1,
        },
        body: {
          filePropertyId: testIds.filePropertyB1,
          selection: {
            type: "versions",
            baseVersionId: testIds.entityVersionB1,
            targetVersionIds: [compareTargetVersionB],
          },
          baseTrackedChanges: "keep",
          targetTrackedChanges: "keep",
          output: { type: "version" },
        },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(compareDocumentVersions, workspaceB, {
        params: {
          workspaceId: testIds.wsB1,
          documentId: testIds.entityB1,
        },
        body: {
          filePropertyId: testIds.filePropertyB1,
          selection: {
            type: "versions",
            baseVersionId: testIds.entityVersionB1,
            targetVersionIds: [compareTargetVersionB],
          },
          baseTrackedChanges: "keep",
          targetTrackedChanges: "keep",
          output: { type: "version" },
        },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) => {
      expect(result).toMatchObject({
        results: [
          {
            status: "created",
            targetVersionId: compareTargetVersionB,
            redlineVersionId: compareRedlineVersionB,
          },
        ],
      });
    },
  },
  {
    name: "file field download metadata",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readFileHandler, workspaceA, {
        scopedDb: asTestRaw<ScopedDb>(workspaceA.scopedDb),
        fieldId: testIds.fieldB1,
        organizationId: testIds.orgA,
        workspaceId: testIds.wsA1,
        purpose: "download",
        recordAuditEvent: noopAuditRecorder,
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readFileHandler, workspaceB, {
        scopedDb: asTestRaw<ScopedDb>(workspaceB.scopedDb),
        fieldId: testIds.fieldB1,
        organizationId: testIds.orgB,
        workspaceId: testIds.wsB1,
        purpose: "download",
        recordAuditEvent: noopAuditRecorder,
      }),
    expectDenied: expectStatus(404),
    expectPositive: expectStatus(400),
  },
  {
    name: "email preview file lookup",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readEmailHtmlPreviewHandler, workspaceA, {
        scopedDb: asTestRaw<ScopedDb>(workspaceA.scopedDb),
        fieldId: testIds.fieldB1,
        organizationId: testIds.orgA,
        workspaceId: testIds.wsA1,
        recordAuditEvent: noopAuditRecorder,
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readEmailHtmlPreviewHandler, workspaceB, {
        scopedDb: asTestRaw<ScopedDb>(workspaceB.scopedDb),
        fieldId: testIds.fieldB1,
        organizationId: testIds.orgB,
        workspaceId: testIds.wsB1,
        recordAuditEvent: noopAuditRecorder,
      }),
    expectDenied: expectStatus(404),
    // The shared isolation fixture has a text field. A same-workspace lookup
    // reaches the MIME boundary and is rejected before any object read.
    expectPositive: expectStatus(400),
  },
  {
    name: "docx suggestions list",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(listDocxSuggestions, workspaceA, {
        params: { workspaceId: testIds.wsA1, entityId: testIds.entityB1 },
        query: { limit: 100 },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(listDocxSuggestions, workspaceB, {
        params: { workspaceId: testIds.wsB1, entityId: testIds.entityB1 },
        query: { limit: 100 },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expectPageContainsId(result, testIds.docxSuggestionB1),
  },
  {
    name: "document review source list",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listDocumentReviewSources, workspaceA, {
        query: { limit: 50 },
      }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(listDocumentReviewSources, workspaceB, {
        query: { limit: 50 },
      }),
    expectDenied: (result, { ids: testIds }) =>
      expectSourcePageExcludesEntityId(result, testIds.entityB1),
    expectPositive: (result, { ids: testIds }) =>
      expectSourcePageContainsEntityId(result, testIds.entityB1),
  },
  {
    name: "bilingual translation run read by id",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readBilingualRun, workspaceA, {
        params: {
          workspaceId: testIds.wsA1,
          runId: testIds.bilingualRunB1,
        },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readBilingualRun, workspaceB, {
        params: {
          workspaceId: testIds.wsB1,
          runId: testIds.bilingualRunB1,
        },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expectTranslationRunIdEquals(result, testIds.bilingualRunB1),
  },
  {
    name: "document translation run read by id",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readDocumentTranslationRun, workspaceA, {
        params: {
          workspaceId: testIds.wsA1,
          runId: documentTranslationRunB,
        },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readDocumentTranslationRun, workspaceB, {
        params: {
          workspaceId: testIds.wsB1,
          runId: documentTranslationRunB,
        },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) =>
      expectTranslationRunIdEquals(result, documentTranslationRunB),
  },
  {
    name: "credit note create against another tenant original",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(createInvoice, workspaceA, {
        params: { workspaceId: testIds.wsA1 },
        body: {
          documentType: "credit_note",
          originalInvoiceId: creditOriginalB,
          invoiceDate: "2026-09-29",
          currency: "USD",
          timeEntryIds: [],
        },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(createInvoice, workspaceB, {
        params: { workspaceId: testIds.wsB1 },
        body: {
          documentType: "credit_note",
          originalInvoiceId: creditOriginalB,
          invoiceDate: "2026-09-29",
          currency: "USD",
          timeEntryIds: [],
        },
      }),
    expectDenied: expectStatus(422),
    expectPositive: (result) => {
      expect(getStatusCode(result)).toBeNull();
      expect(result).toMatchObject({ id: expect.any(String) });
    },
  },
  {
    name: "invoice read by id",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readInvoiceById, workspaceA, {
        params: {
          workspaceId: testIds.wsA1,
          invoiceId: testIds.invoiceB1,
        },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readInvoiceById, workspaceB, {
        params: {
          workspaceId: testIds.wsB1,
          invoiceId: testIds.invoiceB1,
        },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expectRecordFieldEquals(result, "id", testIds.invoiceB1),
  },
  {
    // Line writes lock the invoice inside the caller's own workspace, so
    // another tenant's invoice id reads as missing rather than editable.
    name: "invoice line create",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(createInvoiceLine, workspaceA, {
        params: { workspaceId: testIds.wsA1, invoiceId: testIds.invoiceB1 },
        body: manualInvoiceLineBody,
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(createInvoiceLine, workspaceB, {
        params: { workspaceId: testIds.wsB1, invoiceId: testIds.invoiceB1 },
        body: manualInvoiceLineBody,
      }),
    expectDenied: expectStatus(409),
    expectPositive: (result) =>
      expect(result).toMatchObject({
        id: expect.any(String),
        totals: { vatAmountMinor: 0 },
      }),
  },
  {
    name: "invoice line update",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(updateInvoiceLine, workspaceA, {
        params: {
          workspaceId: testIds.wsA1,
          invoiceId: testIds.invoiceB1,
          lineId: invoiceLineB,
        },
        body: { description: "Renamed" },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(updateInvoiceLine, workspaceB, {
        params: {
          workspaceId: testIds.wsB1,
          invoiceId: testIds.invoiceB1,
          lineId: invoiceLineB,
        },
        body: { description: "Renamed" },
      }),
    expectDenied: expectStatus(409),
    expectPositive: (result) =>
      expectRecordFieldEquals(result, "id", invoiceLineB),
  },
  {
    name: "seller profile read by id",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(getSellerProfile, workspaceA, {
        params: { sellerProfileId: sellerProfileB },
      }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(getSellerProfile, workspaceB, {
        params: { sellerProfileId: sellerProfileB },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) =>
      expectRecordFieldEquals(result, "id", sellerProfileB),
  },
  {
    name: "seller profile list",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listSellerProfiles, workspaceA, { query: {} }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(listSellerProfiles, workspaceB, { query: {} }),
    expectDenied: (result) => expectPageExcludesId(result, sellerProfileB),
    expectPositive: (result) => expectPageContainsId(result, sellerProfileB),
  },
  {
    name: "number series read by id",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(getNumberSeries, workspaceA, {
        params: { numberSeriesId: numberSeriesB },
      }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(getNumberSeries, workspaceB, {
        params: { numberSeriesId: numberSeriesB },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) =>
      expectRecordFieldEquals(result, "id", numberSeriesB),
  },
  {
    name: "number series list",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listNumberSeries, workspaceA, { query: {} }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(listNumberSeries, workspaceB, { query: {} }),
    expectDenied: (result) => expectPageExcludesId(result, numberSeriesB),
    expectPositive: (result) => expectPageContainsId(result, numberSeriesB),
  },
  {
    name: "VAT rate list",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listVatRates, workspaceA, { query: {} }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(listVatRates, workspaceB, { query: {} }),
    expectDenied: (result) => expectPageExcludesId(result, vatRateB),
    expectPositive: (result) => expectPageContainsId(result, vatRateB),
  },
  {
    name: "VAT rate update",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(updateVatRate, workspaceA, {
        params: { vatRateId: vatRateB },
        body: { name: "Updated VAT rate B" },
      }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(updateVatRate, workspaceB, {
        params: { vatRateId: vatRateB },
        body: { name: "Updated VAT rate B" },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) => expectRecordFieldEquals(result, "id", vatRateB),
  },
  {
    name: "time entry read by id",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readTimeEntryById, workspaceA, {
        params: {
          workspaceId: testIds.wsA1,
          id: testIds.timeEntryB1,
        },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readTimeEntryById, workspaceB, {
        params: {
          workspaceId: testIds.wsB1,
          id: testIds.timeEntryB1,
        },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expectRecordFieldEquals(result, "id", testIds.timeEntryB1),
  },
  {
    name: "time timers across organizations",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listMyTimeTimers, workspaceA, { query: {} }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(listMyTimeTimers, sameUserWorkspaceB, { query: {} }),
    expectDenied: (result) => expectPageExcludesId(result, timeTimerB),
    expectPositive: (result) => expectPageContainsId(result, timeTimerB),
  },
  {
    name: "time timers (same organization, other owner)",
    runAAgainstB: async ({ workspaceB }) =>
      await runHandler(listMyTimeTimers, workspaceB, { query: {} }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(listMyTimeTimers, sameUserWorkspaceB, { query: {} }),
    expectDenied: (result) => expectPageExcludesId(result, timeTimerB),
    expectPositive: (result) => expectPageContainsId(result, timeTimerB),
  },
  {
    name: "admin-role timer listing across organizations",
    runAAgainstB: async ({ ids: testIds }) =>
      await runHandler(
        listAdminTimers,
        createWorkspaceContext({
          activeWorkspaceIds: [testIds.wsA1],
          organizationId: testIds.orgA,
          userId: testIds.userAdmin,
          workspaceId: testIds.wsA1,
        }),
        { query: {}, memberRole: sessionMemberRole("admin") },
      ),
    runBPositive: async ({ ids: testIds }) =>
      await runHandler(
        listAdminTimers,
        createWorkspaceContext({
          activeWorkspaceIds: [testIds.wsB1],
          organizationId: testIds.orgB,
          userId: testIds.userAdmin,
          workspaceId: testIds.wsB1,
        }),
        { query: {}, memberRole: sessionMemberRole("admin") },
      ),
    expectDenied: (result) => expectPageExcludesId(result, adminTimeTimerB),
    expectPositive: (result) => expectPageContainsId(result, adminTimeTimerB),
  },
  {
    name: "admin-role timer stop across organizations",
    runAAgainstB: async ({ ids: testIds }) =>
      await runHandler(
        stopAdminTimer,
        createWorkspaceContext({
          activeWorkspaceIds: [testIds.wsA1],
          organizationId: testIds.orgA,
          userId: testIds.userAdmin,
          workspaceId: testIds.wsA1,
        }),
        {
          params: { id: stopTimeTimerB },
          body: {},
          memberRole: sessionMemberRole("admin"),
        },
      ),
    runBPositive: async ({ ids: testIds }) =>
      await runHandler(
        stopAdminTimer,
        createWorkspaceContext({
          activeWorkspaceIds: [testIds.wsB1],
          organizationId: testIds.orgB,
          userId: testIds.userAdmin,
          workspaceId: testIds.wsB1,
        }),
        {
          params: { id: stopTimeTimerB },
          body: {},
          memberRole: sessionMemberRole("admin"),
        },
      ),
    expectDenied: expectStatus(404),
    expectPositive: (result) => {
      expect(getStatusCode(result)).toBeNull();
      expect(result).toHaveProperty("id");
    },
  },
  {
    name: "matter billing arrangement read",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(getBillingArrangement, workspaceA, {
        workspaceId: testIds.wsB1,
      }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(getBillingArrangement, workspaceB, {}),
    expectDenied: (result) => expect(result).toEqual({ arrangement: null }),
    expectPositive: (result) => {
      expect(getStatusCode(result)).toBeNull();
      expect(result).toMatchObject({
        arrangement: { mode: "hourly", currency: "USD" },
      });
    },
  },
  {
    name: "rate table entries list",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readRateEntries, workspaceA, {
        params: { workspaceId: testIds.wsA1, rateTableId: testIds.rateTableB1 },
        query: { limit: 25 },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readRateEntries, workspaceB, {
        params: { workspaceId: testIds.wsB1, rateTableId: testIds.rateTableB1 },
        query: { limit: 25 },
      }),
    expectDenied: expectEmptyPage,
    expectPositive: (result, { ids: testIds }) =>
      expectPageContainsId(result, testIds.rateEntryB1),
  },
  {
    name: "expenses filtered by matter id",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readExpenses, workspaceA, {
        query: { limit: 25, matterId: testIds.entityB1 },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readExpenses, workspaceB, {
        query: { limit: 25, matterId: testIds.entityB1 },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expectPageContainsId(result, testIds.expenseB1),
  },
  {
    name: "billing code list",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(readBillingCodes, workspaceA, {
        query: { limit: 100 },
      }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(readBillingCodes, workspaceB, {
        query: { limit: 100 },
      }),
    expectDenied: (result, { ids: testIds }) =>
      expectPageExcludesId(result, testIds.billingCodeB1),
    expectPositive: (result, { ids: testIds }) =>
      expectPageContainsId(result, testIds.billingCodeB1),
  },
  {
    name: "legal list list",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listLegalLists, workspaceA, {
        featureAccessSnapshot: legalListAccess(workspaceA),
        query: { limit: 100 },
      }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(listLegalLists, workspaceB, {
        featureAccessSnapshot: legalListAccess(workspaceB),
        query: { limit: 100 },
      }),
    expectDenied: (result) => expectPageExcludesId(result, legalListB),
    expectPositive: (result) => expectPageContainsId(result, legalListB),
  },
  {
    name: "saved search list",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listSavedSearches, workspaceA, {
        query: { limit: 100 },
      }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(listSavedSearches, workspaceB, {
        query: { limit: 100 },
      }),
    expectDenied: (result) => expectPageExcludesId(result, savedSearchB),
    expectPositive: (result) => expectPageContainsId(result, savedSearchB),
  },
  {
    name: "saved time narrative list",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listSavedTimeNarratives, workspaceA, {
        query: { limit: 100 },
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(listSavedTimeNarratives, sameUserWorkspaceB, {
        query: { limit: 100 },
      }),
    expectDenied: (result) => expectPageExcludesId(result, savedTimeNarrativeB),
    expectPositive: (result) =>
      expectPageContainsId(result, savedTimeNarrativeB),
  },
  {
    name: "personal cross-matter view list",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listEntityViews, workspaceA, {}),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(listEntityViews, workspaceB, {}),
    expectDenied: (result) => expectPageExcludesId(result, entityViewB),
    expectPositive: (result) => expectPageContainsId(result, entityViewB),
  },
  {
    // A shared mark belongs to the organization that made it: a reader in
    // another firm opens the same public decision and must see none of it.
    name: "legal reader annotation list",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(listReaderAnnotations, workspaceA, {
        query: {
          limit: 100,
          targetId: testIds.caseLawDecisionB,
          targetType: "decision",
        },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(listReaderAnnotations, workspaceB, {
        query: {
          limit: 100,
          targetId: testIds.caseLawDecisionB,
          targetType: "decision",
        },
      }),
    expectDenied: (result) => expectPageExcludesId(result, readerAnnotationB),
    expectPositive: (result) => expectPageContainsId(result, readerAnnotationB),
  },
  {
    // Answer cells are the organization's. Asking about a decision another
    // organization has answered returns nothing: the cells are keyed by that
    // organization's own question columns.
    name: "case-law research answers lookup",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(lookupResearchAnswers, workspaceA, {
        body: { decisionIds: [testIds.caseLawDecisionB] },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(lookupResearchAnswers, workspaceB, {
        body: { decisionIds: [testIds.caseLawDecisionB] },
      }),
    expectDenied: (result) => {
      expect(result).toMatchObject({ items: [] });
    },
    expectPositive: (result) => {
      expect(result).toMatchObject({
        items: [{ columnId: researchColumnB, state: "answered" }],
      });
    },
  },
  {
    // Firm-scope memory reads org-wide for any chat-capable member, so the
    // organization boundary is the only thing keeping firm B's memory out
    // of firm A's prompt context. Probe it directly.
    name: "memory list",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listMemories, workspaceA, {
        query: { scope: "organization", status: "active", limit: 100 },
      }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(listMemories, workspaceB, {
        query: { scope: "organization", status: "active", limit: 100 },
      }),
    expectDenied: (result, { ids: testIds }) =>
      expectPageExcludesId(result, testIds.aiMemoryFirmB),
    expectPositive: (result, { ids: testIds }) =>
      expectPageContainsId(result, testIds.aiMemoryFirmB),
  },
  {
    name: "organization contact read by id",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readContactById, workspaceA, {
        params: { contactId: testIds.contactB },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readContactById, workspaceB, {
        params: { contactId: testIds.contactB },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expectRecordFieldEquals(result, "id", testIds.contactB),
  },
  {
    name: "organization template read by id",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(getTemplate, workspaceA, {
        params: { templateId: testIds.templateB },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(getTemplate, workspaceB, {
        params: { templateId: testIds.templateB },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expectRecordFieldEquals(result, "id", testIds.templateB),
  },
  {
    name: "inbox signals",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listSignals, workspaceA, { query: { limit: 100 } }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(listSignals, workspaceB, { query: { limit: 100 } }),
    expectDenied: (result) => {
      expectPageExcludesField(result, "id", visibleSignalB);
      // The unscoped (triage) row is the riskiest path: it carries no
      // workspace to filter on, so only the org boundary keeps it out.
      expectPageExcludesField(result, "id", foreignSignalB);
    },
    expectPositive: (result) => {
      expectPageContainsField(result, "id", visibleSignalB);
      expectPageContainsField(result, "id", foreignSignalB);
    },
  },
  {
    name: "task read by id",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readTaskById, workspaceA, {
        params: { workspaceId: testIds.wsA1, taskId: workObligationEntityB },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readTaskById, workspaceB, {
        params: { workspaceId: testIds.wsB1, taskId: workObligationEntityB },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) =>
      expectRecordFieldEquals(result, "id", workObligationEntityB),
  },
  {
    name: "governed work queue",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(listMyWork, workspaceA, {
        user: { id: testIds.userB1, email: "user-b@example.test" },
        query: { queue: "to_acknowledge", limit: 100, asOf: "2026-08-24" },
      }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(listMyWork, workspaceB, {
        query: { queue: "to_acknowledge", limit: 100, asOf: "2026-08-24" },
      }),
    expectDenied: (result) =>
      expectPageExcludesField(result, "entityId", workObligationEntityB),
    expectPositive: (result) =>
      expectPageContainsField(result, "entityId", workObligationEntityB),
  },
  {
    // A notification is addressed to one person in one organization. Reading
    // it as workspace A (user A1, org A) must return nothing, even though the
    // row belongs to a real account this fixture also knows.
    name: "notifications",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listNotifications, workspaceA, { query: {} }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(listNotifications, workspaceB, { query: {} }),
    expectDenied: (result) =>
      expectPageExcludesField(result, "id", notificationB),
    expectPositive: (result) =>
      expectPageContainsField(result, "id", notificationB),
  },
  {
    // The case above changes the person AND the firm at once, so a handler
    // that filtered on organization alone would still pass it. This one holds
    // the firm fixed: user A1 working in organization B must not see a row
    // addressed to user B1, which isolates the recipient predicate.
    name: "notifications (same organization, other recipient)",
    runAAgainstB: async ({ sameUserWorkspaceB }) =>
      await runHandler(listNotifications, sameUserWorkspaceB, { query: {} }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(listNotifications, workspaceB, { query: {} }),
    expectDenied: (result) =>
      expectPageExcludesField(result, "id", notificationB),
    expectPositive: (result) =>
      expectPageContainsField(result, "id", notificationB),
  },
  {
    name: "chat thread list",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listChatThreads, workspaceA, { query: {} }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(listChatThreads, sameUserWorkspaceB, { query: {} }),
    expectDenied: (result) =>
      expect(globalChatThreadIds(result)).not.toContain(chatThreadB),
    expectPositive: (result) =>
      expect(globalChatThreadIds(result)).toContain(chatThreadB),
  },
  {
    name: "chat messages list",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listChatMessages, workspaceA, {
        params: { threadId: chatThreadB },
        query: {},
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(listChatMessages, sameUserWorkspaceB, {
        params: { threadId: chatThreadB },
        query: {},
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) =>
      expect(chatMessageIds(result)).toEqual([
        chatUserMessageB,
        chatAssistantMessageB,
      ]),
  },
  {
    // A missing thread may be served as an empty draft; another firm's
    // thread must come back as exactly that, never as its contents.
    name: "chat messages list (draft fallback)",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listChatMessages, workspaceA, {
        params: { threadId: chatThreadB },
        query: { allowMissingThread: true },
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(listChatMessages, sameUserWorkspaceB, {
        params: { threadId: chatThreadB },
        query: { allowMissingThread: true },
      }),
    expectDenied: (result) =>
      expect(result).toMatchObject({ messages: [], threadExists: false }),
    expectPositive: (result) =>
      expect(result).toMatchObject({ threadExists: true }),
  },
  {
    // The caller owns this thread, but it sits in a matter their session no
    // longer reaches: the matter boundary alone keeps it closed.
    name: "chat messages list (matter without access)",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(listChatMessages, workspaceA, {
        params: { threadId: testIds.chatThreadWorkspaceA2 },
        query: {},
      }),
    runBPositive: async ({ ids: testIds }) =>
      await runHandler(
        listChatMessages,
        createWorkspaceContext({
          activeWorkspaceIds: [testIds.wsA1, testIds.wsA2],
          organizationId: testIds.orgA,
          userId: testIds.userA1,
          workspaceId: testIds.wsA2,
        }),
        {
          params: { threadId: testIds.chatThreadWorkspaceA2 },
          query: { workspaceId: testIds.wsA2 },
        },
      ),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expect(chatMessageIds(result)).toEqual([testIds.chatMessageWorkspaceA2]),
  },
  {
    name: "older chat messages list",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listOlderChatMessages, workspaceA, {
        params: { threadId: chatThreadB },
        query: { before: encodeMessagePageCursor(chatAssistantMessageB) },
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(listOlderChatMessages, sameUserWorkspaceB, {
        params: { threadId: chatThreadB },
        query: { before: encodeMessagePageCursor(chatAssistantMessageB) },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) =>
      expect(chatMessageIds(result)).toEqual([chatUserMessageB]),
  },
  {
    name: "chat thread title read",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(readChatThreadTitle, workspaceA, {
        params: { threadId: chatThreadB },
        query: {},
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(readChatThreadTitle, sameUserWorkspaceB, {
        params: { threadId: chatThreadB },
        query: {},
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) =>
      expect(result).toEqual({ title: expect.any(String) }),
  },
  {
    name: "chat thread rename",
    runAAgainstB: async ({ workspaceA }) => ({
      response: await runHandler(renameChatThread, workspaceA, {
        body: { title: chatRenameFromA },
        params: { threadId: chatThreadB },
        query: {},
      }),
      thread: await readChatThreadRow(chatThreadB),
    }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(renameChatThread, sameUserWorkspaceB, {
        body: { title: chatThreadTitleB },
        params: { threadId: chatThreadB },
        query: {},
      }),
    expectDenied: (result) => {
      expect(getStatusCode(recordField(result, "response"))).toBe(404);
      expect(recordField(result, "thread")).toMatchObject({
        title: chatThreadTitleB,
      });
    },
    expectPositive: (result) =>
      expect(result).toEqual({ title: chatThreadTitleB }),
  },
  {
    // An upsert: a thread id the caller cannot see must neither be updated
    // nor answered by a fresh placeholder row under the caller's firm.
    name: "chat thread web search toggle",
    runAAgainstB: async ({ workspaceA }) => ({
      response: await runHandler(updateChatThread, workspaceA, {
        body: { webSearchEnabled: true },
        params: { threadId: chatThreadB },
        query: {},
      }),
      thread: await readChatThreadRow(chatThreadB),
    }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(updateChatThread, sameUserWorkspaceB, {
        body: { webSearchEnabled: false },
        params: { threadId: chatThreadB },
        query: {},
      }),
    expectDenied: (result) => {
      expect(getStatusCode(recordField(result, "response"))).toBe(404);
      expect(recordField(result, "thread")).toMatchObject({
        webSearchEnabled: false,
      });
    },
    expectPositive: (result) =>
      expect(result).toEqual({ webSearchEnabled: false }),
  },
  {
    name: "chat thread model selection",
    runAAgainstB: async ({ workspaceA }) => ({
      response: await runHandler(updateChatThreadModel, workspaceA, {
        body: { model: null },
        params: { threadId: chatThreadB },
        query: {},
      }),
      thread: await readChatThreadRow(chatThreadB),
    }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(updateChatThreadModel, sameUserWorkspaceB, {
        body: { model: null },
        params: { threadId: chatThreadB },
        query: {},
      }),
    expectDenied: (result) => {
      expect(getStatusCode(recordField(result, "response"))).toBe(404);
      expect(recordField(result, "thread")).toMatchObject({
        chatModel: chatModelB,
      });
    },
    expectPositive: (result) =>
      expect(result).toEqual({ model: null, reasoningEffort: null }),
  },
  {
    name: "chat thread fork",
    runAAgainstB: async ({ workspaceA }) => ({
      response: await runHandler(forkChatThread, workspaceA, {
        body: {
          newThreadId: chatForkFromA,
          upToMessageId: chatAssistantMessageB,
        },
        params: { threadId: chatThreadB },
        query: {},
      }),
      fork: await readChatThreadRow(chatForkFromA),
    }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(forkChatThread, sameUserWorkspaceB, {
        body: {
          newThreadId: chatForkFromB,
          upToMessageId: chatAssistantMessageB,
        },
        params: { threadId: chatThreadB },
        query: {},
      }),
    expectDenied: (result) => {
      expect(getStatusCode(recordField(result, "response"))).toBe(404);
      expect(recordField(result, "fork")).toBeNull();
    },
    expectPositive: (result) =>
      expectRecordFieldEquals(result, "threadId", chatForkFromB),
  },
  {
    // Deleting another firm's thread answers like a missing one; what matters
    // is that the row outlives the request.
    name: "chat thread delete",
    runAAgainstB: async ({ workspaceA }) => ({
      response: await runHandler(deleteChatThread, workspaceA, {
        params: { threadId: chatDeleteThreadB },
        query: {},
      }),
      thread: await readChatThreadRow(chatDeleteThreadB),
    }),
    runBPositive: async ({ sameUserWorkspaceB }) => ({
      response: await runHandler(deleteChatThread, sameUserWorkspaceB, {
        params: { threadId: chatDeleteThreadB },
        query: {},
      }),
      thread: await readChatThreadRow(chatDeleteThreadB),
    }),
    expectDenied: (result) => {
      expect(recordField(result, "response")).toStrictEqual({});
      expect(recordField(result, "thread")).not.toBeNull();
    },
    expectPositive: (result) => {
      expect(recordField(result, "response")).toStrictEqual({});
      expect(recordField(result, "thread")).toBeNull();
    },
  },
  {
    // Runs before the cancel case, which settles the shared accepted turn.
    name: "chat turn resume probe",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(probeChatTurn, workspaceA, {
        params: { threadId: chatTurnThreadB, turnId: chatTurnB },
        query: {},
        request: new Request("http://localhost/"),
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(probeChatTurn, sameUserWorkspaceB, {
        params: { threadId: chatTurnThreadB, turnId: chatTurnB },
        query: {},
        request: new Request("http://localhost/"),
      }),
    expectDenied: (result) => {
      expect(getStatusCode(result)).toBe(404);
    },
    expectPositive: (result) =>
      expect(result).toEqual({ type: "preparing", turnId: chatTurnB }),
  },
  {
    // Runs before the cancel case, which settles the shared accepted turn.
    name: "chat turn resume join",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(joinChatTurn, workspaceA, {
        params: { threadId: chatTurnThreadB, turnId: chatTurnB },
        query: {},
        request: new Request("http://localhost/"),
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(joinChatTurn, sameUserWorkspaceB, {
        params: { threadId: chatTurnThreadB, turnId: chatTurnB },
        query: {},
        request: new Request("http://localhost/"),
      }),
    expectDenied: (result) => {
      expect(getStatusCode(result)).toBe(404);
    },
    expectPositive: (result) =>
      expect(result).toEqual({ type: "preparing", turnId: chatTurnB }),
  },
  {
    name: "chat turn cancel",
    runAAgainstB: async ({ workspaceA }) => ({
      response: await runHandler(cancelChatTurn, workspaceA, {
        params: { threadId: chatTurnThreadB, turnId: chatTurnB },
      }),
      turn: await readChatTurnRow(chatTurnB),
    }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(cancelChatTurn, sameUserWorkspaceB, {
        params: { threadId: chatTurnThreadB, turnId: chatTurnB },
      }),
    expectDenied: (result) => {
      expect(getStatusCode(recordField(result, "response"))).toBe(404);
      expect(recordField(result, "turn")).toEqual({
        cancelRequestedAt: null,
        status: "accepted",
      });
    },
    expectPositive: (result) =>
      expect(result).toMatchObject({
        turn: { id: chatTurnB, status: "cancelled" },
      }),
  },
  {
    name: "chat message send",
    runAAgainstB: async ({ workspaceA }) => {
      streamChatStub.mockClear();
      return {
        response: await runHandler(
          sendChatMessage,
          workspaceA,
          chatSendRequest(chatSendThreadB, Bun.randomUUIDv7()),
        ),
        streamed: streamChatStub.mock.calls.length,
        messages: await countChatMessages(chatSendThreadB),
      };
    },
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(
        sendChatMessage,
        sameUserWorkspaceB,
        chatSendRequest(chatSendThreadB, Bun.randomUUIDv7()),
      ),
    expectDenied: (result) => {
      expect(getStatusCode(recordField(result, "response"))).toBe(404);
      expect(recordField(result, "streamed")).toBe(0);
      expect(recordField(result, "messages")).toBe(0);
    },
    expectPositive: (result) => expect(result).toBeInstanceOf(Response),
  },
  {
    // Thread B carries a cached recap for its latest answer, so the owner's
    // read returns it without a model call.
    name: "chat thread recap",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(readChatThreadRecap, workspaceA, {
        orgAIConfig: chatOrgAIConfig,
        params: { threadId: chatThreadB },
        query: {},
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(readChatThreadRecap, sameUserWorkspaceB, {
        orgAIConfig: chatOrgAIConfig,
        params: { threadId: chatThreadB },
        query: {},
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) => expect(result).toEqual({ recap: chatRecapB }),
  },
  {
    // The turn thread's latest turn has not completed, so the owner is
    // offered no follow-ups; the foreign caller does not reach that far.
    name: "chat suggested prompts",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(readSuggestedChatPrompts, workspaceA, {
        orgAIConfig: chatOrgAIConfig,
        params: { threadId: chatTurnThreadB },
        query: {},
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(readSuggestedChatPrompts, sameUserWorkspaceB, {
        orgAIConfig: chatOrgAIConfig,
        params: { threadId: chatTurnThreadB },
        query: {},
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) => expect(result).toEqual({ prompts: [] }),
  },
  {
    name: "chat thread title suggestion",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(suggestChatThreadTitle, workspaceA, {
        orgAIConfig: chatOrgAIConfig,
        params: { threadId: chatThreadB },
        query: {},
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(suggestChatThreadTitle, sameUserWorkspaceB, {
        orgAIConfig: chatOrgAIConfig,
        params: { threadId: chatThreadB },
        query: {},
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) =>
      expect(result).toEqual({ title: "Matter summary" }),
  },
  {
    name: "chat message export",
    runAAgainstB: async ({ workspaceA }) =>
      await withFakeObjectStore(
        async () =>
          await runHandler(exportChatMessage, workspaceA, {
            body: chatExportBody,
            params: { threadId: chatThreadB },
            query: {},
          }),
      ),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await withFakeObjectStore(
        async () =>
          await runHandler(exportChatMessage, sameUserWorkspaceB, {
            body: chatExportBody,
            params: { threadId: chatThreadB },
            query: {},
          }),
      ),
    expectDenied: (result) => {
      expect(getStatusCode(recordField(result, "response"))).toBe(404);
      expect(recordField(result, "writes")).toEqual([]);
    },
    expectPositive: (result) => {
      expect(recordField(result, "response")).toMatchObject({
        downloadUrl: expect.any(String),
      });
      expect(recordField(result, "writes")).toHaveLength(1);
    },
  },
  {
    // Template chats are keyed by a template id from the request body: one
    // naming another firm's template creates nothing.
    name: "template chat thread resolve",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(resolveTemplateChatThread, workspaceA, {
        body: { templateId: testIds.templateB },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(resolveTemplateChatThread, workspaceB, {
        body: { templateId: testIds.templateB },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) =>
      expect(result).toEqual({ threadId: expect.any(String) }),
  },
  {
    name: "template chat thread rotate",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(rotateTemplateChatThread, workspaceA, {
        body: { templateId: testIds.templateB },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(rotateTemplateChatThread, workspaceB, {
        body: { templateId: testIds.templateB },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) =>
      expect(result).toEqual({ threadId: expect.any(String) }),
  },
  {
    name: "file chat thread resolve",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(resolveFileChatThread, workspaceA, {
        body: { entityId: testIds.entityB1, fieldId: testIds.fileFieldB1 },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(resolveFileChatThread, workspaceB, {
        body: { entityId: testIds.entityB1, fieldId: testIds.fileFieldB1 },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) =>
      expect(result).toMatchObject({ threadId: expect.any(String) }),
  },
  {
    // The composer names the open file by id; another firm's document is
    // not found rather than evaluated.
    name: "chat skill availability for an open file",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(listUnavailableChatSkills, workspaceA, {
        query: chatSkillFileQuery(testIds),
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(listUnavailableChatSkills, workspaceB, {
        query: chatSkillFileQuery(testIds),
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) =>
      expect(result).toMatchObject({
        unavailable: expect.any(Array),
        unavailableHere: expect.any(Array),
      }),
  },
  {
    // File chats are keyed by the file the user opened. Organization B,
    // holding organization A's entity and field ids, finds no thread.
    name: "file chat thread read",
    runAAgainstB: async ({ ids: testIds, sameUserWorkspaceB }) =>
      await runHandler(readFileChatThread, sameUserWorkspaceB, {
        query: { entityId: testIds.entityA1, fieldId: testIds.fieldA1 },
      }),
    runBPositive: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readFileChatThread, workspaceA, {
        query: { entityId: testIds.entityA1, fieldId: testIds.fieldA1 },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expectRecordFieldEquals(
        result,
        "threadId",
        testIds.chatThreadWorkspaceA1,
      ),
  },
];

const chatExportBody = {
  citationStyle: "none",
  format: "docx",
  messageId: chatAssistantMessageB,
} as const;

/** Runs `run` against an in-process object store and reports its writes. */
const withFakeObjectStore = async (
  run: () => Promise<unknown>,
): Promise<{ response: unknown; writes: string[] }> => {
  const store = startFakeS3();
  try {
    const response = await run();
    return {
      response,
      writes: store.requests.flatMap((request) =>
        request.method === "PUT" ? [request.key] : [],
      ),
    };
  } finally {
    store.stop();
  }
};

const chatSkillFileQuery = (testIds: TestIds) => ({
  anonymized: false,
  browserExtension: false,
  document: CHAT_SKILL_DOCUMENT.file,
  documentId: testIds.entityB1,
  fileFieldId: testIds.fileFieldB1,
  webSearch: false,
});

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  await testDb
    .update(authUser)
    .set({ emailVerified: true })
    .where(
      inArray(authUser.id, [ids.userA1, ids.userA2, ids.userB1, ids.userAdmin]),
    );
  await testDb
    .insert(featureEnrolments)
    .values([
      {
        organizationId: ids.orgA,
        userId: ids.userA1,
        featureId: "time-billing",
      },
      {
        organizationId: ids.orgA,
        userId: ids.userA2,
        featureId: "time-billing",
      },
      {
        organizationId: ids.orgA,
        userId: ids.userAdmin,
        featureId: "time-billing",
      },
      {
        organizationId: ids.orgB,
        userId: ids.userA1,
        featureId: "time-billing",
      },
      {
        organizationId: ids.orgB,
        userId: ids.userB1,
        featureId: "time-billing",
      },
      {
        organizationId: ids.orgB,
        userId: ids.userAdmin,
        featureId: "time-billing",
      },
    ])
    .onConflictDoNothing();
  await testDb.insert(desktopPresence).values({
    userId: ids.userA1,
    organizationId: ids.orgB,
    desktopId: "22222222-2222-4222-8222-222222222270",
    version: "0.9.48",
    protocol: 1,
  });
  await testDb.insert(billingArrangements).values({
    workspaceId: ids.wsB1,
    organizationId: ids.orgB,
    mode: "hourly",
    currency: "USD",
  });
  await testDb.insert(invoices).values({
    id: creditOriginalB,
    organizationId: ids.orgB,
    workspaceId: ids.wsB1,
    invoiceNumber: "CREDIT-ORIGINAL-B",
    invoiceDate: "2026-09-29",
    currency: "USD",
    status: "finalized",
  });

  await testDb.insert(sellerProfiles).values({
    id: sellerProfileB,
    organizationId: ids.orgB,
    legalName: "Seller profile B",
    defaultCurrency: "CZK",
  });
  await testDb.insert(invoiceLines).values({
    id: invoiceLineB,
    organizationId: ids.orgB,
    workspaceId: ids.wsB1,
    invoiceId: ids.invoiceB1,
    position: 0,
    description: "Line B",
    quantity: "1",
    unitPrice: cents(100),
    vatRateBps: 0,
    vatTreatment: "domestic_vat",
    netAmount: cents(100),
    vatAmount: cents(0),
    grossAmount: cents(100),
    source: "manual",
  });
  await testDb.insert(numberSeries).values({
    id: numberSeriesB,
    organizationId: ids.orgB,
    documentType: "invoice",
    name: "Invoice series B",
    pattern: "INV-{YYYY}-{SEQ}",
    padding: 5,
    isDefault: true,
  });
  await testDb.insert(vatRates).values({
    id: vatRateB,
    organizationId: ids.orgB,
    code: "standard",
    name: "VAT rate B",
    rateBps: 2100,
    validFrom: "2026-01-01",
  });
  await testDb.insert(entityVersions).values({
    id: compareTargetVersionB,
    workspaceId: ids.wsB1,
    entityId: ids.entityB1,
    versionNumber: 2,
  });
  await testDb.insert(fields).values({
    id: compareTargetFieldB,
    workspaceId: ids.wsB1,
    propertyId: ids.filePropertyB1,
    entityVersionId: compareTargetVersionB,
    content: {
      version: 1,
      type: "file",
      id: compareTargetFileB,
      fileName: "agreement-v2.docx",
      mimeType: DOCX_MIME_TYPE,
      sizeBytes: 1,
      encrypted: false,
      sha256Hex: "a".repeat(64),
      pdfFileId: null,
    },
  });
  await testDb.insert(legalLists).values([
    {
      id: legalListA,
      workspaceId: ids.wsA1,
      name: "Workspace A list",
      createdBy: ids.userA1,
    },
    {
      id: legalListB,
      workspaceId: ids.wsB1,
      name: "Workspace B list",
      createdBy: ids.userB1,
    },
  ]);
  await testDb.insert(savedSearches).values([
    {
      id: savedSearchA,
      organizationId: ids.orgA,
      userId: ids.userA1,
      name: "Workspace A agreements",
      criteria: savedSearchCriteria(ids.wsA1),
    },
    {
      id: savedSearchB,
      organizationId: ids.orgB,
      userId: ids.userB1,
      name: "Workspace B agreements",
      criteria: savedSearchCriteria(ids.wsB1),
    },
  ]);
  await testDb.insert(savedTimeNarratives).values({
    id: savedTimeNarrativeB,
    organizationId: ids.orgB,
    userId: ids.userA1,
    name: "Workspace B narrative",
    narrative: "Research and drafting",
    narrativeLanguage: "en",
  });
  await testDb.insert(entityViews).values({
    id: entityViewB,
    organizationId: ids.orgB,
    userId: ids.userB1,
    name: "Firm B tasks",
    layout: {
      version: 1,
      type: "table",
      filters: [],
      sorts: [],
      hiddenProperties: [],
      calculations: [],
      columnOrder: [],
      columnPinning: [],
    },
    position: 0,
  });
  await testDb.insert(caseLawResearchColumns).values({
    id: researchColumnB,
    organizationId: ids.orgB,
    createdBy: ids.userB1,
    position: 1,
    question: "Does the decision allow termination?",
    content: {
      version: 1,
      type: "single-select",
      options: [
        { color: "green", value: "yes" },
        { color: "red", value: "no" },
      ],
      fallback: null,
    },
    tool: { version: 1, role: "fast" },
  });
  await testDb.insert(caseLawResearchAnswers).values({
    columnId: researchColumnB,
    organizationId: ids.orgB,
    decisionId: ids.caseLawDecisionB,
    state: "answered",
    answer: { version: 1, type: "single-select", value: "yes" },
  });
  await testDb.insert(legalReaderAnnotations).values({
    id: readerAnnotationB,
    organizationId: ids.orgB,
    userId: ids.userB1,
    targetType: "decision",
    targetId: ids.caseLawDecisionB,
    kind: "highlight",
    visibility: "shared",
    color: "yellow",
    style: "highlight",
    blockAnchorId: "p-1",
    startOffset: 0,
    endOffset: 9,
    quote: "important",
  });
  await testDb.insert(signals).values([
    {
      id: visibleSignalB,
      organizationId: ids.orgB,
      workspaceId: ids.wsB1,
      kind: SIGNAL_KIND.REQUEST_SUBMITTED,
      origin: SIGNAL_KIND_ORIGIN[SIGNAL_KIND.REQUEST_SUBMITTED],
      scoutKey: "manual.request",
      severity: SIGNAL_SEVERITY.NOTICE,
      title: "matter-scoped request B",
      summary: "matter-scoped request B",
      subject: { type: "workspace", workspaceId: ids.wsB1 },
      evidence: {
        kind: SIGNAL_KIND.REQUEST_SUBMITTED,
        description: "matter-scoped request B",
        attachments: [],
      },
      suggestions: [],
      dedupeKey: `cross-tenant:${visibleSignalB}`,
    },
    {
      id: foreignSignalB,
      organizationId: ids.orgB,
      workspaceId: null,
      kind: SIGNAL_KIND.REQUEST_SUBMITTED,
      origin: SIGNAL_KIND_ORIGIN[SIGNAL_KIND.REQUEST_SUBMITTED],
      scoutKey: "manual.request",
      severity: SIGNAL_SEVERITY.NOTICE,
      title: "unscoped triage request B",
      summary: "unscoped triage request B",
      subject: { type: "none" },
      evidence: {
        kind: SIGNAL_KIND.REQUEST_SUBMITTED,
        description: "unscoped triage request B",
        attachments: [],
      },
      suggestions: [],
      dedupeKey: `cross-tenant:${foreignSignalB}`,
    },
  ]);
  await testDb.insert(documentTranslationRuns).values({
    id: documentTranslationRunB,
    organizationId: ids.orgB,
    workspaceId: ids.wsB1,
    entityId: ids.entityB1,
    fileFieldId: ids.fieldB1,
    entityVersionId: ids.entityVersionB1,
    sourceFileId: documentTranslationSourceFileB,
    sourceFileName: "agreement.docx",
    sourceMimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    output: "translated",
    engine: "deepl",
    sourceLang: "auto",
    targetLang: "en",
    status: "completed",
  });
  await testDb.insert(entities).values({
    id: workObligationEntityB,
    workspaceId: ids.wsB1,
    kind: "task",
    name: "governed work B",
  });
  await testDb.insert(workObligations).values({
    entityId: workObligationEntityB,
    workspaceId: ids.wsB1,
    status: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
    ownerUserId: ids.userB1,
  });
  await testDb.insert(member).values({
    id: Bun.randomUUIDv7(),
    organizationId: ids.orgB,
    userId: ids.userAdmin,
    role: "admin",
    createdAt: new Date(),
  });
  await testDb.insert(timeTimers).values([
    {
      id: adminTimeTimerB,
      organizationId: ids.orgB,
      userId: ids.userA1,
      workspaceId: ids.wsB1,
      description: "Research",
      state: "running",
      startedAt: new Date(),
      lastResumedAt: new Date(),
      accumulatedSeconds: 300,
    },
    {
      id: stopTimeTimerB,
      organizationId: ids.orgB,
      userId: ids.userB1,
      workspaceId: ids.wsB1,
      description: "Research",
      state: "running",
      startedAt: new Date(),
      lastResumedAt: new Date(),
      accumulatedSeconds: 300,
    },
  ]);
  await testDb.insert(timeTimers).values({
    id: timeTimerB,
    organizationId: ids.orgB,
    userId: ids.userA1,
    workspaceId: null,
    description: "timer B",
    state: "paused",
    startedAt: new Date("2026-09-01T10:00:00Z"),
    lastResumedAt: null,
    accumulatedSeconds: 300,
  });
  await testDb.insert(notifications).values({
    id: notificationB,
    userId: ids.userB1,
    organizationId: ids.orgB,
    kind: NOTIFICATION_KIND.MENTION,
    metadata: { actorName: "User B1" },
    entityType: "entity",
    entityId: ids.entityB1,
    idempotencyKey: "cross-tenant:notification-b",
  });
  const chatThreadOfB = (id: SafeId<"chatThread">) => ({
    id,
    organizationId: ids.orgB,
    title: chatThreadTitleB,
    userId: ids.userA1,
    workspaceId: null,
  });
  await testDb.insert(chatThreads).values([
    {
      ...chatThreadOfB(chatThreadB),
      chatModel: chatModelB,
      recapMessageId: chatAssistantMessageB,
      recapPromptVersion: RECAP_PROMPT_VERSION,
      recapText: chatRecapB,
    },
    chatThreadOfB(chatTurnThreadB),
    chatThreadOfB(chatDeleteThreadB),
    chatThreadOfB(chatSendThreadB),
  ]);
  const chatText = (text: string) => ({
    version: 1 as const,
    data: [{ type: "text" as const, text }],
  });
  const chatAskedAt = new Date("2026-09-01T09:00:00.000Z");
  await testDb.insert(chatMessages).values([
    {
      id: chatUserMessageB,
      threadId: chatThreadB,
      userId: ids.userA1,
      workspaceId: null,
      role: "user",
      content: chatText("Summarise the matter."),
      createdAt: chatAskedAt,
    },
    {
      id: chatAssistantMessageB,
      threadId: chatThreadB,
      userId: ids.userA1,
      workspaceId: null,
      role: "assistant",
      content: chatText("Here is the summary."),
      createdAt: new Date(chatAskedAt.getTime() + 1000),
    },
    {
      id: chatTurnUserMessageB,
      threadId: chatTurnThreadB,
      userId: ids.userA1,
      workspaceId: null,
      role: "user",
      content: chatText("Draft the reply."),
      createdAt: chatAskedAt,
    },
  ]);
  await testDb.insert(chatTurns).values({
    id: chatTurnB,
    // An accepted turn holds a lease until an owner claims it.
    leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    organizationId: ids.orgB,
    threadId: chatTurnThreadB,
    userId: ids.userA1,
    userMessageId: chatTurnUserMessageB,
    workspaceId: null,
  });
});

afterAll(async () => {
  await releaseTestDb();
});

describe("cross-tenant handler isolation", () => {
  for (const testCase of isolationCases) {
    test(`${testCase.name}: workspace A cannot read workspace/org B resource IDs`, async () => {
      const context = createIsolationContext();

      const result = await testCase.runAAgainstB(context);

      testCase.expectDenied(result, context);
    });

    test(`${testCase.name}: fixture exposes the target inside its own tenant`, async () => {
      const context = createIsolationContext();

      const result = await testCase.runBPositive(context);

      testCase.expectPositive(result, context);
    });
  }
});

const createIsolationContext = (): IsolationContext => ({
  ids,
  sameUserWorkspaceB: createWorkspaceContext({
    activeWorkspaceIds: [ids.wsB1],
    organizationId: ids.orgB,
    userId: ids.userA1,
    workspaceId: ids.wsB1,
  }),
  workspaceA: createWorkspaceContext({
    activeWorkspaceIds: [ids.wsA1],
    organizationId: ids.orgA,
    userId: ids.userA1,
    workspaceId: ids.wsA1,
  }),
  workspaceB: createWorkspaceContext({
    activeWorkspaceIds: [ids.wsB1],
    organizationId: ids.orgB,
    userId: ids.userB1,
    workspaceId: ids.wsB1,
  }),
});

const createWorkspaceContext = ({
  activeWorkspaceIds,
  organizationId,
  userId,
  workspaceId,
}: {
  activeWorkspaceIds: SafeId<"workspace">[];
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
}): TestHandlerContext => {
  const scopedDb = createScopedDb(
    testDb,
    activeWorkspaceIds,
    organizationId,
    userId,
  );
  const safeDb = createSafeDb(
    testDb,
    activeWorkspaceIds,
    organizationId,
    userId,
  );

  return {
    createAuditRecorder: () => noopAuditRecorder,
    getActiveWorkspaceIds: async () => activeWorkspaceIds,
    getAccessibleWorkspaces: async () =>
      activeWorkspaceIds.map((id) => ({ id, status: "active" as const })),
    getWorkspaceAccess: async (targetWorkspaceId) =>
      activeWorkspaceIds.includes(targetWorkspaceId)
        ? { id: targetWorkspaceId, status: "active" }
        : null,
    memberRole: sessionMemberRole("owner"),
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    managedAIResidency: "eu" as const,
    promptCachingEnabled: false,
    recordAuditEvent: noopAuditRecorder,
    request: new Request(`https://example.test/workspaces/${workspaceId}`),
    route: "/security/cross-tenant-handler",
    safeDb,
    scopedDb,
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
    workspaceId,
  };
};

type TestEndpoint<TContext> =
  | { handler: (context: TContext) => Promise<unknown> }
  | ((context: TContext) => Promise<unknown>);

const runHandler = async <TContext>(
  endpoint: TestEndpoint<TContext>,
  context: TestHandlerContext,
  requestShape: Partial<TContext> & Record<string, unknown>,
): Promise<unknown> => {
  const handler = typeof endpoint === "function" ? endpoint : endpoint.handler;

  try {
    return await handler(
      asTestRaw<TContext>({
        ...context,
        ...requestShape,
      }),
    );
  } catch (error) {
    return error;
  }
};

function desktopPresenceIsolationCases(): IsolationCase[] {
  return [
    {
      name: "desktop presence across organizations",
      runAAgainstB: async ({ workspaceA }) =>
        await runHandler(readDesktopPresence, workspaceA, {}),
      runBPositive: async ({ sameUserWorkspaceB }) =>
        await runHandler(readDesktopPresence, sameUserWorkspaceB, {}),
      expectDenied: (result) => expect(result).toEqual({ type: "none" }),
      expectPositive: (result) =>
        expect(result).toMatchObject({
          desktop: { version: "0.9.48", protocol: 1 },
        }),
    },
    {
      name: "desktop presence in the same organization with another owner",
      runAAgainstB: async ({ workspaceB }) =>
        await runHandler(readDesktopPresence, workspaceB, {}),
      runBPositive: async ({ sameUserWorkspaceB }) =>
        await runHandler(readDesktopPresence, sameUserWorkspaceB, {}),
      expectDenied: (result) => expect(result).toEqual({ type: "none" }),
      expectPositive: (result) =>
        expect(result).toMatchObject({
          desktop: { version: "0.9.48", protocol: 1 },
        }),
    },
  ];
}

function expectStatus(expectedStatus: number): (result: unknown) => void {
  return (result: unknown): void => {
    expect(getStatusCode(result)).toBe(expectedStatus);
  };
}

function expectEmptyPage(result: unknown): void {
  expect(getStatusCode(result)).toBeNull();
  expect(getPageItems(result)).toEqual([]);
}

function expectPageContainsId(result: unknown, expectedId: string): void {
  expect(getStatusCode(result)).toBeNull();
  expect(getPageItems(result).some((item) => item["id"] === expectedId)).toBe(
    true,
  );
}

function expectPageExcludesId(result: unknown, excludedId: string): void {
  expect(getStatusCode(result)).toBeNull();
  expect(getPageItems(result).some((item) => item["id"] === excludedId)).toBe(
    false,
  );
}

function expectPageContainsField(
  result: unknown,
  field: string,
  expectedValue: string,
): void {
  expect(getStatusCode(result)).toBeNull();
  expect(
    getPageItems(result).some((item) => item[field] === expectedValue),
  ).toBe(true);
}

function expectPageExcludesField(
  result: unknown,
  field: string,
  excludedValue: string,
): void {
  expect(getStatusCode(result)).toBeNull();
  expect(
    getPageItems(result).some((item) => item[field] === excludedValue),
  ).toBe(false);
}

function expectSourcePageContainsEntityId(
  result: unknown,
  expectedId: string,
): void {
  expect(getStatusCode(result)).toBeNull();
  expect(
    getPageItems(result).some((item) => item["entityId"] === expectedId),
  ).toBe(true);
}

function expectSourcePageExcludesEntityId(
  result: unknown,
  excludedId: string,
): void {
  expect(getStatusCode(result)).toBeNull();
  expect(
    getPageItems(result).some((item) => item["entityId"] === excludedId),
  ).toBe(false);
}

function expectRecordFieldEquals(
  result: unknown,
  field: string,
  expectedValue: string,
): void {
  expect(getStatusCode(result)).toBeNull();
  if (!isRecord(result)) {
    throw new Error("Expected an object response");
  }
  expect(result[field]).toBe(expectedValue);
}

function expectTranslationRunIdEquals(
  result: unknown,
  expectedId: string,
): void {
  expect(getStatusCode(result)).toBeNull();
  if (!isRecord(result) || !isRecord(result["run"])) {
    throw new Error("Expected a translation run response");
  }
  expect(result["run"]["id"]).toBe(expectedId);
}

function expectVersionsContainId(result: unknown, expectedId: string): void {
  expect(getStatusCode(result)).toBeNull();
  if (!isRecord(result) || !Array.isArray(result["versions"])) {
    throw new Error("Expected a versions response");
  }
  expect(
    result["versions"].some(
      (version) => isRecord(version) && version["id"] === expectedId,
    ),
  ).toBe(true);
}

function recordField(result: unknown, field: string): unknown {
  if (!isRecord(result)) {
    throw new Error("Expected an object result");
  }
  return result[field];
}

function globalChatThreadIds(result: unknown): unknown[] {
  expect(getStatusCode(result)).toBeNull();
  const threads = recordField(result, "global");
  if (!Array.isArray(threads)) {
    throw new TypeError("Expected a chat thread list response");
  }
  return threads.map((thread) => recordField(thread, "id"));
}

function chatMessageIds(result: unknown): unknown[] {
  expect(getStatusCode(result)).toBeNull();
  const messages = recordField(result, "messages");
  if (!Array.isArray(messages)) {
    throw new TypeError("Expected a chat message page");
  }
  return messages.map((message) => recordField(message, "id"));
}

const getStatusCode = (result: unknown): number | null => {
  if (!isRecord(result)) {
    return null;
  }

  if (typeof result["status"] === "number") {
    return result["status"];
  }

  if (typeof result["statusCode"] === "number") {
    return result["statusCode"];
  }

  if (typeof result["code"] === "number") {
    return result["code"];
  }

  return null;
};

const getPageItems = (result: unknown): Record<string, unknown>[] => {
  if (!isRecord(result) || !Array.isArray(result["items"])) {
    throw new Error("Expected a page response");
  }

  return result["items"].map((item) => {
    if (!isRecord(item)) {
      throw new Error("Expected every page item to be an object");
    }
    return item;
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
