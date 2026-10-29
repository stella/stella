import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import { INVOICE_LINE_SOURCE } from "@stll/api-contract";
import { cents } from "@stll/money";
import { sha256Hex } from "@stll/sha256/bun";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  clauseCategories,
  clauses,
  clauseVariants,
  clauseVersions,
  contactRelationships,
  contacts,
  entities,
  entityVersions,
  expenses,
  fields,
  INVOICE_PAYMENT_ORIGIN,
  invoiceLines,
  invoicePayments,
  invoices,
  properties,
  sellerProfiles,
  taskAssignees,
  templateCategories,
  templates,
  templateVersions,
  timeEntries,
  workspaceContacts,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import type { TestDatabase } from "@/api/tests/security/test-utils";

export type DataExportCompletenessFixture = {
  db: TestDatabase;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  personalMatterId: SafeId<"workspace">;
  documentFileBytes: ReadonlyMap<string, Uint8Array>;
  cleanup: () => Promise<void>;
};

const createState = (db: TestDatabase) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const clientId = createSafeId<"contact">();
  const personId = createSafeId<"contact">();
  const nullActorContactId = createSafeId<"contact">();
  const matterA = createSafeId<"workspace">();
  const matterB = createSafeId<"workspace">();
  const personalMatterId = createSafeId<"workspace">();
  const orgInvoiceId = createSafeId<"invoice">();
  const creditNoteId = createSafeId<"invoice">();
  const matterInvoiceId = createSafeId<"invoice">();
  const secondMatterInvoiceId = createSafeId<"invoice">();
  const personalMatterInvoiceId = createSafeId<"invoice">();
  const sellerProfileId = createSafeId<"sellerProfile">();
  const clauseCategoryId = createSafeId<"clauseCategory">();
  const templateCategoryId = createSafeId<"templateCategory">();
  const clauseIds = [createSafeId<"clause">(), createSafeId<"clause">()];
  const clauseVersionIds = [
    createSafeId<"clauseVersion">(),
    createSafeId<"clauseVersion">(),
  ];
  const clauseVariantIds = [
    createSafeId<"clauseVariant">(),
    createSafeId<"clauseVariant">(),
  ];
  const templateIds = [createSafeId<"template">(), createSafeId<"template">()];
  const templateVersionIds = [
    createSafeId<"templateVersion">(),
    createSafeId<"templateVersion">(),
  ];
  const folderId = createSafeId<"entity">();
  const taskIds = [createSafeId<"entity">(), createSafeId<"entity">()];
  const documentIds = [createSafeId<"entity">(), createSafeId<"entity">()];
  const versionIds = [
    createSafeId<"entityVersion">(),
    createSafeId<"entityVersion">(),
  ];
  const propertyIds = [createSafeId<"property">(), createSafeId<"property">()];
  const fieldIds = [createSafeId<"field">(), createSafeId<"field">()];
  const fileIds = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
  const fileBytes = fileIds.map((_, index) =>
    new TextEncoder().encode(`complete export document ${index}`),
  );
  const timeEntryIds = [
    createSafeId<"timeEntry">(),
    createSafeId<"timeEntry">(),
    createSafeId<"timeEntry">(),
    createSafeId<"timeEntry">(),
  ];
  const expenseIds = [createSafeId<"expense">(), createSafeId<"expense">()];
  const invoiceLineIds = [
    createSafeId<"invoiceLine">(),
    createSafeId<"invoiceLine">(),
    createSafeId<"invoiceLine">(),
  ];
  const invoicePaymentIds = [
    createSafeId<"invoicePayment">(),
    createSafeId<"invoicePayment">(),
  ];
  const workspaceContactIds = [
    createSafeId<"workspaceContact">(),
    createSafeId<"workspaceContact">(),
  ];
  const taskAssigneeId = createSafeId<"taskAssignee">();
  const contactRelationshipId = createSafeId<"contactRelationship">();

  return {
    db,
    organizationId,
    userId,
    clientId,
    personId,
    nullActorContactId,
    matterA,
    matterB,
    personalMatterId,
    orgInvoiceId,
    creditNoteId,
    matterInvoiceId,
    secondMatterInvoiceId,
    personalMatterInvoiceId,
    sellerProfileId,
    clauseCategoryId,
    templateCategoryId,
    clauseIds,
    clauseVersionIds,
    clauseVariantIds,
    templateIds,
    templateVersionIds,
    folderId,
    taskIds,
    documentIds,
    versionIds,
    propertyIds,
    fieldIds,
    fileIds,
    fileBytes,
    timeEntryIds,
    expenseIds,
    invoiceLineIds,
    invoicePaymentIds,
    workspaceContactIds,
    taskAssigneeId,
    contactRelationshipId,
  };
};

type FixtureState = ReturnType<typeof createState>;

const seedOrganization = async (state: FixtureState): Promise<void> => {
  const {
    db,
    organizationId,
    userId,
    clientId,
    personId,
    nullActorContactId,
    matterA,
    matterB,
    personalMatterId,
    workspaceContactIds,
    contactRelationshipId,
    clauseCategoryId,
    templateCategoryId,
  } = state;
  await db.insert(user).values({
    id: userId,
    name: "Export owner",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: organizationId,
    name: "Export completeness organization",
    slug: organizationId,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
  });
  await recordNewOrganizationAccessState(db, {
    organizationId,
    now: new Date("2026-10-01T00:00:00.000Z"),
  });
  await db.insert(member).values({
    id: Bun.randomUUIDv7(),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
  });
  await db.insert(contacts).values([
    {
      id: clientId,
      organizationId,
      type: "organization",
      organizationName: "Export Client",
      displayName: "Export Client",
      createdBy: userId,
      originatingAttorneyId: userId,
      responsibleAttorneyId: userId,
    },
    {
      id: personId,
      organizationId,
      type: "person",
      firstName: "Export",
      lastName: "Contact",
      displayName: "Export Contact",
      createdBy: userId,
    },
    {
      id: nullActorContactId,
      organizationId,
      type: "person",
      firstName: "Unattributed",
      lastName: "Contact",
      displayName: "Unattributed Contact",
      createdBy: null,
      originatingAttorneyId: null,
      responsibleAttorneyId: null,
    },
  ]);
  await db.insert(workspaces).values([
    {
      id: matterA,
      organizationId,
      name: "Export Matter A",
      reference: "EXP-A",
      clientId,
      leadUserId: userId,
    },
    {
      id: matterB,
      organizationId,
      name: "Export Matter B",
      reference: "EXP-B",
      clientId,
      leadUserId: null,
    },
    {
      id: personalMatterId,
      organizationId,
      name: "Excluded Personal Matter",
      reference: "EXP-P",
      clientId: null,
      leadUserId: null,
    },
  ]);
  await db.insert(workspaceMembers).values(
    [matterA, matterB, personalMatterId].map((workspaceId) => ({
      id: createSafeId<"workspaceMember">(),
      workspaceId,
      userId,
    })),
  );
  await db.insert(workspaceContacts).values(
    [matterA, matterB].map((workspaceId, index) => ({
      id:
        workspaceContactIds.at(index) ??
        panic("Missing workspace contact fixture ID"),
      organizationId,
      workspaceId,
      contactId: personId,
      role: "other" as const,
    })),
  );
  await db.insert(contactRelationships).values({
    id: contactRelationshipId,
    organizationId,
    personId,
    relatedContactId: clientId,
    relationshipType: "employee",
  });
  await db.insert(clauseCategories).values({
    id: clauseCategoryId,
    organizationId,
    name: "Export clause category",
  });
  await db.insert(templateCategories).values({
    id: templateCategoryId,
    organizationId,
    name: "Export template category",
  });
};

const seedClausesAndTemplates = async (state: FixtureState): Promise<void> => {
  const {
    db,
    organizationId,
    userId,
    clauseCategoryId,
    templateCategoryId,
    clauseIds,
    clauseVersionIds,
    clauseVariantIds,
    templateIds,
    templateVersionIds,
  } = state;
  await db.insert(clauses).values([
    {
      id: clauseIds.at(0) ?? panic("Missing clause fixture ID"),
      organizationId,
      categoryId: clauseCategoryId,
      title: "Categorized clause",
      body: [{ text: "Clause body" }],
      createdBy: userId,
    },
    {
      id: clauseIds.at(1) ?? panic("Missing clause fixture ID"),
      organizationId,
      categoryId: null,
      title: "Uncategorized clause",
      body: [{ text: "Clause body" }],
      createdBy: userId,
    },
  ]);
  await db.insert(clauseVersions).values(
    clauseIds.map((clauseId, index) => ({
      id:
        clauseVersionIds.at(index) ??
        panic("Missing clause version fixture ID"),
      organizationId,
      clauseId,
      version: 1,
      body: [{ text: "Version body" }],
    })),
  );
  await db.insert(clauseVariants).values(
    clauseIds.map((clauseId, index) => ({
      id:
        clauseVariantIds.at(index) ??
        panic("Missing clause variant fixture ID"),
      organizationId,
      clauseId,
      label: `Variant ${index + 1}`,
      body: [{ text: "Variant body" }],
    })),
  );
  await db.insert(templates).values(
    templateIds.map((id, index) => ({
      id,
      organizationId,
      categoryId: index === 0 ? templateCategoryId : null,
      name: `Export Template ${index + 1}`,
      fileName: `template-${index + 1}.docx`,
      s3Key: `${organizationId}/export/template-${index + 1}`,
      sizeBytes: 16,
      createdBy: userId,
    })),
  );
  await db.insert(templateVersions).values(
    templateIds.map((templateId, index) => ({
      id:
        templateVersionIds.at(index) ??
        panic("Missing template version fixture ID"),
      organizationId,
      templateId,
      version: 1,
      s3Key: `${organizationId}/export/template-${index + 1}-v1`,
      createdBy: userId,
    })),
  );
  await db.insert(sellerProfiles).values({
    id: state.sellerProfileId,
    organizationId,
    legalName: "Export Seller",
    defaultCurrency: "EUR",
  });
  await db.insert(invoices).values([
    {
      id: state.orgInvoiceId,
      organizationId,
      clientId: state.clientId,
      workspaceId: null,
      invoiceNumber: "EXP-ORG-1",
      invoiceDate: "2026-10-01",
      currency: "EUR",
    },
    {
      id: state.creditNoteId,
      organizationId,
      clientId: state.clientId,
      workspaceId: null,
      invoiceNumber: "EXP-ORG-CN-1",
      documentType: "credit_note",
      originalInvoiceId: state.orgInvoiceId,
      sellerProfileId: state.sellerProfileId,
      invoiceDate: "2026-10-02",
      currency: "EUR",
    },
    {
      id: state.matterInvoiceId,
      organizationId,
      clientId: null,
      workspaceId: state.matterA,
      invoiceNumber: "EXP-A-1",
      invoiceDate: "2026-10-03",
      currency: "EUR",
    },
    {
      id: state.secondMatterInvoiceId,
      organizationId,
      clientId: state.clientId,
      workspaceId: state.matterB,
      invoiceNumber: "EXP-B-1",
      invoiceDate: "2026-10-04",
      currency: "EUR",
    },
    {
      id: state.personalMatterInvoiceId,
      organizationId,
      clientId: null,
      workspaceId: state.personalMatterId,
      invoiceNumber: "EXP-PERSONAL-1",
      invoiceDate: "2026-10-05",
      currency: "EUR",
    },
  ]);
};

const seedMattersAndDocuments = async (state: FixtureState): Promise<void> => {
  const {
    db,
    userId,
    matterA,
    matterB,
    personalMatterId,
    folderId,
    taskIds,
    documentIds,
    versionIds,
    propertyIds,
    fieldIds,
    fileIds,
    fileBytes,
    taskAssigneeId,
  } = state;
  await db.insert(entities).values([
    {
      id: folderId,
      workspaceId: matterA,
      kind: "folder",
      name: "Export folder",
      createdBy: userId,
      lastEditedBy: userId,
    },
    {
      id: taskIds.at(0) ?? panic("Missing task fixture ID"),
      workspaceId: matterA,
      kind: "task",
      parentId: folderId,
      name: "Export task A",
      createdBy: userId,
      lastEditedBy: userId,
    },
    {
      id: taskIds.at(1) ?? panic("Missing task fixture ID"),
      workspaceId: matterB,
      kind: "task",
      name: "Export task B",
      createdBy: null,
      lastEditedBy: null,
    },
    {
      id: documentIds.at(0) ?? panic("Missing document fixture ID"),
      workspaceId: matterA,
      kind: "document",
      parentId: folderId,
      name: "Export document A.pdf",
      createdBy: userId,
      lastEditedBy: userId,
    },
    {
      id: documentIds.at(1) ?? panic("Missing document fixture ID"),
      workspaceId: matterB,
      kind: "document",
      name: "Export document B.pdf",
      createdBy: null,
      lastEditedBy: null,
    },
    {
      id: createSafeId<"entity">(),
      workspaceId: personalMatterId,
      kind: "task",
      name: "Excluded personal task",
    },
  ]);
  await db.insert(properties).values(
    [matterA, matterB].map((workspaceId, index) => ({
      id: propertyIds.at(index) ?? panic("Missing property fixture ID"),
      workspaceId,
      name: `Export file ${index + 1}`,
      content: { version: 1 as const, type: "file" as const },
      tool: { version: 1 as const, type: "manual-input" as const },
      status: "fresh" as const,
    })),
  );
  await db.insert(entityVersions).values(
    documentIds.map((entityId, index) => ({
      id: versionIds.at(index) ?? panic("Missing document version fixture ID"),
      workspaceId: index === 0 ? matterA : matterB,
      entityId,
      versionNumber: 1,
      createdBy: index === 0 ? userId : null,
    })),
  );
  await db
    .update(entities)
    .set({
      currentVersionId:
        versionIds.at(0) ?? panic("Missing document version fixture ID"),
    })
    .where(
      eq(
        entities.id,
        documentIds.at(0) ?? panic("Missing document fixture ID"),
      ),
    );
  await db.insert(fields).values(
    versionIds.map((entityVersionId, index) => {
      const bytes = fileBytes.at(index) ?? panic("Missing document file bytes");
      return {
        id: fieldIds.at(index) ?? panic("Missing file field fixture ID"),
        workspaceId: index === 0 ? matterA : matterB,
        propertyId:
          propertyIds.at(index) ?? panic("Missing property fixture ID"),
        entityVersionId,
        content: {
          version: 1 as const,
          type: "file" as const,
          id: fileIds.at(index) ?? panic("Missing file fixture ID"),
          fileName: `export-${index + 1}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: bytes.byteLength,
          encrypted: false,
          sha256Hex: sha256Hex(bytes),
          pdfFileId: null,
        },
      };
    }),
  );
  await db.insert(taskAssignees).values({
    id: taskAssigneeId,
    workspaceId: matterA,
    entityId: taskIds.at(0) ?? panic("Missing task fixture ID"),
    userId,
    role: "assignee",
  });
};

const seedBilling = async (state: FixtureState): Promise<void> => {
  const {
    db,
    organizationId,
    userId,
    matterA,
    matterB,
    orgInvoiceId,
    matterInvoiceId,
    secondMatterInvoiceId,
    taskIds,
    timeEntryIds,
    expenseIds,
    invoiceLineIds,
    invoicePaymentIds,
  } = state;
  await db.insert(expenses).values([
    {
      id: expenseIds.at(0) ?? panic("Missing expense fixture ID"),
      organizationId,
      workspaceId: matterA,
      userId: null,
      matterId: taskIds.at(0) ?? panic("Missing task fixture ID"),
      dateIncurred: "2026-10-05",
      amount: cents(1200),
      currency: "EUR",
      category: "other",
      description: "Standalone expense",
      invoiceId: null,
    },
    {
      id: expenseIds.at(1) ?? panic("Missing expense fixture ID"),
      organizationId,
      workspaceId: matterB,
      userId,
      matterId: taskIds.at(1) ?? panic("Missing task fixture ID"),
      dateIncurred: "2026-10-06",
      amount: cents(3400),
      currency: "EUR",
      category: "other",
      description: "Invoiced expense",
      invoiceId: secondMatterInvoiceId,
    },
  ]);
  await db.insert(timeEntries).values([
    {
      id: timeEntryIds.at(0) ?? panic("Missing time entry fixture ID"),
      organizationId,
      activityGroup: "internal",
      workspaceId: null,
      userId: null,
      approverUserId: null,
      workItemId: null,
      invoiceId: null,
      dateWorked: "2026-10-01",
      timezoneId: "Europe/Prague",
      durationMinutes: 60,
      billedMinutes: 0,
      rateAtEntry: cents(0),
      currency: UNPRICED_TIME_ENTRY_CURRENCY,
      narrative: "Unassigned internal entry",
      billable: false,
      noCharge: false,
    },
    {
      id: timeEntryIds.at(1) ?? panic("Missing time entry fixture ID"),
      organizationId,
      activityGroup: "client",
      workspaceId: matterA,
      userId,
      approverUserId: userId,
      workItemId: taskIds.at(0) ?? panic("Missing task fixture ID"),
      invoiceId: matterInvoiceId,
      dateWorked: "2026-10-02",
      timezoneId: "Europe/Prague",
      durationMinutes: 60,
      billedMinutes: 60,
      rateAtEntry: cents(1000),
      currency: "EUR",
      narrative: "Invoiced entry",
    },
    {
      id: timeEntryIds.at(2) ?? panic("Missing time entry fixture ID"),
      organizationId,
      activityGroup: "client",
      workspaceId: matterB,
      userId: null,
      approverUserId: null,
      workItemId: null,
      invoiceId: null,
      dateWorked: "2026-10-03",
      timezoneId: "Europe/Prague",
      durationMinutes: 45,
      billedMinutes: 45,
      rateAtEntry: cents(1000),
      currency: "EUR",
      narrative: "Unbilled entry",
    },
    {
      id: timeEntryIds.at(3) ?? panic("Missing time entry fixture ID"),
      organizationId,
      activityGroup: "client",
      workspaceId: matterA,
      userId,
      approverUserId: null,
      workItemId: null,
      invoiceId: null,
      dateWorked: "2026-10-04",
      timezoneId: "Europe/Prague",
      durationMinutes: 30,
      billedMinutes: 30,
      rateAtEntry: cents(1000),
      currency: "EUR",
      narrative: "Null work item entry",
    },
  ]);
  await db.insert(invoiceLines).values([
    {
      id: invoiceLineIds.at(0) ?? panic("Missing invoice line fixture ID"),
      organizationId,
      workspaceId: matterB,
      invoiceId: orgInvoiceId,
      position: 0,
      description: "Cross-matter line",
      quantity: "1",
      unit: "item",
      unitPrice: cents(1000),
      vatRateBps: 0,
      vatTreatment: "domestic_vat",
      netAmount: cents(1000),
      vatAmount: cents(0),
      grossAmount: cents(1000),
      source: INVOICE_LINE_SOURCE.MANUAL,
    },
    {
      id: invoiceLineIds.at(1) ?? panic("Missing invoice line fixture ID"),
      organizationId,
      workspaceId: matterA,
      invoiceId: matterInvoiceId,
      position: 0,
      description: "Time entry line",
      quantity: "1",
      unit: "hour",
      unitPrice: cents(1000),
      vatRateBps: 0,
      vatTreatment: "domestic_vat",
      netAmount: cents(1000),
      vatAmount: cents(0),
      grossAmount: cents(1000),
      source: INVOICE_LINE_SOURCE.TIME_ENTRY,
      timeEntryId: timeEntryIds.at(1) ?? panic("Missing time entry fixture ID"),
    },
    {
      id: invoiceLineIds.at(2) ?? panic("Missing invoice line fixture ID"),
      organizationId,
      workspaceId: matterB,
      invoiceId: secondMatterInvoiceId,
      position: 0,
      description: "Expense line",
      quantity: "1",
      unit: "item",
      unitPrice: cents(3400),
      vatRateBps: 0,
      vatTreatment: "domestic_vat",
      netAmount: cents(3400),
      vatAmount: cents(0),
      grossAmount: cents(3400),
      source: INVOICE_LINE_SOURCE.EXPENSE,
      expenseId: expenseIds.at(1) ?? panic("Missing expense fixture ID"),
    },
  ]);
  await db.insert(invoicePayments).values([
    {
      id: invoicePaymentIds.at(0) ?? panic("Missing payment fixture ID"),
      organizationId,
      invoiceId: orgInvoiceId,
      amount: cents(500),
      paidOn: "2026-10-07",
      method: "bank_transfer",
      origin: INVOICE_PAYMENT_ORIGIN.LEGACY,
      recordedBy: null,
    },
    {
      id: invoicePaymentIds.at(1) ?? panic("Missing payment fixture ID"),
      organizationId,
      invoiceId: matterInvoiceId,
      amount: cents(500),
      paidOn: "2026-10-08",
      method: "card",
      origin: INVOICE_PAYMENT_ORIGIN.LEGACY,
      recordedBy: userId,
    },
  ]);
};

export const seedDataExportCompleteness = async (
  db: TestDatabase,
): Promise<DataExportCompletenessFixture> => {
  const state = createState(db);
  const cleanup = async () => {
    await db
      .delete(organization)
      .where(eq(organization.id, state.organizationId));
    await db.delete(user).where(eq(user.id, state.userId));
  };
  const seeded = await Result.tryPromise({
    try: async () => {
      await seedOrganization(state);
      await seedClausesAndTemplates(state);
      await seedMattersAndDocuments(state);
      await seedBilling(state);
      return {
        db: state.db,
        organizationId: state.organizationId,
        userId: state.userId,
        personalMatterId: state.personalMatterId,
        documentFileBytes: new Map(
          state.fileIds.map((id, index) => [
            id,
            state.fileBytes.at(index) ?? panic("Missing document file bytes"),
          ]),
        ),
        cleanup,
      };
    },
    catch: (error: unknown) => error,
  });
  if (seeded.isErr()) {
    await cleanup();
    throw seeded.error;
  }
  return seeded.value;
};
