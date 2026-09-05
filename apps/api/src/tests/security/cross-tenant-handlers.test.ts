import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";
import {
  SIGNAL_KIND,
  SIGNAL_KIND_ORIGIN,
  SIGNAL_SEVERITY,
} from "@stll/api-contract/signals";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawResearchTables,
  documentTranslationRuns,
  entities,
  legalLists,
  notifications,
  savedSearches,
  signals,
  WORK_OBLIGATION_STATUS,
  workObligations,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import readBilingualRun from "@/api/handlers/bilingual-translations/read-run";
import readBillingCodes from "@/api/handlers/billing-codes/list";
import lookupResearchAnswers from "@/api/handlers/case-law/research/answers-lookup";
import readResearchTable from "@/api/handlers/case-law/research/get";
import listResearchTables from "@/api/handlers/case-law/research/list";
import readContactById from "@/api/handlers/contacts/get";
import listDocumentReviewSources from "@/api/handlers/document-reviews/list-sources";
import readDocumentTranslationRun from "@/api/handlers/document-translations/runs/get";
import listDocxSuggestions from "@/api/handlers/docx-suggestions/read";
import readEntityById from "@/api/handlers/entities/get";
import readVersionById from "@/api/handlers/entities/read-version-by-id";
import readVersions from "@/api/handlers/entities/read-versions";
import readExpenses from "@/api/handlers/expenses/list";
import {
  readEmailHtmlPreviewHandler,
  readFileHandler,
} from "@/api/handlers/files/get";
import readInvoiceById from "@/api/handlers/invoices/get";
import listLegalLists from "@/api/handlers/lists/list";
import listMemories from "@/api/handlers/memories/list";
import listNotifications from "@/api/handlers/notifications/list";
import readRateEntries from "@/api/handlers/rates/entries-read";
import listSavedSearches from "@/api/handlers/saved-searches/list";
import listSignals from "@/api/handlers/signals/list";
import getTemplate from "@/api/handlers/templates/get";
import readTimeEntryById from "@/api/handlers/time-entries/get";
import readUserFileContent from "@/api/handlers/user-files/read-content";
import readUserFileThumbnail from "@/api/handlers/user-files/read-thumbnail";
import listMyWork from "@/api/handlers/work-obligations/queues/list";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { SavedSearchCriteria } from "@/api/lib/saved-searches";
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
  memberRole: { role: "owner" };
  orgAIConfig: null;
  orgAIConfigStatus: "ok";
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

let testDb: TestDatabase;
let ids: TestIds;

const noopAuditRecorder: AuditRecorder = async () => undefined;
const savedSearchA = toSafeId<"savedSearch">(
  "11111111-1111-4111-8111-111111111145",
);
const savedSearchB = toSafeId<"savedSearch">(
  "22222222-2222-4222-8222-222222222245",
);
const foreignSignalB = toSafeId<"signal">(
  "22222222-2222-4222-8222-222222222248",
);
const researchTableB = toSafeId<"caseLawResearchTable">(
  "22222222-2222-4222-8222-222222222252",
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
const notificationB = toSafeId<"notification">(
  "22222222-2222-4222-8222-222222222251",
);

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
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readEmailHtmlPreviewHandler, workspaceB, {
        scopedDb: asTestRaw<ScopedDb>(workspaceB.scopedDb),
        fieldId: testIds.fieldB1,
        organizationId: testIds.orgB,
        workspaceId: testIds.wsB1,
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
    expectDenied: expectEmptyPage,
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
    expectDenied: expectEmptyPage,
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
        query: { limit: 100 },
      }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(listLegalLists, workspaceB, {
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
    // Research tables are organization-scoped and visible to every member of
    // the organization, so the organization boundary is the only wall.
    name: "case-law research table list",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(listResearchTables, workspaceA, {
        query: { limit: 100 },
      }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(listResearchTables, workspaceB, {
        query: { limit: 100 },
      }),
    expectDenied: (result) => expectPageExcludesId(result, researchTableB),
    expectPositive: (result) => expectPageContainsId(result, researchTableB),
  },
  {
    name: "case-law research table read",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(readResearchTable, workspaceA, {
        params: { tableId: researchTableB },
      }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(readResearchTable, workspaceB, {
        params: { tableId: researchTableB },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) => {
      expect(result).toMatchObject({ table: { id: researchTableB } });
    },
  },
  {
    // Answers hang off the table: naming another organization's table is a
    // 404 before any cell is read.
    name: "case-law research answers lookup",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(lookupResearchAnswers, workspaceA, {
        params: { tableId: researchTableB },
        body: { decisionIds: [testIds.caseLawDecisionB] },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(lookupResearchAnswers, workspaceB, {
        params: { tableId: researchTableB },
        body: { decisionIds: [testIds.caseLawDecisionB] },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result) => {
      expect(result).toMatchObject({ items: [] });
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
    name: "governed work queue",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(listMyWork, workspaceA, {
        user: { id: testIds.userB1 },
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
];

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
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
  await testDb.insert(caseLawResearchTables).values({
    id: researchTableB,
    organizationId: ids.orgB,
    ownerUserId: ids.userB1,
    name: "Organization B leases",
    savedQuery: { version: 1, query: "lease" },
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
    memberRole: { role: "owner" },
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
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
