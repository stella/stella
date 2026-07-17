import { panic, Result } from "better-result";
import { and, asc, eq, gt, gte, inArray, lte, or } from "drizzle-orm";
import * as v from "valibot";

import { roles } from "@stll/permissions";

import { member, user } from "@/api/db/auth-schema";
import { invoices, timeEntries } from "@/api/db/schema";
import { resolveRate } from "@/api/handlers/rates/resolve";
import { createTimeEntryHandler } from "@/api/handlers/time-entries/create";
import { deleteTimeEntryHandler } from "@/api/handlers/time-entries/delete-by-id";
import { updateTimeEntryHandler } from "@/api/handlers/time-entries/update-by-id";
import { readOrgEntitlementHandler } from "@/api/handlers/usage/get-entitlement";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import {
  brandPersistedEntityId,
  brandPersistedInvoiceId,
  brandPersistedTimeEntryId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { validateOrgUserId } from "@/api/lib/validated-org-user-id";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  defineTextFieldSpec,
  deriveTextFieldPaths,
  runTextFieldSpecs,
} from "@/api/mcp/text-field-spec";
import type {
  McpTextFieldSpec,
  McpToolDefinition,
  McpToolHandler,
} from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import {
  confirmProp,
  DEFAULT_LIST_LIMIT,
  ensureActiveWorkspace,
  ensureWorkspaceAccess,
  enumProp,
  errorResult,
  intProp,
  MAX_LIST_LIMIT,
  notFoundResult,
  nullableStringProp,
  stringProp,
  structuredErrorResult,
  textResult,
  validationErrorResult,
} from "@/api/mcp/tool-utils";

type BillingToolName =
  | "list_time_entries"
  | "save_time_entry"
  | "delete_time_entry"
  | "resolve_rate"
  | "list_invoices"
  | "get_usage";

/** Statuses list_time_entries can filter on (the full time-entry lifecycle). */
const TIME_ENTRY_STATUS_FILTERS = [
  "draft",
  "approved",
  "billed",
  "written_off",
] as const;

/**
 * Statuses save_time_entry can flip an entry to. Mirrors update-by-id.ts, which
 * only accepts draft/approved: billed and written-off are reached through the
 * invoice and delete flows, not a direct status write.
 */
const SAVE_TIME_ENTRY_STATUSES = ["draft", "approved"] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

// --- list_time_entries text-field specs ---------------------------------

/** Shape `list_time_entries` redacts on both the list and detail branch. */
type TimeEntryTextItem = {
  narrative: string;
  invoiceNarrative: string | null;
  userName: string | null;
};

/**
 * The three redactable fields of one time entry, parameterized on the
 * branch's `path` prefix (`"entries[]"` vs `"entry"`), its `items` accessor
 * (a list vs a wrapped singleton), and the branch's single resolved
 * `workspaceId` (P1: the whole list/detail response shares one attribution).
 * Called once at module load (with a placeholder `workspaceId`) to derive the
 * definition's `textFields` doc list, and again per request (with the real
 * `workspaceId`) to build the actual push list.
 */
const timeEntryTextFieldSpecs = <TPayload>({
  items,
  pathPrefix,
  workspaceId,
}: {
  items: (payload: TPayload) => readonly TimeEntryTextItem[];
  pathPrefix: string;
  workspaceId: string;
}): readonly McpTextFieldSpec<TPayload>[] => [
  defineTextFieldSpec({
    path: `${pathPrefix}.narrative`,
    items,
    scope: () => workspaceId,
    read: (item) => item.narrative,
    apply: (item, value) => {
      item.narrative = value;
    },
  }),
  defineTextFieldSpec({
    path: `${pathPrefix}.invoiceNarrative`,
    items,
    scope: () => workspaceId,
    read: (item) => item.invoiceNarrative,
    apply: (item, value) => {
      item.invoiceNarrative = value;
    },
  }),
  defineTextFieldSpec({
    path: `${pathPrefix}.userName`,
    items,
    scope: () => workspaceId,
    read: (item) => item.userName,
    apply: (item, value) => {
      item.userName = value;
    },
  }),
];

const TIME_ENTRY_LIST_TEXT_FIELD_PATHS = deriveTextFieldPaths(
  timeEntryTextFieldSpecs({
    items: (payload: { entries: readonly TimeEntryTextItem[] }) =>
      payload.entries,
    pathPrefix: "entries[]",
    workspaceId: "",
  }),
);

const TIME_ENTRY_DETAIL_TEXT_FIELD_PATHS = deriveTextFieldPaths(
  timeEntryTextFieldSpecs({
    items: (payload: { entry: TimeEntryTextItem }) => [payload.entry],
    pathPrefix: "entry",
    workspaceId: "",
  }),
);

// --- list_invoices text-field specs --------------------------------------

/** Shape `list_invoices`'s list branch redacts: one field, per item. */
type InvoiceReferenceTextItem = { reference: string | null };

const INVOICE_LIST_TEXT_FIELD_PATH = "invoices[].reference";

const invoiceListTextFieldSpecs = (
  workspaceId: string,
): readonly McpTextFieldSpec<{
  invoices: readonly InvoiceReferenceTextItem[];
}>[] => [
  defineTextFieldSpec({
    path: INVOICE_LIST_TEXT_FIELD_PATH,
    items: (payload) => payload.invoices,
    scope: () => workspaceId,
    read: (item) => item.reference,
    apply: (item, value) => {
      item.reference = value;
    },
  }),
];

type InvoiceTimeEntryTextItem = {
  narrative: string;
  invoiceNarrative: string | null;
  entity: { name: string };
};

type InvoiceExpenseTextItem = {
  description: string;
  invoiceDescription: string | null;
  entity: { name: string };
};

/** Full shape `list_invoices`'s detail branch redacts, one invoice deep. */
type InvoiceDetailTextPayload = {
  invoice: {
    reference: string | null;
    notes: string | null;
    timeEntries: readonly InvoiceTimeEntryTextItem[];
    expenses: readonly InvoiceExpenseTextItem[];
  };
};

/**
 * Every redactable field on one invoice detail response: the invoice's own
 * reference/notes (P1: constant `workspaceId`, single item), plus its nested
 * time-entry and expense line items (each with its own narrative/description
 * pair and the linked entity's name).
 */
const invoiceDetailTextFieldSpecs = (
  workspaceId: string,
): readonly McpTextFieldSpec<InvoiceDetailTextPayload>[] => [
  defineTextFieldSpec({
    path: "invoice.reference",
    items: (payload) => [payload.invoice],
    scope: () => workspaceId,
    read: (item) => item.reference,
    apply: (item, value) => {
      item.reference = value;
    },
  }),
  defineTextFieldSpec({
    path: "invoice.notes",
    items: (payload) => [payload.invoice],
    scope: () => workspaceId,
    read: (item) => item.notes,
    apply: (item, value) => {
      item.notes = value;
    },
  }),
  defineTextFieldSpec({
    path: "invoice.timeEntries[].narrative",
    items: (payload) => payload.invoice.timeEntries,
    scope: () => workspaceId,
    read: (item) => item.narrative,
    apply: (item, value) => {
      item.narrative = value;
    },
  }),
  defineTextFieldSpec({
    path: "invoice.timeEntries[].invoiceNarrative",
    items: (payload) => payload.invoice.timeEntries,
    scope: () => workspaceId,
    read: (item) => item.invoiceNarrative,
    apply: (item, value) => {
      item.invoiceNarrative = value;
    },
  }),
  defineTextFieldSpec({
    path: "invoice.timeEntries[].entity.name",
    items: (payload) => payload.invoice.timeEntries,
    scope: () => workspaceId,
    read: (item) => item.entity.name,
    apply: (item, value) => {
      item.entity.name = value;
    },
  }),
  defineTextFieldSpec({
    path: "invoice.expenses[].description",
    items: (payload) => payload.invoice.expenses,
    scope: () => workspaceId,
    read: (item) => item.description,
    apply: (item, value) => {
      item.description = value;
    },
  }),
  defineTextFieldSpec({
    path: "invoice.expenses[].invoiceDescription",
    items: (payload) => payload.invoice.expenses,
    scope: () => workspaceId,
    read: (item) => item.invoiceDescription,
    apply: (item, value) => {
      item.invoiceDescription = value;
    },
  }),
  defineTextFieldSpec({
    path: "invoice.expenses[].entity.name",
    items: (payload) => payload.invoice.expenses,
    scope: () => workspaceId,
    read: (item) => item.entity.name,
    apply: (item, value) => {
      item.entity.name = value;
    },
  }),
];

const INVOICE_DETAIL_TEXT_FIELD_PATHS = deriveTextFieldPaths(
  invoiceDetailTextFieldSpecs(""),
);

export const BILLING_TOOL_DEFINITIONS = [
  {
    annotations: { readOnlyHint: true },
    description:
      "List time entries in a matter, or read one entry in detail. Pass " +
      "time_entry_id to get a single entry. Otherwise pass matter_id to list " +
      "the matter's entries, optionally filtered by entity_id (the item the " +
      "time was logged against), user_id, a date-worked range (date_from/" +
      "date_to, ISO YYYY-MM-DD), and status. Returns each entry's id, entity, " +
      "user, date, minutes, rate (minor currency units), currency, narrative, " +
      "and status.",
    inputSchema: {
      type: "object",
      properties: {
        matter_id: stringProp(
          "Matter/workspace ID to list time entries in; required unless " +
            "time_entry_id is given",
        ),
        time_entry_id: stringProp("Time entry ID to read in detail"),
        entity_id: stringProp(
          "List only entries logged against this entity (document, folder, or " +
            "task the time is billed to)",
        ),
        user_id: stringProp("List only entries recorded by this user"),
        date_from: stringProp(
          "List only entries worked on or after this ISO date (YYYY-MM-DD)",
          { maxLength: 10 },
        ),
        date_to: stringProp(
          "List only entries worked on or before this ISO date (YYYY-MM-DD)",
          { maxLength: 10 },
        ),
        status: enumProp(
          "List only entries with this status",
          TIME_ENTRY_STATUS_FILTERS,
        ),
        limit: intProp("Max entries to return", {
          min: 1,
          max: MAX_LIST_LIMIT,
        }),
        cursor: stringProp(
          "Opaque cursor from a previous list_time_entries call to fetch the next page",
          { maxLength: 512 },
        ),
      },
    },
    access: "read",
    anonymized: {
      exposure: "anonymize",
      textFields: [
        ...TIME_ENTRY_LIST_TEXT_FIELD_PATHS,
        ...TIME_ENTRY_DETAIL_TEXT_FIELD_PATHS,
      ],
    },
    feature: "FEATURE_TIME_BILLING",
    name: "list_time_entries",
    scope: "stella:read",
  },
  {
    description:
      "Create or update a time entry. Omit time_entry_id to create (matter_id, " +
      "entity_id, date_worked, timezone_id, duration_minutes, rate_at_entry, " +
      "currency, and narrative all required). Pass time_entry_id to update: " +
      "set date_worked, duration_minutes, narrative, invoice_narrative, " +
      "billable, no_charge, entity_id (move the entry), task_code, " +
      "activity_code, rate_at_entry, currency, and/or status (draft or " +
      "approved). Rates and amounts are integer minor currency units (e.g. " +
      "cents); durations are whole minutes. Returns the time entry ID.",
    inputSchema: {
      type: "object",
      properties: {
        time_entry_id: stringProp("Time entry ID to update; omit to create"),
        matter_id: stringProp(
          "Matter/workspace ID to create the entry in; required when creating",
        ),
        entity_id: stringProp(
          "Entity the time is logged against (document, folder, or task). " +
            "Required when creating; when updating, moves the entry to a " +
            "different entity in the same matter.",
        ),
        date_worked: stringProp(
          "Date the work was done (ISO YYYY-MM-DD); required when creating",
          { maxLength: 10 },
        ),
        timezone_id: stringProp(
          "IANA time zone the date_worked is interpreted in (e.g. " +
            "Europe/Prague); required when creating",
          { maxLength: 64 },
        ),
        duration_minutes: intProp(
          "Minutes worked (whole minutes); required when creating",
          { min: 1 },
        ),
        rate_at_entry: intProp(
          "Hourly rate in integer minor currency units (e.g. cents); required " +
            "when creating",
          { min: 0 },
        ),
        currency: stringProp(
          "3-letter ISO currency code; required when creating",
          { maxLength: 3 },
        ),
        narrative: stringProp(
          "Description of the work; required when creating",
          { maxLength: 10_000 },
        ),
        invoice_narrative: nullableStringProp(
          "Client-facing narrative shown on the invoice; pass null to clear. " +
            "Only valid when updating.",
          { maxLength: 10_000 },
        ),
        billable: {
          type: "boolean",
          description: "Whether the entry is billable to the client",
        },
        no_charge: {
          type: "boolean",
          description:
            "Whether the entry is recorded but not charged. Only valid when updating.",
        },
        task_code: nullableStringProp(
          "UTBMS/LEDES task code; pass null to clear",
          { maxLength: 20 },
        ),
        activity_code: nullableStringProp(
          "UTBMS/LEDES activity code; pass null to clear",
          { maxLength: 20 },
        ),
        status: enumProp(
          "Set the entry's status. Only valid when updating.",
          SAVE_TIME_ENTRY_STATUSES,
        ),
      },
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    feature: "FEATURE_TIME_BILLING",
    name: "save_time_entry",
    scope: "stella:billing_write",
  },
  {
    annotations: { destructiveHint: true },
    description:
      "Delete a time entry. A draft entry is permanently deleted; an approved " +
      "entry is written off instead (kept for the audit trail, excluded from " +
      "billing). A billed entry cannot be deleted until its invoice is " +
      "reverted. Returns whether the entry was hard-deleted.",
    inputSchema: {
      type: "object",
      properties: {
        time_entry_id: stringProp("Time entry ID to delete or write off"),
        confirm: confirmProp(),
      },
      required: ["time_entry_id"],
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    feature: "FEATURE_TIME_BILLING",
    name: "delete_time_entry",
    scope: "stella:billing_write",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Resolve the effective hourly rate for a user on a given date in a " +
      "matter, using the matter's default rate table (user-specific rate " +
      "first, then the table default). Returns the hourly rate in integer " +
      "minor currency units (e.g. cents) and the currency, or nulls when no " +
      "rate applies.",
    inputSchema: {
      type: "object",
      properties: {
        matter_id: stringProp("Matter/workspace ID to resolve the rate in"),
        user_id: stringProp("User ID to resolve the rate for"),
        date: stringProp("Date to resolve the rate on (ISO YYYY-MM-DD)", {
          maxLength: 10,
        }),
      },
      required: ["matter_id", "user_id", "date"],
    },
    access: "read",
    anonymized: { exposure: "passthrough" },
    feature: "FEATURE_TIME_BILLING",
    name: "resolve_rate",
    scope: "stella:read",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "List invoices in a matter, or read one invoice in detail. Pass " +
      "invoice_id to get a single invoice with its line items (time entries " +
      "and expenses). Otherwise pass matter_id to list the matter's invoices. " +
      "Returns each invoice's id, number, reference, status, dates, currency, " +
      "and total (integer minor currency units).",
    inputSchema: {
      type: "object",
      properties: {
        matter_id: stringProp(
          "Matter/workspace ID to list invoices in; required unless " +
            "invoice_id is given",
        ),
        invoice_id: stringProp("Invoice ID to read in detail"),
        limit: intProp("Max invoices to return", {
          min: 1,
          max: MAX_LIST_LIMIT,
        }),
        cursor: stringProp(
          "Opaque cursor from a previous list_invoices call to fetch the next page",
          { maxLength: 512 },
        ),
      },
    },
    access: "read",
    anonymized: {
      exposure: "anonymize",
      textFields: [
        INVOICE_LIST_TEXT_FIELD_PATH,
        ...INVOICE_DETAIL_TEXT_FIELD_PATHS,
      ],
    },
    feature: "FEATURE_TIME_BILLING",
    name: "list_invoices",
    scope: "stella:read",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Read the organization's current usage entitlement: plan, seats, billing " +
      "period, and how many usage units (AI credits) remain this period. " +
      "Returns { entitlement: null } when the organization has no active plan. " +
      "Requires organization-settings management access.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    access: "read",
    anonymized: { exposure: "passthrough" },
    feature: "FEATURE_USAGE",
    name: "get_usage",
    scope: "stella:read",
  },
] as const satisfies readonly McpToolDefinition[];

/**
 * Wrap the request-scoped recorder so audit rows written by the reused backing
 * handlers carry the resolved workspace. The MCP recorder binds workspaceId to
 * null (org-scoped); workspace-scoped handlers build events without a
 * workspaceId, so inject it per event (an event that sets its own wins).
 */
const bindWorkspaceRecorder =
  (
    context: McpRequestContext,
    workspaceId: SafeId<"workspace">,
  ): AuditRecorder =>
  async (tx, event) => {
    const events: AuditEvent[] = Array.isArray(event) ? event : [event];
    for (const e of events) {
      if (e.workspaceId === undefined) {
        e.workspaceId = workspaceId;
      }
    }
    await context.recordAuditEvent(tx, events);
  };

/**
 * Prefer a cross-field (`partial_check`) validation message when present,
 * falling back to the hand-written shape hint for structural failures.
 */
const crossFieldOrGeneric = (
  issues: readonly v.BaseIssue<unknown>[],
  genericMessage: string,
): string =>
  issues.find((issue) => issue.type === "partial_check")?.message ??
  genericMessage;

/** Resolve the accessible workspace that owns a time entry, or null. */
const resolveTimeEntryWorkspace = async ({
  context,
  timeEntryId,
}: {
  context: McpRequestContext;
  timeEntryId: SafeId<"timeEntry">;
}): Promise<SafeId<"workspace"> | null> => {
  if (context.accessibleWorkspaceIds.length === 0) {
    return null;
  }
  const row = await context.scopedDb((tx) =>
    tx.query.timeEntries.findFirst({
      where: {
        id: { eq: timeEntryId },
        workspaceId: { in: context.accessibleWorkspaceIds },
      },
      columns: { workspaceId: true },
    }),
  );
  return row?.workspaceId ?? null;
};

/** Resolve the accessible workspace that owns an invoice, or null. */
const resolveInvoiceWorkspace = async ({
  context,
  invoiceId,
}: {
  context: McpRequestContext;
  invoiceId: SafeId<"invoice">;
}): Promise<SafeId<"workspace"> | null> => {
  if (context.accessibleWorkspaceIds.length === 0) {
    return null;
  }
  const row = await context.scopedDb((tx) =>
    tx.query.invoices.findFirst({
      where: {
        id: { eq: invoiceId },
        workspaceId: { in: context.accessibleWorkspaceIds },
      },
      columns: { workspaceId: true },
    }),
  );
  return row?.workspaceId ?? null;
};

/**
 * Look up display names for a set of user IDs, org-scoped. Runs as its own
 * scopedDb call so it never shares a pooled connection with the entry query.
 */
const loadUserNames = async ({
  context,
  userIds,
}: {
  context: McpRequestContext;
  userIds: readonly string[];
}): Promise<Map<string, string>> => {
  if (userIds.length === 0) {
    return new Map();
  }
  const rows = await context.scopedDb((tx) =>
    tx
      .select({ id: user.id, name: user.name })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(
        and(
          eq(member.organizationId, context.organizationId),
          inArray(member.userId, [...userIds]),
        ),
      ),
  );
  return new Map(rows.map((row) => [row.id, row.name]));
};

// --- list_time_entries --------------------------------------------------

const listTimeEntriesArgsSchema = v.pipe(
  v.strictObject({
    matter_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    time_entry_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    entity_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    user_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    date_from: v.optional(v.pipe(v.string(), v.regex(ISO_DATE))),
    date_to: v.optional(v.pipe(v.string(), v.regex(ISO_DATE))),
    status: v.optional(v.picklist(TIME_ENTRY_STATUS_FILTERS)),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(MAX_LIST_LIMIT),
      ),
    ),
    cursor: v.optional(v.pipe(v.string(), v.maxLength(512))),
  }),
  // List mode needs a matter to scope to; detail mode uses time_entry_id alone.
  v.forward(
    v.partialCheck(
      [["matter_id"], ["time_entry_id"]],
      ({ matter_id, time_entry_id }) =>
        time_entry_id !== undefined || matter_id !== undefined,
      "Provide matter_id to list entries, or time_entry_id to read one entry",
    ),
    ["matter_id"],
  ),
);

/** Columns list_time_entries surfaces, shared by the list and detail branches. */
const timeEntryColumns = {
  id: timeEntries.id,
  entityId: timeEntries.matterId,
  userId: timeEntries.userId,
  dateWorked: timeEntries.dateWorked,
  durationMinutes: timeEntries.durationMinutes,
  billedMinutes: timeEntries.billedMinutes,
  rateAtEntry: timeEntries.rateAtEntry,
  currency: timeEntries.currency,
  narrative: timeEntries.narrative,
  invoiceNarrative: timeEntries.invoiceNarrative,
  billable: timeEntries.billable,
  noCharge: timeEntries.noCharge,
  status: timeEntries.status,
};

const decodeTimeEntryPageCursor = (
  cursor: string,
): { dateWorked: string; id: SafeId<"timeEntry"> } | null => {
  const parts = decodePaginationCursor(cursor);
  const dateWorked = parts?.at(0);
  const id = parts?.at(1);
  if (
    !isDateOnlyPaginationCursorPart(dateWorked) ||
    !isUuidPaginationCursorPart(id)
  ) {
    return null;
  }
  return { dateWorked, id: brandPersistedTimeEntryId(id) };
};

const handleListTimeEntriesTool: McpToolHandler = async ({ args, context }) => {
  if (!roles[context.memberRole].authorize({ workspace: ["read"] }).success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(listTimeEntriesArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult({
      issues: parsed.issues,
      message: crossFieldOrGeneric(
        parsed.issues,
        "Invalid input: expected { matter_id?: string, time_entry_id?: string, entity_id?: string, user_id?: string, date_from?: YYYY-MM-DD, date_to?: YYYY-MM-DD, status?: string, limit?: integer, cursor?: string }",
      ),
    });
  }
  const input = parsed.output;

  // Detail mode.
  if (input.time_entry_id !== undefined) {
    const timeEntryId = brandPersistedTimeEntryId(input.time_entry_id);
    const workspaceId = await resolveTimeEntryWorkspace({
      context,
      timeEntryId,
    });
    if (!workspaceId) {
      return notFoundResult("Time entry not found or not accessible");
    }
    // A supplied matter_id must name the entry's own matter; otherwise an entry
    // from a different accessible matter would be returned.
    if (input.matter_id !== undefined && input.matter_id !== workspaceId) {
      return errorResult("time_entry_id does not belong to matter_id");
    }
    const row = await context.scopedDb((tx) =>
      tx
        .select(timeEntryColumns)
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.id, timeEntryId),
            eq(timeEntries.workspaceId, workspaceId),
          ),
        )
        .limit(1),
    );
    const entryRow = row.at(0);
    if (!entryRow) {
      return notFoundResult("Time entry not found or not accessible");
    }
    const userNames = await loadUserNames({
      context,
      userIds: entryRow.userId ? [entryRow.userId] : [],
    });
    const entry = {
      ...entryRow,
      // Detail mode may be reached by time_entry_id alone (no matter_id), so
      // carry the resolved owning workspace on the row itself; the chat
      // ref-mediation layer reads it to mint the entity's ref instead of
      // relying on an input arg that can be absent.
      workspaceId,
      userName: entryRow.userId
        ? (userNames.get(entryRow.userId) ?? null)
        : null,
    };

    const textFields = runTextFieldSpecs(
      timeEntryTextFieldSpecs({
        items: (payload: { entry: TimeEntryTextItem }) => [payload.entry],
        pathPrefix: "entry",
        workspaceId,
      }),
      { entry },
    );
    return { egress: "structured", payload: { entry }, textFields };
  }

  // List mode. matter_id is guaranteed present by the schema.
  const matterId = input.matter_id ?? "";
  const workspaceId = ensureWorkspaceAccess({ context, workspaceId: matterId });
  if (!workspaceId) {
    return notFoundResult("Matter not found or not accessible");
  }

  let boundary: { dateWorked: string; id: SafeId<"timeEntry"> } | null = null;
  if (input.cursor !== undefined) {
    boundary = decodeTimeEntryPageCursor(input.cursor);
    if (boundary === null) {
      return structuredErrorResult({
        code: "validation_error",
        message: "Invalid cursor",
        issues: [{ path: "cursor", message: "Invalid cursor" }],
        hint: "Pass the 'cursor' verbatim as returned by a previous call, or omit it for the first page.",
      });
    }
  }
  const limit = input.limit ?? DEFAULT_LIST_LIMIT;

  const rows = await context.scopedDb((tx) =>
    tx
      .select(timeEntryColumns)
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.workspaceId, workspaceId),
          input.entity_id === undefined
            ? undefined
            : eq(timeEntries.matterId, brandPersistedEntityId(input.entity_id)),
          input.user_id === undefined
            ? undefined
            : eq(timeEntries.userId, brandPersistedUserId(input.user_id)),
          input.date_from === undefined
            ? undefined
            : gte(timeEntries.dateWorked, input.date_from),
          input.date_to === undefined
            ? undefined
            : lte(timeEntries.dateWorked, input.date_to),
          input.status === undefined
            ? undefined
            : eq(timeEntries.status, input.status),
          boundary === null
            ? undefined
            : or(
                gt(timeEntries.dateWorked, boundary.dateWorked),
                and(
                  eq(timeEntries.dateWorked, boundary.dateWorked),
                  gt(timeEntries.id, boundary.id),
                ),
              ),
        ),
      )
      .orderBy(asc(timeEntries.dateWorked), asc(timeEntries.id))
      .limit(limit + 1),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) => encodePaginationCursor([item.dateWorked, item.id]),
  });

  const userIds = new Set<string>();
  for (const row of page.items) {
    if (row.userId) {
      userIds.add(row.userId);
    }
  }
  const userNames = await loadUserNames({ context, userIds: [...userIds] });

  const entries = page.items.map((row) => ({
    ...row,
    userName: row.userId ? (userNames.get(row.userId) ?? null) : null,
  }));

  const textFields = runTextFieldSpecs(
    timeEntryTextFieldSpecs({
      items: (payload: { entries: readonly TimeEntryTextItem[] }) =>
        payload.entries,
      pathPrefix: "entries[]",
      workspaceId,
    }),
    { entries },
  );

  return {
    egress: "structured",
    payload: { entries, nextCursor: page.nextCursor },
    textFields,
  };
};

// --- save_time_entry ----------------------------------------------------

const saveTimeEntryArgsSchema = v.pipe(
  v.strictObject({
    time_entry_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    matter_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    entity_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    date_worked: v.optional(v.pipe(v.string(), v.regex(ISO_DATE))),
    timezone_id: v.optional(
      v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
    ),
    duration_minutes: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(1)),
    ),
    rate_at_entry: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    currency: v.optional(v.pipe(v.string(), v.length(3))),
    narrative: v.optional(
      v.pipe(v.string(), v.minLength(1), v.maxLength(10_000)),
    ),
    invoice_narrative: v.optional(
      v.nullable(v.pipe(v.string(), v.maxLength(10_000))),
    ),
    billable: v.optional(v.boolean()),
    no_charge: v.optional(v.boolean()),
    task_code: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(20)))),
    activity_code: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(20)))),
    status: v.optional(v.picklist(SAVE_TIME_ENTRY_STATUSES)),
  }),
  // Creating (no time_entry_id) requires the full set the backing create schema
  // demands; list them in one message so a partial create is rejected up front.
  v.partialCheck(
    [
      ["time_entry_id"],
      ["matter_id"],
      ["entity_id"],
      ["date_worked"],
      ["timezone_id"],
      ["duration_minutes"],
      ["rate_at_entry"],
      ["currency"],
      ["narrative"],
    ],
    (i) =>
      i.time_entry_id !== undefined ||
      (i.matter_id !== undefined &&
        i.entity_id !== undefined &&
        i.date_worked !== undefined &&
        i.timezone_id !== undefined &&
        i.duration_minutes !== undefined &&
        i.rate_at_entry !== undefined &&
        i.currency !== undefined &&
        i.narrative !== undefined),
    "Creating a time entry requires matter_id, entity_id, date_worked, timezone_id, duration_minutes, rate_at_entry, currency, and narrative",
  ),
  // matter_id names the workspace to create in; it cannot change on update.
  v.forward(
    v.partialCheck(
      [["time_entry_id"], ["matter_id"]],
      ({ time_entry_id, matter_id }) =>
        time_entry_id === undefined || matter_id === undefined,
      "matter_id applies only when creating; omit it when updating a time entry",
    ),
    ["matter_id"],
  ),
  // invoice_narrative, no_charge, and status are update-only in the backing
  // handler, so reject them on a create.
  v.partialCheck(
    [["time_entry_id"], ["invoice_narrative"], ["no_charge"], ["status"]],
    ({ time_entry_id, invoice_narrative, no_charge, status }) =>
      time_entry_id !== undefined ||
      (invoice_narrative === undefined &&
        no_charge === undefined &&
        status === undefined),
    "invoice_narrative, no_charge, and status apply to an existing time entry; pass time_entry_id",
  ),
  // An update must request at least one change.
  v.partialCheck(
    [
      ["time_entry_id"],
      ["entity_id"],
      ["date_worked"],
      ["duration_minutes"],
      ["narrative"],
      ["invoice_narrative"],
      ["billable"],
      ["no_charge"],
      ["task_code"],
      ["activity_code"],
      ["status"],
      ["rate_at_entry"],
      ["currency"],
    ],
    (i) =>
      i.time_entry_id === undefined ||
      i.entity_id !== undefined ||
      i.date_worked !== undefined ||
      i.duration_minutes !== undefined ||
      i.narrative !== undefined ||
      i.invoice_narrative !== undefined ||
      i.billable !== undefined ||
      i.no_charge !== undefined ||
      i.task_code !== undefined ||
      i.activity_code !== undefined ||
      i.status !== undefined ||
      i.rate_at_entry !== undefined ||
      i.currency !== undefined,
    "Provide at least one change to the time entry",
  ),
);

const handleSaveTimeEntryTool: McpToolHandler = async ({ args, context }) => {
  const parsed = v.safeParse(saveTimeEntryArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult({
      issues: parsed.issues,
      message: crossFieldOrGeneric(
        parsed.issues,
        "Invalid input: expected { time_entry_id?, matter_id?, entity_id?, date_worked?, timezone_id?, duration_minutes?, rate_at_entry?, currency?, narrative?, invoice_narrative?, billable?, no_charge?, task_code?, activity_code?, status? }",
      ),
    });
  }
  const input = parsed.output;

  // Create branch.
  if (input.time_entry_id === undefined) {
    if (
      !roles[context.memberRole].authorize({ timeEntry: ["create"] }).success
    ) {
      return errorResult("Forbidden");
    }
    const workspaceId = ensureActiveWorkspace({
      context,
      workspaceId: input.matter_id ?? "",
    });
    if (typeof workspaceId !== "string") {
      return workspaceId;
    }
    // Entity existence, future/too-old date, and per-workspace limit are
    // validated atomically inside createTimeEntryHandler, which also emits the
    // create audit event.
    const created = await Result.gen(() =>
      createTimeEntryHandler({
        safeDb: context.safeDb,
        organizationId: context.organizationId,
        workspaceId,
        userId: context.userId,
        recordAuditEvent: bindWorkspaceRecorder(context, workspaceId),
        body: {
          matterId: brandPersistedEntityId(input.entity_id ?? ""),
          dateWorked: input.date_worked ?? "",
          timezoneId: input.timezone_id ?? "",
          durationMinutes: input.duration_minutes ?? 0,
          rateAtEntry: input.rate_at_entry ?? 0,
          currency: input.currency ?? "",
          narrative: input.narrative ?? "",
          ...(input.billable === undefined ? {} : { billable: input.billable }),
          ...(input.task_code === undefined
            ? {}
            : { taskCode: input.task_code }),
          ...(input.activity_code === undefined
            ? {}
            : { activityCode: input.activity_code }),
        },
      }),
    );
    if (Result.isError(created)) {
      return errorResult(created.error.message);
    }
    return textResult({ timeEntryId: created.value.id });
  }

  // Update branch.
  if (!roles[context.memberRole].authorize({ timeEntry: ["update"] }).success) {
    return errorResult("Forbidden");
  }
  const timeEntryId = brandPersistedTimeEntryId(input.time_entry_id);
  const workspaceId = await resolveTimeEntryWorkspace({ context, timeEntryId });
  if (!workspaceId) {
    return notFoundResult("Time entry not found or not accessible");
  }
  // Editing an entry in an archived matter is a write, rejected the same way
  // the HTTP time-entry routes behind the active-only workspace group are.
  const active = ensureActiveWorkspace({ context, workspaceId });
  if (typeof active !== "string") {
    return active;
  }
  // The billed/written-off guard and the target-matter existence check both run
  // atomically inside updateTimeEntryHandler, which emits the update audit diff.
  const updated = await Result.gen(() =>
    updateTimeEntryHandler({
      safeDb: context.safeDb,
      workspaceId,
      recordAuditEvent: bindWorkspaceRecorder(context, workspaceId),
      body: {
        id: timeEntryId,
        ...(input.date_worked === undefined
          ? {}
          : { dateWorked: input.date_worked }),
        ...(input.duration_minutes === undefined
          ? {}
          : { durationMinutes: input.duration_minutes }),
        ...(input.narrative === undefined
          ? {}
          : { narrative: input.narrative }),
        ...(input.invoice_narrative === undefined
          ? {}
          : { invoiceNarrative: input.invoice_narrative }),
        ...(input.billable === undefined ? {} : { billable: input.billable }),
        ...(input.no_charge === undefined ? {} : { noCharge: input.no_charge }),
        ...(input.entity_id === undefined
          ? {}
          : { matterId: brandPersistedEntityId(input.entity_id) }),
        ...(input.task_code === undefined ? {} : { taskCode: input.task_code }),
        ...(input.activity_code === undefined
          ? {}
          : { activityCode: input.activity_code }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.rate_at_entry === undefined
          ? {}
          : { rateAtEntry: input.rate_at_entry }),
        ...(input.currency === undefined ? {} : { currency: input.currency }),
      },
    }),
  );
  if (Result.isError(updated)) {
    return errorResult(updated.error.message);
  }
  return textResult({ timeEntryId, updated: true });
};

// --- delete_time_entry --------------------------------------------------

const deleteTimeEntryArgsSchema = v.strictObject({
  time_entry_id: v.pipe(v.string(), v.minLength(1)),
  confirm: v.optional(v.boolean()),
});

const handleDeleteTimeEntryTool: McpToolHandler = async ({ args, context }) => {
  if (!roles[context.memberRole].authorize({ timeEntry: ["delete"] }).success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(deleteTimeEntryArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult({
      issues: parsed.issues,
      message: "Invalid input: expected { time_entry_id: string }",
    });
  }

  const timeEntryId = brandPersistedTimeEntryId(parsed.output.time_entry_id);
  const workspaceId = await resolveTimeEntryWorkspace({ context, timeEntryId });
  if (!workspaceId) {
    return notFoundResult("Time entry not found or not accessible");
  }
  const active = ensureActiveWorkspace({ context, workspaceId });
  if (typeof active !== "string") {
    return active;
  }

  const deleted = await Result.gen(() =>
    deleteTimeEntryHandler({
      safeDb: context.safeDb,
      workspaceId,
      recordAuditEvent: bindWorkspaceRecorder(context, workspaceId),
      body: { id: timeEntryId },
    }),
  );
  if (Result.isError(deleted)) {
    return errorResult(deleted.error.message);
  }
  return textResult({ deleted: deleted.value.deleted });
};

// --- resolve_rate -------------------------------------------------------

const resolveRateArgsSchema = v.strictObject({
  matter_id: v.pipe(v.string(), v.minLength(1)),
  user_id: v.pipe(v.string(), v.minLength(1)),
  date: v.pipe(v.string(), v.regex(ISO_DATE)),
});

const handleResolveRateTool: McpToolHandler = async ({ args, context }) => {
  if (!roles[context.memberRole].authorize({ workspace: ["read"] }).success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(resolveRateArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult({
      issues: parsed.issues,
      message:
        "Invalid input: expected { matter_id: string, user_id: string, date: YYYY-MM-DD }",
    });
  }

  const workspaceId = ensureWorkspaceAccess({
    context,
    workspaceId: parsed.output.matter_id,
  });
  if (!workspaceId) {
    return notFoundResult("Matter not found or not accessible");
  }

  const validated = await context.safeDb(
    async (tx) =>
      await validateOrgUserId(
        tx,
        brandPersistedUserId(parsed.output.user_id),
        context.organizationId,
      ),
  );
  if (Result.isError(validated)) {
    return errorResult(validated.error.message);
  }
  if (!validated.value) {
    return errorResult("user_id is not a member of this organization");
  }
  const validatedUserId = validated.value;

  const resolved = await Result.gen(async function* () {
    const rate = yield* resolveRate({
      safeDb: context.safeDb,
      workspaceId,
      userId: validatedUserId,
      dateWorked: parsed.output.date,
    });
    return Result.ok(rate);
  });
  if (Result.isError(resolved)) {
    return errorResult(resolved.error.message);
  }

  // Passthrough: only a rate amount (minor units) and currency code, no
  // tenant-authored text.
  return textResult(resolved.value ?? { hourlyRate: null, currency: null });
};

// --- list_invoices ------------------------------------------------------

const listInvoicesArgsSchema = v.pipe(
  v.strictObject({
    matter_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    invoice_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(MAX_LIST_LIMIT),
      ),
    ),
    cursor: v.optional(v.pipe(v.string(), v.maxLength(512))),
  }),
  v.forward(
    v.partialCheck(
      [["matter_id"], ["invoice_id"]],
      ({ matter_id, invoice_id }) =>
        invoice_id !== undefined || matter_id !== undefined,
      "Provide matter_id to list invoices, or invoice_id to read one invoice",
    ),
    ["matter_id"],
  ),
);

const invoicePageCursor = createTimestampIdCursorCodec({
  column: invoices.createdAt,
  brandId: brandPersistedInvoiceId,
});

const readInvoiceDetail = async ({
  context,
  invoiceId,
  workspaceId,
}: {
  context: McpRequestContext;
  invoiceId: SafeId<"invoice">;
  workspaceId: SafeId<"workspace">;
}) =>
  await context.scopedDb((tx) =>
    tx.query.invoices.findFirst({
      where: { id: { eq: invoiceId }, workspaceId: { eq: workspaceId } },
      with: {
        timeEntries: {
          columns: {
            id: true,
            matterId: true,
            dateWorked: true,
            billedMinutes: true,
            rateAtEntry: true,
            currency: true,
            narrative: true,
            invoiceNarrative: true,
            status: true,
          },
          with: { matter: { columns: { id: true, name: true } } },
        },
        expenses: {
          columns: {
            id: true,
            matterId: true,
            dateIncurred: true,
            amount: true,
            currency: true,
            category: true,
            description: true,
            invoiceDescription: true,
            billable: true,
            markup: true,
          },
          with: { matter: { columns: { id: true, name: true } } },
        },
      },
    }),
  );

const handleListInvoicesTool: McpToolHandler = async ({ args, context }) => {
  if (!roles[context.memberRole].authorize({ workspace: ["read"] }).success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(listInvoicesArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult({
      issues: parsed.issues,
      message: crossFieldOrGeneric(
        parsed.issues,
        "Invalid input: expected { matter_id?: string, invoice_id?: string, limit?: integer, cursor?: string }",
      ),
    });
  }
  const input = parsed.output;

  // Detail mode.
  if (input.invoice_id !== undefined) {
    const invoiceId = brandPersistedInvoiceId(input.invoice_id);
    const workspaceId = await resolveInvoiceWorkspace({ context, invoiceId });
    if (!workspaceId) {
      return notFoundResult("Invoice not found or not accessible");
    }
    if (input.matter_id !== undefined && input.matter_id !== workspaceId) {
      return errorResult("invoice_id does not belong to matter_id");
    }
    const invoiceRow = await readInvoiceDetail({
      context,
      invoiceId,
      workspaceId,
    });
    if (!invoiceRow) {
      return notFoundResult("Invoice not found or not accessible");
    }

    const invoice = {
      id: invoiceRow.id,
      // Detail mode may be reached by invoice_id alone (no matter_id), so carry
      // the resolved owning workspace on the invoice; the chat ref-mediation
      // layer reads it to mint the line items' entity refs.
      workspaceId,
      invoiceNumber: invoiceRow.invoiceNumber,
      reference: invoiceRow.reference,
      status: invoiceRow.status,
      invoiceDate: invoiceRow.invoiceDate,
      dueDate: invoiceRow.dueDate,
      currency: invoiceRow.currency,
      totalAmount: invoiceRow.totalAmount,
      notes: invoiceRow.notes,
      paidAt: invoiceRow.paidAt?.toISOString() ?? null,
      createdAt: invoiceRow.createdAt.toISOString(),
      updatedAt: invoiceRow.updatedAt.toISOString(),
      timeEntries: invoiceRow.timeEntries.map((te) => {
        // matterId is a non-null FK (onDelete restrict), so the entity always
        // exists — a missing relation is a broken invariant, not a data case.
        const entity =
          te.matter ?? panic("Invoiced time entry has no matter entity");
        return {
          id: te.id,
          entityId: te.matterId,
          dateWorked: te.dateWorked,
          billedMinutes: te.billedMinutes,
          rateAtEntry: te.rateAtEntry,
          currency: te.currency,
          narrative: te.narrative,
          invoiceNarrative: te.invoiceNarrative,
          status: te.status,
          entity: { id: entity.id, name: entity.name },
        };
      }),
      expenses: invoiceRow.expenses.map((ex) => {
        const entity =
          ex.matter ?? panic("Invoiced expense has no matter entity");
        return {
          id: ex.id,
          entityId: ex.matterId,
          dateIncurred: ex.dateIncurred,
          amount: ex.amount,
          currency: ex.currency,
          category: ex.category,
          description: ex.description,
          invoiceDescription: ex.invoiceDescription,
          billable: ex.billable,
          markup: ex.markup,
          entity: { id: entity.id, name: entity.name },
        };
      }),
    };

    const textFields = runTextFieldSpecs(
      invoiceDetailTextFieldSpecs(workspaceId),
      { invoice },
    );

    return { egress: "structured", payload: { invoice }, textFields };
  }

  // List mode. matter_id is guaranteed present by the schema.
  const matterId = input.matter_id ?? "";
  const workspaceId = ensureWorkspaceAccess({ context, workspaceId: matterId });
  if (!workspaceId) {
    return notFoundResult("Matter not found or not accessible");
  }

  const cursor =
    input.cursor === undefined ? null : invoicePageCursor.decode(input.cursor);
  if (input.cursor !== undefined && cursor === null) {
    return structuredErrorResult({
      code: "validation_error",
      message: "Invalid cursor",
      issues: [{ path: "cursor", message: "Invalid cursor" }],
      hint: "Pass the 'cursor' verbatim as returned by a previous call, or omit it for the first page.",
    });
  }
  const limit = input.limit ?? DEFAULT_LIST_LIMIT;

  const rows = await context.scopedDb((tx) =>
    tx
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        reference: invoices.reference,
        status: invoices.status,
        invoiceDate: invoices.invoiceDate,
        dueDate: invoices.dueDate,
        currency: invoices.currency,
        totalAmount: invoices.totalAmount,
        createdAtCursor: invoicePageCursor.cursorValue.as("created_at_cursor"),
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.workspaceId, workspaceId),
          cursor === null
            ? undefined
            : or(
                gt(invoices.createdAt, invoicePageCursor.boundary(cursor)),
                and(
                  eq(invoices.createdAt, invoicePageCursor.boundary(cursor)),
                  gt(invoices.id, cursor.id),
                ),
              ),
        ),
      )
      .orderBy(asc(invoices.createdAt), asc(invoices.id))
      .limit(limit + 1),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) =>
      invoicePageCursor.encode(item.createdAtCursor, item.id),
  });

  const invoiceList = page.items.map(
    ({ createdAtCursor: _createdAtCursor, ...invoice }) => invoice,
  );

  const textFields = runTextFieldSpecs(invoiceListTextFieldSpecs(workspaceId), {
    invoices: invoiceList,
  });

  return {
    egress: "structured",
    payload: { invoices: invoiceList, nextCursor: page.nextCursor },
    textFields,
  };
};

// --- get_usage ----------------------------------------------------------

const getUsageArgsSchema = v.strictObject({});

const handleGetUsageTool: McpToolHandler = async ({ args, context }) => {
  if (
    !roles[context.memberRole].authorize({ organizationSettings: ["update"] })
      .success
  ) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(getUsageArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult({
      issues: parsed.issues,
      message: "Invalid input: expected no parameters",
    });
  }

  const entitlement = await Result.gen(() =>
    readOrgEntitlementHandler({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
    }),
  );
  if (Result.isError(entitlement)) {
    return errorResult(entitlement.error.message);
  }

  // Passthrough: plan/seat/period/remaining-units are organization billing
  // data, not tenant-authored text.
  return textResult(entitlement.value);
};

export const BILLING_TOOL_HANDLERS = {
  list_time_entries: handleListTimeEntriesTool,
  save_time_entry: handleSaveTimeEntryTool,
  delete_time_entry: handleDeleteTimeEntryTool,
  resolve_rate: handleResolveRateTool,
  list_invoices: handleListInvoicesTool,
  get_usage: handleGetUsageTool,
} satisfies Record<BillingToolName, McpToolHandler>;

export const BILLING_TOOL_SET = defineMcpToolSet(
  BILLING_TOOL_DEFINITIONS,
  BILLING_TOOL_HANDLERS,
);
