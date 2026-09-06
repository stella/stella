import { panic, Result } from "better-result";
import { and, asc, eq, gt, gte, inArray, lte, or } from "drizzle-orm";
import * as v from "valibot";

import { TIME_ENTRY_STATUSES } from "@stll/api-contract";
import { roles } from "@stll/permissions";

import { member, user } from "@/api/db/auth-schema";
import { invoices, timeEntries } from "@/api/db/schema";
import { createTimeEntryHandler } from "@/api/handlers/time-entries/create";
import { deleteTimeEntryHandler } from "@/api/handlers/time-entries/delete";
import { updateTimeEntryHandler } from "@/api/handlers/time-entries/update";
import { readOrgEntitlementHandler } from "@/api/handlers/usage/get-entitlement";
import { TIME_ENTRY_VISIBILITY } from "@/api/lib/billing-constants";
import { resolveRate } from "@/api/lib/billing-rates";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  DELETE_TIME_ENTRY_PROJECTION,
  GET_USAGE_PROJECTION,
  LIST_INVOICES_DETAIL_PROJECTION,
  LIST_INVOICES_LIST_PROJECTION,
  LIST_INVOICES_PROJECTION,
  LIST_TIME_ENTRIES_DETAIL_PROJECTION,
  LIST_TIME_ENTRIES_LIST_PROJECTION,
  LIST_TIME_ENTRIES_PROJECTION,
  RESOLVE_RATE_PROJECTION,
  SAVE_TIME_ENTRY_PROJECTION,
} from "@/api/lib/chat/projections";
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
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import {
  defineTextFieldSpec,
  deriveTextFieldPaths,
  runTextFieldSpecs,
} from "@/api/mcp/text-field-spec";
import type {
  McpTextFieldSpec,
  McpToolDefinition,
  McpToolHandler,
  TypedMcpToolHandler,
} from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import {
  bindWorkspaceRecorder,
  DEFAULT_LIST_LIMIT,
  ensureActiveWorkspace,
  ensureWorkspaceAccess,
  errorResult,
  internalFailureResult,
  ISO_DATE_SCHEMA,
  MAX_LIST_LIMIT,
  notFoundResult,
  structuredErrorResult,
  toolDataResult,
  uuidInputSchema,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import { defineValibotMcpTool } from "@/api/mcp/valibot-tool-definition";

type BillingToolName =
  | "list_time_entries"
  | "save_time_entry"
  | "delete_time_entry"
  | "resolve_rate"
  | "list_invoices"
  | "get_usage";

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
  entity: { name: string } | null;
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
    items: (payload) =>
      payload.invoice.timeEntries.filter(
        (
          item,
        ): item is InvoiceTimeEntryTextItem & { entity: { name: string } } =>
          item.entity !== null,
      ),
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
    matter_id: v.optional(
      uuidInputSchema(
        "Matter ID to list time entries in; required unless " +
          "time_entry_id is given.",
      ),
    ),
    time_entry_id: v.optional(
      uuidInputSchema("Time entry ID to read in detail"),
    ),
    entity_id: v.optional(
      v.pipe(
        v.string(),
        v.uuid(),
        v.description(
          "List only entries logged against this entity (document, folder, " +
            "or task the time is billed to)",
        ),
      ),
    ),
    user_id: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description("List only entries recorded by this user"),
      ),
    ),
    date_from: v.optional(
      v.pipe(
        ISO_DATE_SCHEMA,
        v.maxLength(10),
        v.description(
          "List only entries worked on or after this ISO date (YYYY-MM-DD)",
        ),
      ),
    ),
    date_to: v.optional(
      v.pipe(
        ISO_DATE_SCHEMA,
        v.maxLength(10),
        v.description(
          "List only entries worked on or before this ISO date (YYYY-MM-DD)",
        ),
      ),
    ),
    status: v.optional(
      v.pipe(
        v.picklist(TIME_ENTRY_STATUSES),
        v.description("List only entries with this status"),
      ),
    ),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(MAX_LIST_LIMIT),
        v.description("Max entries to return"),
      ),
    ),
    cursor: v.optional(
      v.pipe(
        v.string(),
        v.maxLength(512),
        v.description(
          "Opaque cursor from a previous list_time_entries call to fetch the next page",
        ),
      ),
    ),
  }),
  // List mode needs a workspace to scope to; detail mode uses time_entry_id
  // alone.
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
  entityId: timeEntries.workItemId,
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

const handleListTimeEntriesTool: TypedMcpToolHandler<
  v.InferInput<typeof LIST_TIME_ENTRIES_PROJECTION>
> = async ({ args, context }) => {
  if (!hasEffectiveAuthority(context, { timeEntry: ["read"] })) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(listTimeEntriesArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
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
    const canReview = hasEffectiveAuthority(context, {
      timeEntry: ["approve"],
    });
    if (!canReview && entryRow.userId !== context.userId) {
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
    return {
      egress: "structured",
      payload: {
        visibility: canReview
          ? TIME_ENTRY_VISIBILITY.ALL_ENTRIES
          : TIME_ENTRY_VISIBILITY.OWN_ENTRIES,
        entry,
      } satisfies v.InferInput<typeof LIST_TIME_ENTRIES_DETAIL_PROJECTION>,
      textFields,
    };
  }

  // List mode. matter_id is guaranteed present by the schema.
  const requestedWorkspaceId = input.matter_id ?? "";
  const workspaceId = ensureWorkspaceAccess({
    context,
    workspaceId: requestedWorkspaceId,
  });
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
  const canReview = hasEffectiveAuthority(context, {
    timeEntry: ["approve"],
  });
  if (
    !canReview &&
    input.user_id !== undefined &&
    input.user_id !== context.userId
  ) {
    return errorResult("Forbidden");
  }

  const accessConditions = [eq(timeEntries.workspaceId, workspaceId)];
  if (input.user_id !== undefined) {
    accessConditions.push(
      eq(timeEntries.userId, brandPersistedUserId(input.user_id)),
    );
  } else if (!canReview) {
    accessConditions.push(eq(timeEntries.userId, context.userId));
  }

  const rows = await context.scopedDb((tx) =>
    tx
      .select(timeEntryColumns)
      .from(timeEntries)
      .where(
        and(
          ...accessConditions,
          input.entity_id === undefined
            ? undefined
            : eq(
                timeEntries.workItemId,
                brandPersistedEntityId(input.entity_id),
              ),
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
    payload: {
      visibility: canReview
        ? TIME_ENTRY_VISIBILITY.ALL_ENTRIES
        : TIME_ENTRY_VISIBILITY.OWN_ENTRIES,
      entries,
      nextCursor: page.nextCursor,
    } satisfies v.InferInput<typeof LIST_TIME_ENTRIES_LIST_PROJECTION>,
    textFields,
  };
};

// --- save_time_entry ----------------------------------------------------

const saveTimeEntryArgsSchema = v.pipe(
  v.strictObject({
    time_entry_id: v.optional(
      uuidInputSchema("Time entry ID to update; omit to create"),
    ),
    matter_id: v.optional(
      uuidInputSchema(
        "Matter ID to create the entry in; required when creating.",
      ),
    ),
    entity_id: v.optional(
      v.pipe(
        v.nullable(v.pipe(v.string(), v.uuid())),
        v.description(
          "Optional work item context (document, folder, or task). When " +
            "updating, moves the entry to a different entity in the same " +
            "matter; pass null to clear.",
        ),
      ),
    ),
    date_worked: v.optional(
      v.pipe(
        ISO_DATE_SCHEMA,
        v.maxLength(10),
        v.description(
          "Date the work was done (ISO YYYY-MM-DD); required when creating",
        ),
      ),
    ),
    timezone_id: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(64),
        v.description(
          "IANA time zone the date_worked is interpreted in (e.g. " +
            "Europe/Prague); required when creating or changing date_worked",
        ),
      ),
    ),
    duration_minutes: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.description("Minutes worked (whole minutes); required when creating"),
      ),
    ),
    narrative: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(10_000),
        v.description("Description of the work; required when creating"),
      ),
    ),
    invoice_narrative: v.optional(
      v.pipe(
        v.nullable(v.pipe(v.string(), v.maxLength(10_000))),
        v.description(
          "Client-facing narrative shown on the invoice; pass null to clear. " +
            "Only valid when updating.",
        ),
      ),
    ),
    billable: v.optional(
      v.pipe(
        v.boolean(),
        v.description("Whether the entry is billable to the client"),
      ),
    ),
    no_charge: v.optional(
      v.pipe(
        v.boolean(),
        v.description(
          "Whether the entry is recorded but not charged. Only valid when updating.",
        ),
      ),
    ),
    task_code: v.optional(
      v.pipe(
        v.nullable(v.pipe(v.string(), v.maxLength(20))),
        v.description("UTBMS/LEDES task code; pass null to clear"),
      ),
    ),
    activity_code: v.optional(
      v.pipe(
        v.nullable(v.pipe(v.string(), v.maxLength(20))),
        v.description("UTBMS/LEDES activity code; pass null to clear"),
      ),
    ),
  }),
  // Creating (no time_entry_id) requires the full set the backing create schema
  // demands; list them in one message so a partial create is rejected up front.
  v.partialCheck(
    [
      ["time_entry_id"],
      ["matter_id"],
      ["date_worked"],
      ["timezone_id"],
      ["duration_minutes"],
      ["narrative"],
    ],
    (i) =>
      i.time_entry_id !== undefined ||
      (i.matter_id !== undefined &&
        i.date_worked !== undefined &&
        i.timezone_id !== undefined &&
        i.duration_minutes !== undefined &&
        i.narrative !== undefined),
    "Creating a time entry requires matter_id, date_worked, timezone_id, duration_minutes, and narrative",
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
  // invoice_narrative and no_charge are update-only in the backing
  // handler, so reject them on a create.
  v.partialCheck(
    [["time_entry_id"], ["invoice_narrative"], ["no_charge"]],
    ({ time_entry_id, invoice_narrative, no_charge }) =>
      time_entry_id !== undefined ||
      (invoice_narrative === undefined && no_charge === undefined),
    "invoice_narrative and no_charge apply to an existing time entry; pass time_entry_id",
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
      i.activity_code !== undefined,
    "Provide at least one change to the time entry",
  ),
);

const handleSaveTimeEntryTool: TypedMcpToolHandler<
  v.InferInput<typeof SAVE_TIME_ENTRY_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(saveTimeEntryArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const input = parsed.output;

  // Create branch.
  if (input.time_entry_id === undefined) {
    if (!hasEffectiveAuthority(context, { timeEntry: ["create"] })) {
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
      (
        context.testDependencies?.createTimeEntryHandler ??
        createTimeEntryHandler
      )({
        safeDb: context.safeDb,
        organizationId: context.organizationId,
        workspaceId,
        userId: context.userId,
        recordAuditEvent: bindWorkspaceRecorder(context, workspaceId),
        body: {
          ...(input.entity_id === undefined
            ? {}
            : {
                workItemId:
                  input.entity_id === null
                    ? null
                    : brandPersistedEntityId(input.entity_id),
              }),
          dateWorked: input.date_worked ?? "",
          timezoneId: input.timezone_id ?? "",
          durationMinutes: input.duration_minutes ?? 0,
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
      return internalFailureResult(created.error);
    }
    return toolDataResult({
      timeEntryId: created.value.id,
    } satisfies v.InferInput<typeof SAVE_TIME_ENTRY_PROJECTION>);
  }

  // Update branch.
  if (!hasEffectiveAuthority(context, { timeEntry: ["update"] })) {
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
      actor: {
        userId: context.userId,
        memberRole: { role: context.memberRole },
      },
      recordAuditEvent: bindWorkspaceRecorder(context, workspaceId),
      body: {
        id: timeEntryId,
        ...(input.date_worked === undefined
          ? {}
          : {
              dateWorked: input.date_worked,
              ...(input.timezone_id === undefined
                ? {}
                : { timezoneId: input.timezone_id }),
            }),
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
          : {
              workItemId:
                input.entity_id === null
                  ? null
                  : brandPersistedEntityId(input.entity_id),
            }),
        ...(input.task_code === undefined ? {} : { taskCode: input.task_code }),
        ...(input.activity_code === undefined
          ? {}
          : { activityCode: input.activity_code }),
      },
    }),
  );
  if (Result.isError(updated)) {
    return internalFailureResult(updated.error);
  }
  return toolDataResult({
    timeEntryId,
    updated: true,
  } satisfies v.InferInput<typeof SAVE_TIME_ENTRY_PROJECTION>);
};

// --- delete_time_entry --------------------------------------------------

const deleteTimeEntryArgsSchema = v.strictObject({
  time_entry_id: uuidInputSchema("Time entry ID to delete or write off"),
  confirm: v.optional(
    v.pipe(
      v.boolean(),
      v.description(
        "Must be true to run this irreversible operation. Set it only after " +
          "a human user has explicitly approved the deletion.",
      ),
    ),
  ),
});

const handleDeleteTimeEntryTool: TypedMcpToolHandler<
  v.InferInput<typeof DELETE_TIME_ENTRY_PROJECTION>
> = async ({ args, context }) => {
  if (!hasEffectiveAuthority(context, { timeEntry: ["delete"] })) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(deleteTimeEntryArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
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
      actor: {
        userId: context.userId,
        memberRole: { role: context.memberRole },
      },
      recordAuditEvent: bindWorkspaceRecorder(context, workspaceId),
      body: { id: timeEntryId },
    }),
  );
  if (Result.isError(deleted)) {
    return internalFailureResult(deleted.error);
  }
  return toolDataResult({
    deleted: deleted.value.deleted,
  } satisfies v.InferInput<typeof DELETE_TIME_ENTRY_PROJECTION>);
};

// --- resolve_rate -------------------------------------------------------

const resolveRateArgsSchema = v.strictObject({
  matter_id: uuidInputSchema("Matter ID to resolve the rate in."),
  user_id: v.pipe(
    v.string(),
    v.minLength(1),
    v.description("User ID to resolve the rate for"),
  ),
  date: v.pipe(
    ISO_DATE_SCHEMA,
    v.maxLength(10),
    v.description("Date to resolve the rate on (ISO YYYY-MM-DD)"),
  ),
});

const handleResolveRateTool: McpToolHandler = async ({ args, context }) => {
  if (!hasEffectiveAuthority(context, { rate: ["read"] })) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(resolveRateArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
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
    return internalFailureResult(validated.error);
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
    return internalFailureResult(resolved.error);
  }

  // Passthrough: only a rate amount (minor units) and currency code, no
  // tenant-authored text.
  return toolDataResult(
    resolved.value ??
      ({ hourlyRate: null, currency: null } satisfies v.InferInput<
        typeof RESOLVE_RATE_PROJECTION
      >),
  );
};

// --- list_invoices ------------------------------------------------------

const listInvoicesArgsSchema = v.pipe(
  v.strictObject({
    matter_id: v.optional(
      uuidInputSchema(
        "Matter ID to list invoices in; required unless invoice_id is " +
          "given.",
      ),
    ),
    invoice_id: v.optional(uuidInputSchema("Invoice ID to read in detail")),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(MAX_LIST_LIMIT),
        v.description("Max invoices to return"),
      ),
    ),
    cursor: v.optional(
      v.pipe(
        v.string(),
        v.maxLength(512),
        v.description(
          "Opaque cursor from a previous list_invoices call to fetch the next page",
        ),
      ),
    ),
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
            workItemId: true,
            dateWorked: true,
            billedMinutes: true,
            rateAtEntry: true,
            currency: true,
            narrative: true,
            invoiceNarrative: true,
            status: true,
          },
          with: { workItem: { columns: { id: true, name: true } } },
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

const handleListInvoicesTool: TypedMcpToolHandler<
  v.InferInput<typeof LIST_INVOICES_PROJECTION>
> = async ({ args, context }) => {
  if (!hasEffectiveAuthority(context, { workspace: ["read"] })) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(listInvoicesArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
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
        const workItem = te.workItem;
        return {
          id: te.id,
          entityId: te.workItemId,
          dateWorked: te.dateWorked,
          billedMinutes: te.billedMinutes,
          rateAtEntry: te.rateAtEntry,
          currency: te.currency,
          narrative: te.narrative,
          invoiceNarrative: te.invoiceNarrative,
          status: te.status,
          entity: workItem ? { id: workItem.id, name: workItem.name } : null,
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

    return {
      egress: "structured",
      payload: { invoice } satisfies v.InferInput<
        typeof LIST_INVOICES_DETAIL_PROJECTION
      >,
      textFields,
    };
  }

  // List mode. matter_id is guaranteed present by the schema.
  const requestedWorkspaceId = input.matter_id ?? "";
  const workspaceId = ensureWorkspaceAccess({
    context,
    workspaceId: requestedWorkspaceId,
  });
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
            : invoicePageCursor.keysetAfter({
                cursor,
                idColumn: invoices.id,
                direction: "ascending",
              }),
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
    payload: {
      invoices: invoiceList,
      nextCursor: page.nextCursor,
    } satisfies v.InferInput<typeof LIST_INVOICES_LIST_PROJECTION>,
    textFields,
  };
};

// --- get_usage ----------------------------------------------------------

const getUsageArgsSchema = v.strictObject({});

const handleGetUsageTool: TypedMcpToolHandler<
  v.InferInput<typeof GET_USAGE_PROJECTION>
> = async ({ args, context }) => {
  if (!hasEffectiveAuthority(context, { organizationSettings: ["update"] })) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(getUsageArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }

  const entitlement = await Result.gen(() =>
    readOrgEntitlementHandler({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
    }),
  );
  if (Result.isError(entitlement)) {
    return internalFailureResult(entitlement.error);
  }

  // Passthrough: plan/seat/period/remaining-units are organization billing
  // data, not tenant-authored text.
  // The two payload branches are tied to GET_USAGE_NO_PLAN_PROJECTION /
  // GET_USAGE_ENTITLED_PROJECTION where they are built
  // (`readOrgEntitlementHandler`, handlers/usage/get-entitlement.ts).
  return toolDataResult(entitlement.value);
};

export const BILLING_TOOL_DEFINITIONS = [
  defineValibotMcpTool({
    annotations: {
      title: "List time entries",
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "List time entries in a matter, or read one entry in detail. Pass " +
      "time_entry_id to get a single entry. Otherwise pass matter_id to " +
      "list the matter's entries, optionally filtered by entity_id (the " +
      "item the time was logged against), user_id, a date-worked range (date_from/" +
      "date_to, ISO YYYY-MM-DD), and status. Returns each entry's id, entity, " +
      "user, date, minutes, rate (minor currency units), currency, narrative, " +
      "and status. The response includes visibility: all_entries for billing " +
      "reviewers, or own_entries when the caller can see only their own time; " +
      "own_entries is not a matter total.",
    inputSchema: listTimeEntriesArgsSchema,
    jsonSchemaProjectionWaiver: {
      ignoreActions: ["partial_check"],
      reason:
        "The matter_id/time_entry_id cross-field requirement stays authoritative in the runtime schema.",
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
    isVisibleToMemberRole: (memberRole) =>
      roles[memberRole].authorize({ timeEntry: ["read"] }).success,
    name: "list_time_entries",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    description:
      "Create or update a time entry. Omit time_entry_id to create (matter_id, " +
      "date_worked, timezone_id, duration_minutes, and narrative required; " +
      "entity_id is optional context). Pass time_entry_id to update: " +
      "set date_worked (with timezone_id), duration_minutes, narrative, " +
      "invoice_narrative, " +
      "billable, no_charge, entity_id (move the entry), task_code, " +
      "and/or activity_code. The timekeeper's effective rate is resolved " +
      "server-side. Durations are whole minutes. Returns the time entry ID.",
    inputSchema: saveTimeEntryArgsSchema,
    jsonSchemaProjectionWaiver: {
      ignoreActions: ["partial_check"],
      reason:
        "The create-vs-update field requirements stay authoritative in the runtime schema.",
    },
    annotations: {
      title: "Save time entry",
      idempotentHint: false,
      openWorldHint: false,
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    feature: "FEATURE_TIME_BILLING",
    isVisibleToMemberRole: (memberRole) =>
      roles[memberRole].authorize({ timeEntry: ["create"] }).success ||
      roles[memberRole].authorize({ timeEntry: ["update"] }).success,
    name: "save_time_entry",
    scope: "stella:billing_write",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Delete time entry",
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "Delete a time entry. A draft entry is permanently deleted; an approved " +
      "entry is written off instead (kept for the audit trail, excluded from " +
      "billing). A billed entry cannot be deleted until its invoice is " +
      "reverted. Returns whether the entry was hard-deleted.",
    inputSchema: deleteTimeEntryArgsSchema,
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    feature: "FEATURE_TIME_BILLING",
    isVisibleToMemberRole: (memberRole) =>
      roles[memberRole].authorize({ timeEntry: ["delete"] }).success,
    name: "delete_time_entry",
    scope: "stella:billing_write",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Resolve billing rate",
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Resolve the effective hourly rate for a user on a given date in a " +
      "matter, using its default rate table (user-specific rate first, " +
      "then the table default). Returns the hourly rate in integer " +
      "minor currency units (e.g. cents) and the currency, or nulls when no " +
      "rate applies.",
    inputSchema: resolveRateArgsSchema,
    access: "read",
    anonymized: { exposure: "passthrough" },
    feature: "FEATURE_TIME_BILLING",
    isVisibleToMemberRole: (memberRole) =>
      roles[memberRole].authorize({ rate: ["read"] }).success,
    name: "resolve_rate",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "List invoices",
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "List invoices in a matter, or read one invoice in detail. Pass " +
      "invoice_id to get a single invoice with its line items (time entries " +
      "and expenses). Otherwise pass matter_id to list the matter's " +
      "invoices. Returns each invoice's id, number, reference, status, dates, currency, " +
      "and total (integer minor currency units).",
    inputSchema: listInvoicesArgsSchema,
    jsonSchemaProjectionWaiver: {
      ignoreActions: ["partial_check"],
      reason:
        "The matter_id/invoice_id cross-field requirement stays authoritative in the runtime schema.",
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
    isVisibleToMemberRole: (memberRole) =>
      roles[memberRole].authorize({ workspace: ["read"] }).success,
    name: "list_invoices",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Get usage",
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Read the organization's current usage entitlement: plan, seats, billing " +
      "period, and how many usage units (AI credits) remain this period. " +
      "Returns { entitlement: null } when the organization has no active plan. " +
      "Requires organization-settings management access.",
    inputSchema: getUsageArgsSchema,
    access: "read",
    anonymized: { exposure: "passthrough" },
    feature: "FEATURE_USAGE",
    isVisibleToMemberRole: (memberRole) =>
      roles[memberRole].authorize({ organizationSettings: ["update"] }).success,
    name: "get_usage",
    scope: "stella:read",
  }),
] as const satisfies readonly McpToolDefinition[];

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
