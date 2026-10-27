// Which stored columns an export carries, per table, and how a record file
// is serialised.
//
// Every map below is total over its table's columns (`satisfies
// Record<column, disposition>`), so a column added to one of these tables
// cannot compile until someone decides whether it belongs in an export.
// `omit` is reserved for tenancy keys implied by the archive layout, storage
// locations, scanner state, derived search data and feature-gate
// bookkeeping: nothing a person typed or an importer needs.

import { panic } from "better-result";
import type { InferSelectModel, Table } from "drizzle-orm";

import type {
  clauses,
  clauseVariants,
  clauseVersions,
  contactRelationships,
  contacts,
  entities,
  invoiceLines,
  invoices,
  taskAssignees,
  templates,
  templateVersions,
  timeEntries,
  workspaceContacts,
  workspaces,
} from "@/api/db/schema";
import { escapeCSV } from "@/api/lib/csv";

type Disposition = "export" | "omit";

const toJsonValue = (value: unknown): unknown =>
  value instanceof Date ? value.toISOString() : value;

type ColumnMap<T extends Table> = Record<
  keyof InferSelectModel<T>,
  Disposition
>;

export const MATTER_COLUMNS = {
  id: "export",
  organizationId: "omit",
  name: "export",
  reference: "export",
  clientId: "export",
  leadUserId: "export",
  billingReference: "export",
  color: "export",
  status: "export",
  lastActivityAt: "export",
  createdAt: "export",
} as const satisfies ColumnMap<typeof workspaces>;

export const MATTER_CONTACT_COLUMNS = {
  id: "export",
  organizationId: "omit",
  workspaceId: "omit",
  contactId: "export",
  role: "export",
  isPrimary: "export",
  notes: "export",
  createdAt: "export",
} as const satisfies ColumnMap<typeof workspaceContacts>;

const CONTACT_OWNER_COLUMN = {
  originating: "originatingAttorneyId",
  responsible: "responsibleAttorneyId",
} as const;

export const CONTACT_COLUMNS = {
  id: "export",
  organizationId: "omit",
  type: "export",
  prefix: "export",
  firstName: "export",
  middleName: "export",
  lastName: "export",
  suffix: "export",
  dateOfBirthYear: "export",
  dateOfBirthMonth: "export",
  dateOfBirthDay: "export",
  nationalityCodes: "export",
  organizationName: "export",
  sanctionsMonitoringMode: "export",
  displayName: "export",
  notes: "export",
  emails: "export",
  phones: "export",
  addresses: "export",
  tags: "export",
  metadata: "export",
  color: "export",
  registrationNumber: "export",
  taxId: "export",
  vatId: "export",
  vatPayer: "export",
  bankAccounts: "export",
  billingAddress: "export",
  defaultHourlyRate: "export",
  currency: "export",
  paymentTermDays: "export",
  invoiceLanguage: "export",
  // Computed keys: the owner-field lint rule guards writes of these ids, and
  // this map only selects them for reading.
  [CONTACT_OWNER_COLUMN.originating]: "export",
  [CONTACT_OWNER_COLUMN.responsible]: "export",
  createdBy: "export",
  createdAt: "export",
  updatedAt: "export",
} as const satisfies ColumnMap<typeof contacts>;

export const CONTACT_RELATIONSHIP_COLUMNS = {
  id: "export",
  organizationId: "omit",
  personId: "export",
  relatedContactId: "export",
  relationshipType: "export",
  title: "export",
  isPrimary: "export",
  startDate: "export",
  endDate: "export",
  createdAt: "export",
} as const satisfies ColumnMap<typeof contactRelationships>;

export const TASK_COLUMNS = {
  entityFeatureGate: "omit",
  id: "export",
  workspaceId: "omit",
  kind: "omit",
  listItemType: "export",
  parentId: "export",
  name: "export",
  duplicateSourceEntityId: "omit",
  displayName: "export",
  createdBy: "export",
  lastEditedBy: "export",
  currentVersionId: "omit",
  docSequence: "omit",
  status: "export",
  priority: "export",
  dueDate: "export",
  agendaKind: "export",
  startAt: "export",
  endAt: "export",
  occurredAt: "export",
  remindAt: "export",
  allDay: "export",
  timeZone: "export",
  location: "export",
  onlineMeetingUrl: "export",
  availability: "export",
  sensitivity: "export",
  organizer: "export",
  attendees: "export",
  recurrence: "export",
  agendaSource: "export",
  externalSource: "export",
  externalId: "export",
  externalChangeKey: "omit",
  externalICalUid: "export",
  externalData: "omit",
  readOnly: "export",
  sortOrder: "export",
  metadata: "export",
  createdAt: "export",
  updatedAt: "export",
} as const satisfies ColumnMap<typeof entities>;

export const TASK_ASSIGNEE_COLUMNS = {
  entityFeatureGate: "omit",
  entityFeatureWorkspaceIds: "omit",
  id: "omit",
  workspaceId: "omit",
  entityId: "export",
  userId: "export",
  role: "export",
  createdAt: "export",
} as const satisfies ColumnMap<typeof taskAssignees>;

export const TIME_ENTRY_COLUMNS = {
  id: "export",
  organizationId: "omit",
  activityGroup: "export",
  workspaceId: "export",
  userId: "export",
  approverUserId: "export",
  approvedByUserId: "export",
  approvedAt: "export",
  returnedByUserId: "export",
  returnedAt: "export",
  returnComment: "export",
  workItemId: "export",
  dateWorked: "export",
  timezoneId: "export",
  durationMinutes: "export",
  billedMinutes: "export",
  rateAtEntry: "export",
  currency: "export",
  narrative: "export",
  narrativeLanguage: "export",
  invoiceNarrative: "export",
  billable: "export",
  noCharge: "export",
  status: "export",
  source: "export",
  taskCode: "export",
  activityCode: "export",
  invoiceId: "export",
  invoiceAttachment: "export",
  splitGroupId: "export",
  timerStartedAt: "export",
  timerStoppedAt: "export",
  createdAt: "export",
  updatedAt: "export",
} as const satisfies ColumnMap<typeof timeEntries>;

export const INVOICE_COLUMNS = {
  id: "export",
  organizationId: "omit",
  workspaceId: "omit",
  invoiceNumber: "export",
  documentType: "export",
  originalInvoiceId: "export",
  billingMode: "export",
  flatFeeAmount: "export",
  finalizedAt: "export",
  reference: "export",
  status: "export",
  invoiceDate: "export",
  taxableSupplyDate: "export",
  dueDate: "export",
  currency: "export",
  language: "export",
  sellerProfileId: "export",
  buyerName: "export",
  buyerRegistrationId: "export",
  buyerTaxId: "export",
  buyerVatId: "export",
  buyerAddressLine1: "export",
  buyerAddressLine2: "export",
  buyerCity: "export",
  buyerPostalCode: "export",
  buyerCountry: "export",
  netAmount: "export",
  vatAmount: "export",
  vatExchangeRate: "export",
  vatExchangeRateDate: "export",
  vatExchangeRateReference: "export",
  vatExchangeRateSource: "export",
  vatExchangeRateTaxPoint: "export",
  totalAmount: "export",
  notes: "export",
  paidAt: "export",
  createdAt: "export",
  updatedAt: "export",
} as const satisfies ColumnMap<typeof invoices>;

export const INVOICE_LINE_COLUMNS = {
  id: "export",
  organizationId: "omit",
  workspaceId: "omit",
  invoiceId: "export",
  billingPurpose: "export",
  position: "export",
  description: "export",
  quantity: "export",
  unit: "export",
  unitPrice: "export",
  vatRateBps: "export",
  vatTreatment: "export",
  exemptionReason: "export",
  netAmount: "export",
  vatAmount: "export",
  grossAmount: "export",
  source: "export",
  timeEntryId: "export",
  expenseId: "export",
  releasedAt: "export",
  createdAt: "export",
  updatedAt: "export",
} as const satisfies ColumnMap<typeof invoiceLines>;

export const CLAUSE_COLUMNS = {
  id: "export",
  organizationId: "omit",
  categoryId: "export",
  title: "export",
  description: "export",
  usageNotes: "export",
  language: "export",
  body: "export",
  metadata: "export",
  searchVector: "omit",
  currentVersion: "export",
  createdBy: "export",
  createdAt: "export",
  updatedAt: "export",
} as const satisfies ColumnMap<typeof clauses>;

export const CLAUSE_VERSION_COLUMNS = {
  id: "export",
  organizationId: "omit",
  clauseId: "export",
  version: "export",
  body: "export",
  createdAt: "export",
} as const satisfies ColumnMap<typeof clauseVersions>;

export const CLAUSE_VARIANT_COLUMNS = {
  id: "export",
  organizationId: "omit",
  clauseId: "export",
  label: "export",
  body: "export",
  sortOrder: "export",
  createdAt: "export",
  updatedAt: "export",
} as const satisfies ColumnMap<typeof clauseVariants>;

export const TEMPLATE_COLUMNS = {
  id: "export",
  organizationId: "omit",
  categoryId: "export",
  name: "export",
  kind: "export",
  fileName: "export",
  s3Key: "omit",
  scanState: "omit",
  sizeBytes: "export",
  manifest: "export",
  fieldCount: "export",
  currentVersion: "export",
  tags: "export",
  languages: "export",
  whenToUse: "export",
  whenNotToUse: "export",
  useCount: "export",
  lastUsedAt: "export",
  originType: "export",
  origin: "export",
  createdBy: "export",
  createdAt: "export",
  updatedAt: "export",
} as const satisfies ColumnMap<typeof templates>;

export const TEMPLATE_VERSION_COLUMNS = {
  id: "export",
  organizationId: "omit",
  templateId: "export",
  version: "export",
  s3Key: "omit",
  scanState: "omit",
  manifest: "export",
  fieldCount: "export",
  createdBy: "export",
  createdAt: "export",
} as const satisfies ColumnMap<typeof templateVersions>;

/**
 * A stored row reduced to its exported columns, timestamps as ISO 8601
 * UTC, in the map's column order.
 */
export const projectRecord = (
  row: Readonly<Record<string, unknown>>,
  map: Readonly<Record<string, Disposition>>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(map)
      .filter(([, disposition]) => disposition === "export")
      .map(([key]) => [key, toJsonValue(row[key])]),
  );

/** Ordered column names for a CSV header. */
export const exportedColumnNames = (
  map: Record<string, Disposition>,
): string[] =>
  Object.entries(map)
    .filter(([, disposition]) => disposition === "export")
    .map(([key]) => key);

const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return panic("Unsupported CSV cell value");
};

/**
 * CSV for people, not machines: `escapeCSV` neutralises spreadsheet
 * formulas, so a cell beginning with `=` is not byte-identical to the
 * stored value. The JSON file next to it is the canonical copy.
 */
export const toCsv = (
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): string => {
  const lines = [columns.map((column) => escapeCSV(column)).join(",")];
  for (const row of rows) {
    lines.push(
      columns.map((column) => escapeCSV(csvCell(row[column]))).join(","),
    );
  }
  // Excel reads UTF-8 CSV correctly only with a byte order mark.
  return `﻿${lines.join("\r\n")}\r\n`;
};
