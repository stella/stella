import { panic, Result } from "better-result";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { CHAT_SKILL_DOCUMENT } from "@stll/api-contract";
import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";
import {
  SIGNAL_KIND,
  SIGNAL_KIND_ORIGIN,
  SIGNAL_SEVERITY,
} from "@stll/api-contract/signals";
import { VAT_RATE_PRESETS } from "@stll/invoicing";
import { sha256Hex } from "@stll/sha256/bun";

import { member, user as authUser } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  billingArrangements,
  caseLawDecisions,
  caseLawResearchAnswers,
  caseLawResearchColumns,
  caseLawSources,
  chatMessageRevisions,
  chatMessages,
  chatThreads,
  chatToolGrants,
  chatTurns,
  desktopPresence,
  desktopTimeEntryBatches,
  documentTranslationRuns,
  entities,
  entityVersions,
  entityViews,
  featureEnrolments,
  fields,
  invoiceLines,
  invoices,
  legalLists,
  legalReaderAnnotations,
  legalReaderAnswers,
  notifications,
  numberSeries,
  savedSearches,
  savedTimeNarratives,
  searchHistoryEntries,
  sellerProfiles,
  signals,
  templateLookupFormats,
  timeEntries,
  timeTimers,
  vatRates,
  WORK_OBLIGATION_STATUS,
  workObligations,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import readBilingualRun from "@/api/handlers/bilingual-translations/read-run";
import readBillingCodes from "@/api/handlers/billing-codes/list";
import { createLookupResearchAnswers } from "@/api/handlers/case-law/research/answers-lookup";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import getDecisionChatThread from "@/api/handlers/chat/decision-threads/get";
import exportChatMessage from "@/api/handlers/chat/export/create";
import forkChatThread from "@/api/handlers/chat/fork/create";
import readSuggestedChatPrompts from "@/api/handlers/chat/get-suggested-prompts";
import readChatThreadRecap from "@/api/handlers/chat/get-thread-recap";
import readChatThreadTitle from "@/api/handlers/chat/get-thread-title";
import { encodeMessagePageCursor } from "@/api/handlers/chat/message-page";
import getChatMessage from "@/api/handlers/chat/messages/get";
import listChatMessages from "@/api/handlers/chat/messages/list";
import acceptChatMessageRevision from "@/api/handlers/chat/messages/revisions/accept";
import listChatMessageRevisions from "@/api/handlers/chat/messages/revisions/list";
import revertChatMessageRevision from "@/api/handlers/chat/messages/revisions/revert";
import { createProposeMessageSpanEdit } from "@/api/handlers/chat/messages/revisions/span-edit";
import listOlderChatMessages from "@/api/handlers/chat/older-messages/list";
import readFileChatThread from "@/api/handlers/chat/read-file-thread";
import resolveFileChatThread from "@/api/handlers/chat/resolve-file-thread";
import resolveTemplateChatThread from "@/api/handlers/chat/resolve-template-thread";
import rotateTemplateChatThread from "@/api/handlers/chat/rotate-template-thread";
import readSavedChatSecret from "@/api/handlers/chat/saved-secret";
import { createSendMessage } from "@/api/handlers/chat/send-message";
import { compactMessagesForContext } from "@/api/handlers/chat/send-message-compaction";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import listUnavailableChatSkills from "@/api/handlers/chat/skill-availability/list";
import submitChatSecret from "@/api/handlers/chat/submit-secret";
import { createSuggestThreadTitle } from "@/api/handlers/chat/suggest-thread-title";
import { RECAP_PROMPT_VERSION } from "@/api/handlers/chat/thread-recap";
import deleteChatThread from "@/api/handlers/chat/threads/delete";
import listChatThreads from "@/api/handlers/chat/threads/list";
import renameChatThread from "@/api/handlers/chat/threads/rename";
import updateChatThread from "@/api/handlers/chat/threads/update";
import readChatToolGrantCoverage from "@/api/handlers/chat/tool-grants/coverage";
import createChatToolGrant from "@/api/handlers/chat/tool-grants/create";
import deleteChatToolGrant from "@/api/handlers/chat/tool-grants/delete";
import listChatToolGrants from "@/api/handlers/chat/tool-grants/list";
import * as externalMcpToolsModule from "@/api/handlers/chat/tools/external-mcp-tools";
import cancelChatTurn from "@/api/handlers/chat/turns/cancel";
import { joinChatTurn, probeChatTurn } from "@/api/handlers/chat/turns/resume";
import updateChatThreadModel from "@/api/handlers/chat/update-thread-model";
import createClientInvoice from "@/api/handlers/client-invoices/create";
import prefillClientInvoice from "@/api/handlers/client-invoices/prefill";
import readContactById from "@/api/handlers/contacts/get";
import { createDesktopFeatureAccessReadEndpoint } from "@/api/handlers/desktop-feature-access/read";
import readDesktopPresence from "@/api/handlers/desktop-presence/read";
import { createDesktopRegistryRequestEndpoint } from "@/api/handlers/desktop-registry/request";
import {
  createDesktopTimeEntryBatchEndpoint,
  desktopBatchFingerprint,
} from "@/api/handlers/desktop-time-entries/batch";
import { createDesktopTimeEntryBatchStatusEndpoint } from "@/api/handlers/desktop-time-entries/batch-status";
import { createDesktopMatterCandidatesEndpoint } from "@/api/handlers/desktop-time-entries/candidates";
import { createDesktopTimeEntryEndpoint } from "@/api/handlers/desktop-time-entries/create";
import { createDesktopMattersEndpoint } from "@/api/handlers/desktop-time-entries/matters";
import listDocumentReviewSources from "@/api/handlers/document-reviews/list-sources";
import readDocumentTranslationRun from "@/api/handlers/document-translations/runs/get";
import { createDocumentCompareHandler } from "@/api/handlers/documents/compare";
import listDocxSuggestions from "@/api/handlers/docx-suggestions/list";
import resolveDocxSuggestion from "@/api/handlers/docx-suggestions/resolve";
import revertDocxSuggestion from "@/api/handlers/docx-suggestions/revert";
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
import { createListReaderAnnotations } from "@/api/handlers/legal-reader/annotations/list";
import { createListReaderAnswers } from "@/api/handlers/legal-reader/answers/list";
import updateReaderAnswer from "@/api/handlers/legal-reader/answers/update";
import listLegalLists from "@/api/handlers/lists/list";
import deleteMemory from "@/api/handlers/memories/delete";
import listMemories from "@/api/handlers/memories/list";
import updateMemory from "@/api/handlers/memories/update";
import listNotifications from "@/api/handlers/notifications/list";
import markNotificationRead from "@/api/handlers/notifications/read-state/update";
import getNumberSeries from "@/api/handlers/number-series/get";
import listNumberSeries from "@/api/handlers/number-series/list";
import getBillingArrangement from "@/api/handlers/rates/arrangement/get";
import readRateEntries from "@/api/handlers/rates/entries/list";
import listSavedSearches from "@/api/handlers/saved-searches/list";
import listSavedTimeNarratives from "@/api/handlers/saved-time-narratives/list";
import { prepareSearchHistoryRows } from "@/api/handlers/search-history/entries";
import listSearchHistory from "@/api/handlers/search-history/list";
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
import applyVatRatePreset from "@/api/handlers/vat-rates/presets/create";
import updateVatRate from "@/api/handlers/vat-rates/update";
import listMyWork from "@/api/handlers/work-obligations/queues/list";
import { createHttpApp } from "@/api/http/app";
import { createResponseSet } from "@/api/http/context";
import type { ResponseSet } from "@/api/http/context";
import { routes } from "@/api/http/route";
import { status } from "@/api/http/status";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { SafeHandlerLogContext } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DESKTOP_REGISTRY_REQUEST_USER_AGENT } from "@/api/lib/business-registries/desktop/request-contract";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import {
  AI_MEMORY_FEATURE_ID,
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { readFileHandler } from "@/api/lib/files/read-file";
import { cents } from "@/api/lib/money";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import type { SavedSearchCriteria } from "@/api/lib/saved-searches";
import type { generateTanStackTextForTask } from "@/api/lib/tanstack-ai-generate";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";
import { serveForTest } from "@/api/tests/helpers/test-server";
import type { TestServer } from "@/api/tests/helpers/test-server";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestWithdrawalCopyReader } from "@/api/tests/helpers/withdrawn-copy-reader";
import { createRlsDesktopCredentials } from "@/api/tests/security/rls-desktop-credentials";
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

const testState = createTestState({ file: import.meta.path, config: env });

const readCopies = createTestWithdrawalCopyReader(() => testDb);
const listReaderAnnotations = createListReaderAnnotations({ readCopies });
const listReaderAnswers = createListReaderAnswers({ readCopies });
const lookupResearchAnswers = createLookupResearchAnswers({ readCopies });

beforeEach(() => {
  streamChatStub.mockClear();
});

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
  set: ResponseSet;
  server: null;
  path: string;
  headers: Record<string, string>;
  status: typeof status;
  session: { activeOrganizationId: SafeId<"organization"> };
  user: { id: SafeId<"user"> };
  workspaceId: SafeId<"workspace">;
};

type IsolationContext = {
  ids: TestIds;
  desktopA: (request: Request) => Promise<Response>;
  desktopB: (request: Request) => Promise<Response>;
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

const memoryAccess = ({ session, user }: TestHandlerContext) =>
  createFeatureAccessSnapshot({
    organizationId: session.activeOrganizationId,
    userId: user.id,
    decisions: new Map([
      [
        AI_MEMORY_FEATURE_ID,
        decideFeatureAccess({
          registry: FEATURE_REGISTRY,
          featureId: AI_MEMORY_FEATURE_ID,
          grants: {
            [AI_MEMORY_FEATURE_ID]: [
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
let desktopCredentials: Awaited<ReturnType<typeof createRlsDesktopCredentials>>;
const desktopFormatB = createSafeId<"templateLookupFormat">();
const DESKTOP_BATCH_KEY = "matrix-desktop-batch";
// Its own key, so the positive call writes a batch instead of replaying the
// seeded receipt that the status case reads, whatever the case order.
const DESKTOP_CREATE_BATCH_KEY = "matrix-desktop-create-batch";
const DESKTOP_ENTRY = {
  dateWorked: "2026-10-09",
  timezoneId: "UTC",
  durationMinutes: 6,
  narrative: "Reviewed agreement",
  billable: false,
};

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
const clientInvoiceEntryB = toSafeId<"timeEntry">(
  "22222222-2222-4222-8222-222222222296",
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
const searchHistoryEntryB = toSafeId<"searchHistoryEntry">(
  "22222222-2222-4222-8222-222222222290",
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
const privateReaderAnswerB = toSafeId<"legalReaderAnswer">(
  "22222222-2222-4222-8222-222222222301",
);
const sharedReaderAnswerB = toSafeId<"legalReaderAnswer">(
  "22222222-2222-4222-8222-222222222302",
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
// The same user's conversation about a public decision, under organization
// B: a reader in organization A asking about that decision must not find it.
const chatDecisionThreadB = toSafeId<"chatThread">(
  "22222222-2222-4222-8222-222222222293",
);
const chatDecisionB = toSafeId<"caseLawDecision">(
  "22222222-2222-4222-8222-222222222294",
);
const chatForkFromA = toSafeId<"chatThread">(
  "11111111-1111-4111-8111-111111111268",
);
const chatForkFromB = toSafeId<"chatThread">(
  "22222222-2222-4222-8222-222222222268",
);
const chatRevisionThreadB = toSafeId<"chatThread">(
  "22222222-2222-4222-8222-222222222290",
);
const chatMatterThreadB = toSafeId<"chatThread">(
  "22222222-2222-4222-8222-222222222295",
);
const chatMatterMessageB = toSafeId<"chatMessage">(
  "22222222-2222-4222-8222-222222222296",
);
const chatRevisionAcceptMessageB = toSafeId<"chatMessage">(
  "22222222-2222-4222-8222-222222222291",
);
const chatRevisionRevertMessageB = toSafeId<"chatMessage">(
  "22222222-2222-4222-8222-222222222292",
);
// Stored tool approvals of user A1 in organization B: one for every
// conversation, one given in thread B, and one the delete case removes.
const chatToolGrantAlwaysB = toSafeId<"chatToolGrant">(
  "22222222-2222-4222-8222-222222222297",
);
const chatToolGrantConversationB = toSafeId<"chatToolGrant">(
  "22222222-2222-4222-8222-222222222298",
);
const chatToolGrantDeleteB = toSafeId<"chatToolGrant">(
  "22222222-2222-4222-8222-222222222299",
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
const generateTitleFromTranscript: typeof generateTanStackTextForTask = async (
  options,
) =>
  "prompt" in options && options.prompt.includes("Here is the summary.")
    ? "Matter summary"
    : "";

const suggestChatThreadTitle = createSuggestThreadTitle({
  generateTextForTask: generateTitleFromTranscript,
});
const proposeChatMessageSpanEdit = createProposeMessageSpanEdit({
  generateObject: async () => ({ replacement: "Updated" }),
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

const chatToolGrantExists = async (grantId: SafeId<"chatToolGrant">) =>
  (
    await testDb
      .select({ id: chatToolGrants.id })
      .from(chatToolGrants)
      .where(eq(chatToolGrants.id, grantId))
  ).length > 0;

const countChatMessages = async (threadId: SafeId<"chatThread">) =>
  (
    await testDb
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
  ).length;

const CZECH_PRESET_CODES = [
  ...new Set(VAT_RATE_PRESETS.CZ.map(({ code }) => code)),
];

/** An organization's Czech preset rows, read past RLS after a handler ran. */
const countCzechPresetRates = async (organizationId: SafeId<"organization">) =>
  (
    await testDb
      .select({ id: vatRates.id })
      .from(vatRates)
      .where(
        and(
          eq(vatRates.organizationId, organizationId),
          inArray(vatRates.code, CZECH_PRESET_CODES),
        ),
      )
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

// Desktop credential B is user A1 bound to organization B: a successful
// write lands in matter B1 under organization B and that user, nowhere else.
const expectDesktopEntryOwnedByB = async (entryId: string) => {
  const safeEntryId = toSafeId<"timeEntry">(entryId);
  const rows = await testDb
    .select({
      id: timeEntries.id,
      workspaceId: timeEntries.workspaceId,
      organizationId: timeEntries.organizationId,
      userId: timeEntries.userId,
    })
    .from(timeEntries)
    .where(eq(timeEntries.id, safeEntryId));
  expect(rows).toEqual([
    {
      id: safeEntryId,
      workspaceId: ids.wsB1,
      organizationId: ids.orgB,
      userId: ids.userA1,
    },
  ]);
};

const desktopCredentialIsolationCases = (): IsolationCase[] => [
  {
    name: "desktop registry saved format",
    runAAgainstB: async ({ desktopA }) =>
      await desktopA(
        desktopRequest("/registry", {
          type: "setDefaultFormat",
          registry: "ares",
          formatId: desktopFormatB,
        }),
      ),
    runBPositive: async ({ desktopB }) =>
      await desktopB(
        desktopRequest("/registry", {
          type: "setDefaultFormat",
          registry: "ares",
          formatId: desktopFormatB,
        }),
      ),
    expectDenied: (result) => expect(result).toMatchObject({ status: 404 }),
    expectPositive: (result) => expect(result).toMatchObject({ status: 200 }),
  },
  {
    name: "desktop feature access",
    runAAgainstB: async ({ desktopA }) => {
      testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
        "activity-timeline": [
          { type: "organization", organizationId: ids.orgB },
        ],
      });
      const response = await desktopA(desktopRequest("/features"));
      expect(response.status).toBe(200);
      return await response.json();
    },
    runBPositive: async ({ desktopB }) => {
      const response = await desktopB(desktopRequest("/features"));
      expect(response.status).toBe(200);
      return await response.json();
    },
    expectDenied: (result) =>
      expect(result).toMatchObject({
        features: { "activity-timeline": { status: "hidden" } },
      }),
    expectPositive: (result) =>
      expect(result).toMatchObject({
        features: { "activity-timeline": { status: "enabled" } },
      }),
  },
  ...["candidates", "matters"].map((path): IsolationCase => ({
    name: `desktop ${path}`,
    runAAgainstB: async ({ desktopA }) => {
      const response = await desktopA(desktopRequest(`/${path}`));
      expect(response.status).toBe(200);
      return await response.json();
    },
    runBPositive: async ({ desktopB }) => {
      const response = await desktopB(desktopRequest(`/${path}`));
      expect(response.status).toBe(200);
      return await response.json();
    },
    expectDenied: (result, { ids: testIds }) => {
      // A sees its own matter, so an empty list cannot pass as isolation.
      const matters = recordField(result, "matters");
      expect(matters).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: testIds.wsA1 })]),
      );
      expect(matters).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: testIds.wsB1 })]),
      );
    },
    expectPositive: (result, { ids: testIds }) =>
      expect(result).toMatchObject({
        matters: expect.arrayContaining([
          expect.objectContaining({ id: testIds.wsB1 }),
        ]),
      }),
  })),
  {
    name: "desktop batch",
    runAAgainstB: async ({ desktopA, ids: testIds }) =>
      await desktopA(
        desktopRequest("/batch", {
          idempotencyKey: DESKTOP_CREATE_BATCH_KEY,
          entries: [{ matterId: testIds.wsB1, ...DESKTOP_ENTRY }],
        }),
      ),
    runBPositive: async ({ desktopB, ids: testIds }) => {
      const response = await desktopB(
        desktopRequest("/batch", {
          idempotencyKey: DESKTOP_CREATE_BATCH_KEY,
          entries: [{ matterId: testIds.wsB1, ...DESKTOP_ENTRY }],
        }),
      );
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      const entries = recordField(body, "entries");
      expect(Array.isArray(entries) ? entries : []).toHaveLength(1);
      for (const entry of Array.isArray(entries) ? entries : []) {
        await expectDesktopEntryOwnedByB(String(recordField(entry, "id")));
      }
      return body;
    },
    expectDenied: (result) => expect(result).toMatchObject({ status: 404 }),
    expectPositive: (result, { ids: testIds }) =>
      expect(recordField(result, "entries")).toEqual([
        expect.objectContaining({
          id: expect.any(String),
          matterId: testIds.wsB1,
        }),
      ]),
  },
  {
    name: "desktop batch status",
    runAAgainstB: async ({ desktopA }) => {
      const response = await desktopA(
        desktopRequest("/status", { idempotencyKey: DESKTOP_BATCH_KEY }),
      );
      expect(response.status).toBe(200);
      return await response.json();
    },
    runBPositive: async ({ desktopB }) => {
      const response = await desktopB(
        desktopRequest("/status", { idempotencyKey: DESKTOP_BATCH_KEY }),
      );
      expect(response.status).toBe(200);
      return await response.json();
    },
    expectDenied: (result) => expect(result).toEqual({ type: "cancelled" }),
    expectPositive: (result, { ids: testIds }) =>
      expect(result).toEqual({
        type: "committed",
        entries: [{ id: testIds.timeEntryB1, matterId: testIds.wsB1 }],
      }),
  },
  {
    name: "desktop single create",
    runAAgainstB: async ({ desktopA, ids: testIds }) =>
      await desktopA(desktopRequest(`/single/${testIds.wsB1}`, DESKTOP_ENTRY)),
    runBPositive: async ({ desktopB, ids: testIds }) => {
      const response = await desktopB(
        desktopRequest(`/single/${testIds.wsB1}`, DESKTOP_ENTRY),
      );
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      await expectDesktopEntryOwnedByB(String(recordField(body, "id")));
      return body;
    },
    expectDenied: (result) => expect(result).toMatchObject({ status: 404 }),
    expectPositive: (result) =>
      expect(result).toEqual({ id: expect.any(String) }),
  },
];

const isolationCases: IsolationCase[] = [
  ...desktopPresenceIsolationCases(),
  ...desktopCredentialIsolationCases(),
  ...readerAnswerIsolationCases(),
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
          mode: "strict",
          granularity: "word",
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
          mode: "strict",
          granularity: "word",
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
    // The positive run rejects B's suggestion; the revert case below returns
    // it to pending, so the fixture leaves the matrix as it entered.
    name: "docx suggestion resolve",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(resolveDocxSuggestion, workspaceA, {
        params: {
          workspaceId: testIds.wsA1,
          entityId: testIds.entityB1,
          suggestionId: testIds.docxSuggestionB1,
        },
        body: { status: "rejected" },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(resolveDocxSuggestion, workspaceB, {
        params: {
          workspaceId: testIds.wsB1,
          entityId: testIds.entityB1,
          suggestionId: testIds.docxSuggestionB1,
        },
        body: { status: "rejected" },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) => expect(result).toEqual({ updated: true }),
  },
  {
    name: "docx suggestion revert",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(revertDocxSuggestion, workspaceA, {
        params: {
          workspaceId: testIds.wsA1,
          entityId: testIds.entityB1,
          suggestionId: testIds.docxSuggestionB1,
        },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(revertDocxSuggestion, workspaceB, {
        params: {
          workspaceId: testIds.wsB1,
          entityId: testIds.entityB1,
          suggestionId: testIds.docxSuggestionB1,
        },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) => expect(result).toEqual({ updated: true }),
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
    name: "client invoice prefill",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(prefillClientInvoice, workspaceA, {
        params: { clientId: testIds.contactB },
        query: {},
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(prefillClientInvoice, workspaceB, {
        params: { clientId: testIds.contactB },
        query: {},
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expect(result).toMatchObject({
        clientId: testIds.contactB,
        matters: [expect.objectContaining({ workspaceId: testIds.wsB1 })],
      }),
  },
  {
    name: "client invoice create",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(createClientInvoice, workspaceA, {
        params: { clientId: testIds.contactB },
        body: {
          invoiceDate: "2026-10-15",
          currency: "USD",
          matters: [
            {
              workspaceId: testIds.wsB1,
              timeEntryIds: [clientInvoiceEntryB],
              expenseIds: [],
            },
          ],
        },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(createClientInvoice, workspaceB, {
        params: { clientId: testIds.contactB },
        body: {
          invoiceDate: "2026-10-15",
          currency: "USD",
          matters: [
            {
              workspaceId: testIds.wsB1,
              timeEntryIds: [clientInvoiceEntryB],
              expenseIds: [],
            },
          ],
        },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expect(result).toMatchObject({
        id: expect.any(String),
        workspaceId: testIds.wsB1,
        entryCount: 1,
        totalAmount: 200,
      }),
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
    name: "VAT rate preset applies only to the active organization",
    runAAgainstB: async ({ ids: testIds, workspaceA }) => {
      const otherBefore = await countCzechPresetRates(testIds.orgB);
      const result = await runHandler(applyVatRatePreset, workspaceA, {
        body: { country: "CZ" },
      });
      return {
        added: recordField(result, "added"),
        activeRows: await countCzechPresetRates(testIds.orgA),
        otherUnchanged:
          (await countCzechPresetRates(testIds.orgB)) === otherBefore,
      };
    },
    runBPositive: async ({ ids: testIds, workspaceB }) => {
      const result = await runHandler(applyVatRatePreset, workspaceB, {
        body: { country: "CZ" },
      });
      return {
        added: recordField(result, "added"),
        activeRows: await countCzechPresetRates(testIds.orgB),
      };
    },
    expectDenied: (outcome) =>
      expect(outcome).toEqual({
        added: 5,
        activeRows: 5,
        otherUnchanged: true,
      }),
    expectPositive: (outcome) =>
      expect(outcome).toEqual({ added: 5, activeRows: 5 }),
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
    // The same person in another firm: their history there never shows here.
    name: "search history list",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listSearchHistory, workspaceA, {
        query: { limit: 100 },
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(listSearchHistory, sameUserWorkspaceB, {
        query: { limit: 100 },
      }),
    expectDenied: (result) => expectPageExcludesId(result, searchHistoryEntryB),
    expectPositive: (result) =>
      expectPageContainsId(result, searchHistoryEntryB),
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
        featureAccessSnapshot: memoryAccess(workspaceA),
        query: { scope: "organization", status: "active", limit: 100 },
      }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(listMemories, workspaceB, {
        featureAccessSnapshot: memoryAccess(workspaceB),
        query: { scope: "organization", status: "active", limit: 100 },
      }),
    expectDenied: (result, { ids: testIds }) =>
      expectPageExcludesId(result, testIds.aiMemoryFirmB),
    expectPositive: (result, { ids: testIds }) =>
      expectPageContainsId(result, testIds.aiMemoryFirmB),
  },
  {
    // `pinned: false` matches the fixture, so the positive run reaches the
    // locked row without writing.
    name: "memory update",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(updateMemory, workspaceA, {
        featureAccessSnapshot: memoryAccess(workspaceA),
        params: { memoryId: testIds.aiMemoryFirmB },
        body: { pinned: false },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(updateMemory, workspaceB, {
        featureAccessSnapshot: memoryAccess(workspaceB),
        params: { memoryId: testIds.aiMemoryFirmB },
        body: { pinned: false },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expectRecordFieldEquals(result, "id", testIds.aiMemoryFirmB),
  },
  {
    name: "memory delete",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(deleteMemory, workspaceA, {
        featureAccessSnapshot: memoryAccess(workspaceA),
        params: { memoryId: testIds.aiMemoryDeleteB },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(deleteMemory, workspaceB, {
        featureAccessSnapshot: memoryAccess(workspaceB),
        params: { memoryId: testIds.aiMemoryDeleteB },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expect(result).toEqual({ id: testIds.aiMemoryDeleteB }),
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
    // Same organization, other recipient: only the recipient predicate stands
    // between user A1 and user B1's notification.
    name: "notification mark read",
    runAAgainstB: async ({ sameUserWorkspaceB }) =>
      await runHandler(markNotificationRead, sameUserWorkspaceB, {
        params: { notificationId: notificationB },
      }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(markNotificationRead, workspaceB, {
        params: { notificationId: notificationB },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) => expect(result).toEqual({ unreadCount: 0 }),
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
    name: "chat thread list filtered by matter",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listChatThreads, workspaceA, {
        query: { workspaceId: ids.wsB1 },
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(listChatThreads, sameUserWorkspaceB, {
        query: { workspaceId: ids.wsB1 },
      }),
    expectDenied: (result) => {
      expectStatus(404)(result);
      expect(JSON.stringify(result)).not.toContain(chatMatterThreadB);
    },
    expectPositive: (result) =>
      expect(matterChatThreadIds(result)).toEqual([chatMatterThreadB]),
  },
  {
    name: "chat decision conversation lookup",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(getDecisionChatThread, workspaceA, {
        params: { decisionId: chatDecisionB },
        query: {},
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(getDecisionChatThread, sameUserWorkspaceB, {
        params: { decisionId: chatDecisionB },
        query: {},
      }),
    expectDenied: (result) => expect(result).toEqual({ threadId: null }),
    expectPositive: (result) =>
      expect(result).toEqual({ threadId: chatDecisionThreadB }),
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
    name: "chat message revision list",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listChatMessageRevisions, workspaceA, {
        params: { threadId: chatThreadB, messageId: chatAssistantMessageB },
        query: {},
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(listChatMessageRevisions, sameUserWorkspaceB, {
        params: { threadId: chatThreadB, messageId: chatAssistantMessageB },
        query: {},
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) => expect(result).toMatchObject({ items: [] }),
  },
  {
    name: "chat message current read",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(getChatMessage, workspaceA, {
        params: { threadId: chatThreadB, messageId: chatAssistantMessageB },
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(getChatMessage, sameUserWorkspaceB, {
        params: { threadId: chatThreadB, messageId: chatAssistantMessageB },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) =>
      expect(result).toMatchObject({
        id: chatAssistantMessageB,
        revision: 0,
        edited: false,
      }),
  },
  {
    name: "chat message span edit",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(proposeChatMessageSpanEdit, workspaceA, {
        params: { threadId: chatThreadB, messageId: chatAssistantMessageB },
        orgAIConfig: chatOrgAIConfig,
        body: {
          baseRevision: 0,
          start: 0,
          end: 4,
          selectedTextHash: sha256Hex("Here"),
          instruction: "Make it clearer",
        },
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(proposeChatMessageSpanEdit, sameUserWorkspaceB, {
        params: { threadId: chatThreadB, messageId: chatAssistantMessageB },
        orgAIConfig: chatOrgAIConfig,
        body: {
          baseRevision: 0,
          start: 0,
          end: 4,
          selectedTextHash: sha256Hex("Here"),
          instruction: "Make it clearer",
        },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) =>
      expect(result).toMatchObject({
        replacement: "Updated",
        content: {
          version: 3,
          data: [{ type: "text", content: "Updated is the summary." }],
        },
        edit: { type: "ai_span", keySource: "byok" },
      }),
  },
  {
    name: "chat message revision accept",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(acceptChatMessageRevision, workspaceA, {
        params: {
          threadId: chatRevisionThreadB,
          messageId: chatRevisionAcceptMessageB,
        },
        body: {
          baseRevision: 0,
          selectedTextHash: sha256Hex("Here"),
          content: {
            version: 3,
            data: [{ type: "text", content: "**Here** is the summary." }],
          },
          edit: { type: "format", format: "bold", start: 0, end: 4 },
        },
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(acceptChatMessageRevision, sameUserWorkspaceB, {
        params: {
          threadId: chatRevisionThreadB,
          messageId: chatRevisionAcceptMessageB,
        },
        body: {
          baseRevision: 0,
          selectedTextHash: sha256Hex("Here"),
          content: {
            version: 3,
            data: [{ type: "text", content: "**Here** is the summary." }],
          },
          edit: { type: "format", format: "bold", start: 0, end: 4 },
        },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) =>
      expect(result).toMatchObject({ revision: 1, edited: true }),
  },
  {
    name: "chat message revision revert",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(revertChatMessageRevision, workspaceA, {
        params: {
          threadId: chatRevisionThreadB,
          messageId: chatRevisionRevertMessageB,
          revision: 0,
        },
        body: { baseRevision: 1 },
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(revertChatMessageRevision, sameUserWorkspaceB, {
        params: {
          threadId: chatRevisionThreadB,
          messageId: chatRevisionRevertMessageB,
          revision: 0,
        },
        body: { baseRevision: 1 },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) =>
      expect(result).toMatchObject({ revision: 2, edited: true }),
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
    name: "chat saved private input availability",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(readSavedChatSecret, workspaceA, {
        params: { threadId: chatThreadB },
        query: { connectorSlug: "missing-connector" },
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(readSavedChatSecret, sameUserWorkspaceB, {
        params: { threadId: chatThreadB },
        query: { connectorSlug: "missing-connector" },
      }),
    expectDenied: (result) => {
      expect(getStatusCode(result)).toBe(404);
      expect(recordField(result, "response")).toMatchObject({
        message: "Chat thread not found",
      });
    },
    expectPositive: (result) => {
      expect(getStatusCode(result)).toBe(404);
      expect(recordField(result, "response")).toMatchObject({
        message:
          "Enable this connector in settings before providing a credential",
      });
    },
  },
  {
    name: "chat private input submission",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(submitChatSecret, workspaceA, {
        body: { decision: "decline" },
        params: { threadId: chatThreadB, toolCallId: "missing-request" },
        query: {},
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(submitChatSecret, sameUserWorkspaceB, {
        body: { decision: "decline" },
        params: { threadId: chatThreadB, toolCallId: "missing-request" },
        query: {},
      }),
    expectDenied: expectStatus(404),
    expectPositive: expectStatus(409),
  },
  {
    // The same person's approvals in another firm stay with that firm: the
    // list in organization A neither returns them nor sees thread B's grant.
    name: "chat tool grant list",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listChatToolGrants, workspaceA, {
        query: { threadId: chatThreadB },
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(listChatToolGrants, sameUserWorkspaceB, {
        query: { threadId: chatThreadB },
      }),
    expectDenied: (result) => {
      expect(chatToolGrantIds(result)).not.toContain(chatToolGrantAlwaysB);
      expect(chatToolGrantIds(result)).not.toContain(
        chatToolGrantConversationB,
      );
    },
    expectPositive: (result) => {
      expect(chatToolGrantIds(result)).toContain(chatToolGrantAlwaysB);
      expect(chatToolGrantIds(result)).toContain(chatToolGrantConversationB);
    },
  },
  {
    name: "chat tool grant coverage",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(readChatToolGrantCoverage, workspaceA, {
        query: { threadId: chatThreadB, toolName: "web_search" },
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(readChatToolGrantCoverage, sameUserWorkspaceB, {
        query: { threadId: chatThreadB, toolName: "web_search" },
      }),
    expectDenied: (result) => expect(result).toEqual({ covered: false }),
    expectPositive: (result) => expect(result).toEqual({ covered: true }),
  },
  {
    // A grant names the conversation it was given in; organization A cannot
    // attach one to thread B.
    name: "chat tool grant create",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(createChatToolGrant, workspaceA, {
        body: {
          scope: "conversation",
          threadId: chatThreadB,
          toolName: "add_comment",
        },
      }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(createChatToolGrant, sameUserWorkspaceB, {
        body: {
          scope: "conversation",
          threadId: chatThreadB,
          toolName: "add_comment",
        },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) =>
      expect(result).toMatchObject({
        scope: "conversation",
        toolName: "add_comment",
      }),
  },
  {
    name: "chat tool grant delete",
    runAAgainstB: async ({ workspaceA }) => ({
      response: await runHandler(deleteChatToolGrant, workspaceA, {
        params: { grantId: chatToolGrantDeleteB },
      }),
      exists: await chatToolGrantExists(chatToolGrantDeleteB),
    }),
    runBPositive: async ({ sameUserWorkspaceB }) =>
      await runHandler(deleteChatToolGrant, sameUserWorkspaceB, {
        params: { grantId: chatToolGrantDeleteB },
      }),
    expectDenied: (result) => {
      expect(recordField(result, "response")).toEqual({ deleted: false });
      expect(recordField(result, "exists")).toBe(true);
    },
    expectPositive: (result) => expect(result).toEqual({ deleted: true }),
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

testState.beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  await testDb
    .update(authUser)
    .set({ email: "desktop-review-a@example.test" })
    .where(eq(authUser.id, ids.userA1));
  await testDb
    .update(authUser)
    .set({ email: "desktop-review@example.test" })
    .where(eq(authUser.id, ids.userB1));
  testState.setConfig("FEATURE_TIME_BILLING", true);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    ...env.API_FEATURE_ACCESS_GRANTS,
    "activity-timeline": [
      {
        type: "member",
        organizationId: ids.orgB,
        email: "desktop-review@example.test",
      },
    ],
  });
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
  await testDb.insert(templateLookupFormats).values({
    id: desktopFormatB,
    organizationId: ids.orgB,
    registry: "ares",
    name: "Matrix format B",
    format: "[company name]",
  });
  desktopCredentials = await createRlsDesktopCredentials(testDb, ids);
  await testDb.insert(desktopTimeEntryBatches).values({
    organizationId: ids.orgB,
    userId: ids.userA1,
    idempotencyKey: DESKTOP_BATCH_KEY,
    status: "committed",
    requestFingerprint: desktopBatchFingerprint({
      idempotencyKey: DESKTOP_BATCH_KEY,
      entries: [{ matterId: ids.wsB1, ...DESKTOP_ENTRY }],
    }),
    result: { entries: [{ id: ids.timeEntryB1, matterId: ids.wsB1 }] },
  });
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
  await testDb.insert(timeEntries).values({
    id: clientInvoiceEntryB,
    organizationId: ids.orgB,
    workspaceId: ids.wsB1,
    userId: ids.userB1,
    dateWorked: "2026-10-14",
    timezoneId: "UTC",
    durationMinutes: 60,
    billedMinutes: 60,
    rateAtEntry: cents(200),
    currency: "USD",
    narrative: "Client invoice isolation work",
    billable: true,
    status: "approved",
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
  const [searchHistoryRowB] = await prepareSearchHistoryRows(
    { organizationId: ids.orgB, userId: ids.userA1 },
    [
      {
        entry: { kind: "search", query: "Firm B research" },
        usedAt: new Date(),
      },
    ],
  );
  if (searchHistoryRowB === undefined) {
    throw new Error("Search history fixture was not prepared");
  }
  await testDb
    .insert(searchHistoryEntries)
    .values({ ...searchHistoryRowB, id: searchHistoryEntryB });
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
    tool: { version: 1, task: "short-text" },
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
  await testDb.insert(legalReaderAnswers).values([
    {
      id: privateReaderAnswerB,
      organizationId: ids.orgB,
      userId: ids.userB1,
      decisionId: ids.caseLawDecisionB,
      kind: "explain",
      visibility: "private",
      paragraphId: "p-1",
      startOffset: 0,
      endOffset: 9,
      quote: "important",
    },
    {
      id: sharedReaderAnswerB,
      organizationId: ids.orgB,
      userId: ids.userB1,
      decisionId: ids.caseLawDecisionB,
      kind: "ask",
      visibility: "shared",
      paragraphId: "p-1",
      startOffset: 0,
      endOffset: 9,
      quote: "important",
    },
  ]);
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
    { ...chatThreadOfB(chatDecisionThreadB), subjectDecisionId: chatDecisionB },
  ]);
  const chatText = (text: string) =>
    toPersistedChatMessageContentV3({
      data: [{ type: "text" as const, content: text }],
    });
  await testDb.insert(chatThreads).values(chatThreadOfB(chatRevisionThreadB));
  await testDb.insert(chatThreads).values({
    ...chatThreadOfB(chatMatterThreadB),
    workspaceId: ids.wsB1,
  });
  await testDb.insert(chatMessages).values(
    [chatRevisionAcceptMessageB, chatRevisionRevertMessageB].map((id) => ({
      id,
      threadId: chatRevisionThreadB,
      userId: ids.userA1,
      workspaceId: null,
      role: "assistant" as const,
      content: chatText("Here is the summary."),
      revision: id === chatRevisionRevertMessageB ? 1 : 0,
    })),
  );
  await testDb.insert(chatMessageRevisions).values({
    messageId: chatRevisionRevertMessageB,
    threadId: chatRevisionThreadB,
    workspaceId: null,
    revision: 0,
    content: chatText("Here is the summary."),
    edit: { type: "format", format: "bold", start: 0, end: 4 },
    createdBy: ids.userA1,
  });
  const chatAskedAt = new Date("2026-09-01T09:00:00.000Z");
  await testDb.insert(chatMessages).values({
    id: chatMatterMessageB,
    threadId: chatMatterThreadB,
    userId: ids.userA1,
    workspaceId: ids.wsB1,
    role: "user",
    content: chatText("Summarise the matter."),
    createdAt: chatAskedAt,
  });
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
  await testDb.insert(chatToolGrants).values([
    {
      id: chatToolGrantAlwaysB,
      organizationId: ids.orgB,
      userId: ids.userA1,
      scope: "always",
      toolName: "web_search",
    },
    {
      id: chatToolGrantConversationB,
      organizationId: ids.orgB,
      userId: ids.userA1,
      scope: "conversation",
      chatThreadId: chatThreadB,
      toolName: "remember",
    },
    {
      id: chatToolGrantDeleteB,
      organizationId: ids.orgB,
      userId: ids.userA1,
      scope: "always",
      toolName: "fetch_url",
    },
  ]);
});

afterAll(async () => {
  await releaseTestDb();
});

describe("cross-tenant handler isolation", () => {
  test.each([
    "reader answers across organizations",
    "legal reader annotation list",
    "case-law research answers lookup",
  ])(
    "%s: withdrawal changes content but preserves visible resource identities",
    async (name) => {
      const testCase =
        isolationCases.find((candidate) => candidate.name === name) ??
        panic("Missing withdrawal isolation case");
      const context = createIsolationContext();
      const beforeA = await testCase.runAAgainstB(context);
      const beforeB = await testCase.runBPositive(context);
      testCase.expectDenied(beforeA, context);
      testCase.expectPositive(beforeB, context);
      const identities = (result: unknown) =>
        getPageItems(result).map((item) => ({
          id: item["id"],
          columnId: item["columnId"],
          decisionId: item["decisionId"],
        }));
      const sourceId = createSafeId<"caseLawSource">();
      await testDb.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: sourceId,
        name: "Withdrawal isolation fixture",
        enabled: false,
      });
      const [originalDecision] = await testDb
        .select()
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, ids.caseLawDecisionB))
        .limit(1);
      try {
        await testDb
          .insert(caseLawDecisions)
          .values({
            id: ids.caseLawDecisionB,
            sourceId,
            sourceDocumentId: ids.caseLawDecisionB,
            caseNumber: "Fixture",
            court: "Fixture court",
            country: "POL",
            language: "pl",
            redactedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: caseLawDecisions.id,
            set: {
              redactedAt: new Date(),
              fulltext: null,
              contentHash: null,
              sections: null,
              documentAst: null,
            },
          });
        const afterA = await testCase.runAAgainstB(createIsolationContext());
        const afterB = await testCase.runBPositive(createIsolationContext());
        expect(getStatusCode(afterA)).toBeNull();
        expect(getStatusCode(afterB)).toBeNull();
        expect(identities(afterA)).toEqual(identities(beforeA));
        expect(identities(afterB)).toEqual(identities(beforeB));
        expect(JSON.stringify(afterB)).toContain("Withdrawn by publisher");
      } finally {
        if (originalDecision !== undefined) {
          await testDb
            .update(caseLawDecisions)
            .set(originalDecision)
            .where(eq(caseLawDecisions.id, ids.caseLawDecisionB));
        } else {
          await testDb
            .delete(caseLawDecisions)
            .where(eq(caseLawDecisions.id, ids.caseLawDecisionB));
        }
        await testDb
          .delete(caseLawSources)
          .where(eq(caseLawSources.id, sourceId));
      }
    },
  );
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
  desktopA: desktopCaller("a"),
  desktopB: desktopCaller("b"),
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
    set: createResponseSet(),
    server: null,
    path: `/workspaces/${workspaceId}`,
    headers: {},
    status,
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
      asTestRaw<TContext & SafeHandlerLogContext>({
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

function readerAnswerIsolationCases(): IsolationCase[] {
  const list = async (
    context: TestHandlerContext,
    decisionId: SafeId<"caseLawDecision">,
  ) =>
    await runHandler(listReaderAnswers, context, {
      query: { decisionId, limit: 50 },
    });
  const update = async (context: TestHandlerContext) =>
    await runHandler(updateReaderAnswer, context, {
      params: { answerId: sharedReaderAnswerB },
      body: { visibility: "shared" },
    });
  return [
    {
      name: "reader answers across organizations",
      runAAgainstB: async ({ ids: testIds, workspaceA }) =>
        await list(workspaceA, testIds.caseLawDecisionB),
      runBPositive: async ({ ids: testIds, workspaceB }) =>
        await list(workspaceB, testIds.caseLawDecisionB),
      expectDenied: (result) => {
        expectPageExcludesId(result, privateReaderAnswerB);
        expectPageExcludesId(result, sharedReaderAnswerB);
      },
      expectPositive: (result) => {
        expectPageContainsId(result, privateReaderAnswerB);
        expectPageContainsId(result, sharedReaderAnswerB);
      },
    },
    {
      name: "reader answer mutation across organizations",
      runAAgainstB: async ({ workspaceA }) => await update(workspaceA),
      runBPositive: async ({ workspaceB }) => await update(workspaceB),
      expectDenied: expectStatus(404),
      expectPositive: (result) =>
        expect(result).toMatchObject({
          id: sharedReaderAnswerB,
          visibility: "shared",
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

function chatToolGrantIds(result: unknown): unknown[] {
  expect(getStatusCode(result)).toBeNull();
  const grants = recordField(result, "grants");
  if (!Array.isArray(grants)) {
    throw new TypeError("Expected a chat tool grant list response");
  }
  return grants.map((grant) => recordField(grant, "id"));
}

function globalChatThreadIds(result: unknown): unknown[] {
  expect(getStatusCode(result)).toBeNull();
  const threads = recordField(result, "global");
  if (!Array.isArray(threads)) {
    throw new TypeError("Expected a chat thread list response");
  }
  return threads.map((thread) => recordField(thread, "id"));
}

function matterChatThreadIds(result: unknown): unknown[] {
  expect(getStatusCode(result)).toBeNull();
  const groups = recordField(result, "workspaces");
  if (!Array.isArray(groups)) {
    throw new TypeError("Expected a chat thread list response");
  }
  return groups.flatMap((group) => {
    const threads = recordField(group, "threads");
    if (!Array.isArray(threads)) {
      throw new TypeError("Expected a chat thread group");
    }
    return threads.map((thread) => recordField(thread, "id"));
  });
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

testState.beforeAll(() => {
  testState.setConfig("FEATURE_TIME_BILLING", true);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "activity-timeline": [ids.orgA, ids.orgB].map((organizationId) => ({
      type: "organization" as const,
      organizationId,
    })),
  });
});

const desktopServer = (): TestServer => {
  const authorize = desktopCredentials.authorizeDesktopAccount;
  const registry = createDesktopRegistryRequestEndpoint({
    config: authorize,
    revoke: authorize,
    search: desktopCredentials.authorizeDesktopRegistry,
    format: desktopCredentials.authorizeDesktopRegistry,
    setDefaultFormat: desktopCredentials.authorizeDesktopRegistry,
  });
  const feature = createDesktopFeatureAccessReadEndpoint({
    authorizeAccount: authorize,
  });
  const candidates = createDesktopMatterCandidatesEndpoint(authorize);
  const matters = createDesktopMattersEndpoint(authorize);
  const batch = createDesktopTimeEntryBatchEndpoint(authorize);
  const batchStatus = createDesktopTimeEntryBatchStatusEndpoint(authorize);
  const single = createDesktopTimeEntryEndpoint(authorize);
  // The real routes on the real HTTP core: each definition decodes its own
  // input and answers through its own response schemas.
  return serveForTest(
    createHttpApp({
      middleware: [errorBoundary],
      routes: routes({
        "/registry": { PUT: registry },
        "/features": { GET: feature },
        "/candidates": { GET: candidates },
        "/matters": { GET: matters },
        "/batch": { PUT: batch },
        "/status": { PUT: batchStatus },
        "/single/:workspaceId": { PUT: single },
      }),
    }),
  );
};

// One server answers both tenants; the credential decides who is calling.
let desktopRoutes: TestServer | undefined;

afterAll(async () => {
  await desktopRoutes?.stop();
});

const desktopCaller = (tenant: "a" | "b") => async (request: Request) => {
  desktopRoutes ??= desktopServer();
  const credential =
    tenant === "a" ? desktopCredentials.a : desktopCredentials.b;
  return await desktopRoutes.fetch(await credential.signRequest(request));
};

/** A request as the desktop app sends it: its HTTP client names itself on
 *  every call, and the registry route admits no other agent. */
const desktopRequest = (path: string, body?: unknown) =>
  new Request(
    `http://localhost${path}`,
    body === undefined
      ? { headers: { "user-agent": DESKTOP_REGISTRY_REQUEST_USER_AGENT } }
      : {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "user-agent": DESKTOP_REGISTRY_REQUEST_USER_AGENT,
          },
          body: JSON.stringify(body),
        },
  );
