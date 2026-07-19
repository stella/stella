import { Result } from "better-result";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import * as v from "valibot";

import { roles } from "@stll/permissions";

import { entities } from "@/api/db/schema";
import { lookupBusinessRegistryShared } from "@/api/handlers/contacts/business-registries-lookup";
import { createContactHandler } from "@/api/handlers/contacts/create";
import { deleteContactHandler } from "@/api/handlers/contacts/delete-by-id";
import { updateContactHandler } from "@/api/handlers/contacts/update-by-id";
import {
  entityListCursorCondition,
  entityListTimestampCursorExpr,
} from "@/api/handlers/entities/list-cursor";
import { addAssigneeHandler } from "@/api/handlers/tasks/assignees-add";
import { removeAssigneeHandler } from "@/api/handlers/tasks/assignees-remove";
import { createTaskEntityHandler } from "@/api/handlers/tasks/create";
import { createEntityLinkHandler } from "@/api/handlers/tasks/entity-links-create";
import { deleteEntityLinkHandler } from "@/api/handlers/tasks/entity-links-delete";
import { updateTaskHandler } from "@/api/handlers/tasks/update";
import { archiveWorkspaceHandler } from "@/api/handlers/workspaces/archive";
import { createWorkspaceHandler } from "@/api/handlers/workspaces/create";
import { deleteWorkspaceHandler } from "@/api/handlers/workspaces/delete-by-id";
import { unarchiveWorkspaceHandler } from "@/api/handlers/workspaces/unarchive";
import { updateWorkspaceHandler } from "@/api/handlers/workspaces/update-by-id";
import { createWorkspaceContactHandler } from "@/api/handlers/workspaces/workspace-contacts-create";
import { deleteWorkspaceContactHandler } from "@/api/handlers/workspaces/workspace-contacts-delete";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { BUSINESS_REGISTRY_SLUGS } from "@/api/lib/business-registries/dispatch";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import {
  brandPersistedContactId,
  brandPersistedEntityId,
  brandPersistedEntityLinkId,
  brandPersistedUserId,
  brandPersistedWorkspaceContactId,
} from "@/api/lib/safe-id-boundaries";
import { includes } from "@/api/lib/type-guards";
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
  bindWorkspaceRecorder,
  confirmProp,
  DEFAULT_LIST_LIMIT,
  ensureActiveWorkspace,
  ensureWorkspaceAccess,
  enumProp,
  errorResult,
  internalFailureResult,
  getWorkspaceStatus,
  intProp,
  MAX_LIST_LIMIT,
  notFoundResult,
  nullableStringProp,
  stringProp,
  structuredErrorResult,
  textResult,
  validationErrorResult,
} from "@/api/mcp/tool-utils";

type MatterToolName =
  | "save_matter"
  | "delete_matter"
  | "save_contact"
  | "delete_contact"
  | "lookup_business_registry"
  | "list_tasks"
  | "save_task"
  | "link_matter_contact";

/** Statuses a matter can be flipped to through save_matter. */
const MATTER_STATUSES = ["active", "archived"] as const;

/** Contact discriminator accepted by save_contact. */
const CONTACT_TYPES = ["person", "organization"] as const;

/**
 * Entity kinds save_task will link a task to. Mirrors link_entity_id's
 * advertised contract (document, folder, or another task) so the up-front
 * target check rejects a non-linkable kind before any mutation runs.
 */
const LINKABLE_ENTITY_KINDS = ["document", "folder", "task"] as const;

/**
 * Roles a contact can hold on a matter. Mirrors the closed set in
 * workspaces/workspace-contacts-create.ts; kept in sync so the MCP schema
 * advertises the same options the backing handler validates against.
 */
const WORKSPACE_CONTACT_ROLES = [
  "opposing_party",
  "opposing_counsel",
  "co_counsel",
  "witness",
  "expert_witness",
  "third_party",
  "judge",
  "mediator",
  "other",
] as const;

/**
 * System file-column name for a matter created via MCP. Mirrors the web
 * client's default (`_protected.workspaces/-mutations.ts`) so an
 * agent-created matter and a UI-created matter start with the same column.
 */
const DEFAULT_FILE_PROPERTY_NAME = "Documents";

// --- list_tasks text-field specs -----------------------------------------

/** Shape `list_tasks`'s list branch redacts: one field, per item. */
type TaskNameTextItem = { name: string };

const TASK_LIST_TEXT_FIELD_PATH = "tasks[].name";

const taskListTextFieldSpecs = (
  workspaceId: string,
): readonly McpTextFieldSpec<{ tasks: readonly TaskNameTextItem[] }>[] => [
  defineTextFieldSpec({
    path: TASK_LIST_TEXT_FIELD_PATH,
    items: (payload) => payload.tasks,
    scope: () => workspaceId,
    read: (item) => item.name,
    apply: (item, value) => {
      item.name = value;
    },
  }),
];

type TaskAssigneeTextItem = { name: string | null };
type TaskLinkTextItem = { entity: { name: string | null } };

/** Full shape `list_tasks`'s detail branch redacts, one task deep. */
type TaskDetailTextPayload = {
  task: {
    name: string;
    location: string | null;
    assignees: readonly TaskAssigneeTextItem[];
    links: readonly TaskLinkTextItem[];
  };
};

/**
 * Every redactable field on one task detail response: the task's own
 * name/location (P1: constant `workspaceId`, single item), plus its
 * assignees' names and linked entities' names.
 */
const taskDetailTextFieldSpecs = (
  workspaceId: string,
): readonly McpTextFieldSpec<TaskDetailTextPayload>[] => [
  defineTextFieldSpec({
    path: "task.name",
    items: (payload) => [payload.task],
    scope: () => workspaceId,
    read: (item) => item.name,
    apply: (item, value) => {
      item.name = value;
    },
  }),
  defineTextFieldSpec({
    path: "task.location",
    items: (payload) => [payload.task],
    scope: () => workspaceId,
    read: (item) => item.location,
    apply: (item, value) => {
      item.location = value;
    },
  }),
  defineTextFieldSpec({
    path: "task.assignees[].name",
    items: (payload) => payload.task.assignees,
    scope: () => workspaceId,
    read: (item) => item.name,
    apply: (item, value) => {
      item.name = value;
    },
  }),
  defineTextFieldSpec({
    path: "task.links[].entity.name",
    items: (payload) => payload.task.links,
    scope: () => workspaceId,
    read: (item) => item.entity.name,
    apply: (item, value) => {
      item.entity.name = value;
    },
  }),
];

const TASK_DETAIL_TEXT_FIELD_PATHS = deriveTextFieldPaths(
  taskDetailTextFieldSpecs(""),
);

export const MATTER_TOOL_DEFINITIONS = [
  {
    description:
      "Create, update, archive, or unarchive a matter. Omit matter_id to " +
      "create a new matter (name required; pass client_id to attach a client " +
      "contact). Pass matter_id to update an existing matter: set name, " +
      "reference, or billing_reference, and/or set status to 'archived' or " +
      "'active' to archive or unarchive it. Returns the matter ID.",
    inputSchema: {
      type: "object",
      properties: {
        matter_id: stringProp(
          "Matter/workspace ID to update; omit to create a new matter",
        ),
        name: stringProp("Matter name; required when creating", {
          maxLength: 256,
        }),
        client_id: stringProp(
          "Contact ID to attach in the client role. Only valid when " +
            "creating a matter.",
        ),
        reference: stringProp(
          "Matter reference (file number). Only valid when updating.",
          { maxLength: 64 },
        ),
        billing_reference: nullableStringProp(
          "Billing reference; pass null to clear. Only valid when updating.",
          { maxLength: 128 },
        ),
        status: enumProp(
          "Set 'archived' to archive the matter or 'active' to unarchive it. " +
            "Only valid when updating.",
          MATTER_STATUSES,
        ),
      },
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "save_matter",
    scope: "stella:matters_write",
  },
  {
    annotations: { destructiveHint: true },
    description:
      "Permanently delete a matter and all its documents, tasks, fields, and " +
      "chat history. This is irreversible.",
    inputSchema: {
      type: "object",
      properties: {
        matter_id: stringProp("Matter/workspace ID to delete"),
        confirm: confirmProp(),
      },
      required: ["matter_id"],
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "delete_matter",
    scope: "stella:matters_write",
  },
  {
    description:
      "Create or update a contact (a person or organization in the address " +
      "book, shared across the whole organization). Omit contact_id to create " +
      "(type and display_name required); pass contact_id to update. String " +
      "fields other than display_name accept null to clear them.",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: stringProp("Contact ID to update; omit to create"),
        type: enumProp("Contact kind; required when creating", CONTACT_TYPES),
        display_name: stringProp(
          "Display name; required when creating, non-empty when updating",
          { maxLength: 512 },
        ),
        first_name: nullableStringProp("First name; pass null to clear", {
          maxLength: 256,
        }),
        last_name: nullableStringProp("Last name; pass null to clear", {
          maxLength: 256,
        }),
        organization_name: nullableStringProp(
          "Organization name; pass null to clear",
          { maxLength: 512 },
        ),
        notes: nullableStringProp("Free-text notes; pass null to clear"),
      },
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "save_contact",
    scope: "stella:matters_write",
  },
  {
    annotations: { destructiveHint: true },
    description:
      "Permanently delete a contact from the organization address book. " +
      "Rejected while the contact is still the client of any matter. This is " +
      "irreversible.",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: stringProp("Contact ID to delete"),
        confirm: confirmProp(),
      },
      required: ["contact_id"],
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "delete_contact",
    scope: "stella:matters_write",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Look up a company in a public business register (ARES, Brreg, " +
      "Companies House, EDGAR, GCIS, KRS, ORSR, PRH, recherche-entreprises, " +
      "or VIES). Pass a canonical identifier (company/registration number, " +
      "VAT number) for an exact match, or a company name to search where the " +
      "register supports it. Returns registered names, addresses, and " +
      "registry-specific details.",
    inputSchema: {
      type: "object",
      properties: {
        registry: enumProp(
          "Business register to query",
          BUSINESS_REGISTRY_SLUGS,
        ),
        query: stringProp(
          "Canonical identifier (e.g. company number, VAT number) or company name",
          { maxLength: 256 },
        ),
      },
      required: ["registry", "query"],
    },
    access: "read",
    anonymized: { exposure: "passthrough" },
    name: "lookup_business_registry",
    scope: "stella:read",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "List tasks in a matter, or read one task in detail. Pass task_id to " +
      "get a single task's fields, assignees, and linked entities. Otherwise " +
      "pass matter_id to list the matter's tasks, optionally filtered by a " +
      "due-date range (date_from/date_to, ISO YYYY-MM-DD) and status. " +
      "Returns each task's id, name, status, priority, and due date.",
    inputSchema: {
      type: "object",
      properties: {
        matter_id: stringProp(
          "Matter/workspace ID to list tasks in; required unless task_id is given",
        ),
        task_id: stringProp("Task entity ID to read in detail"),
        date_from: stringProp(
          "List only tasks due on or after this ISO date (YYYY-MM-DD)",
          { maxLength: 10 },
        ),
        date_to: stringProp(
          "List only tasks due on or before this ISO date (YYYY-MM-DD)",
          { maxLength: 10 },
        ),
        status: stringProp("List only tasks with this status", {
          maxLength: 32,
        }),
        limit: intProp("Max tasks to return", { min: 1, max: MAX_LIST_LIMIT }),
        cursor: stringProp(
          "Opaque cursor from a previous list_tasks call to fetch the next page",
          { maxLength: 512 },
        ),
      },
    },
    access: "read",
    anonymized: {
      exposure: "anonymize",
      textFields: [TASK_LIST_TEXT_FIELD_PATH, ...TASK_DETAIL_TEXT_FIELD_PATHS],
    },
    name: "list_tasks",
    scope: "stella:read",
  },
  {
    description:
      "Create or update a task, and manage its assignees and entity links. " +
      "Omit task_id to create a task (matter_id and name required). Pass " +
      "task_id to update: set name, status, priority, or due_date (ISO " +
      "YYYY-MM-DD, null to clear); add or remove one assignee " +
      "(add_assignee_user_id / remove_assignee_user_id); link the task to " +
      "another entity (link_entity_id) or remove a link (unlink_link_id). " +
      "Returns the task ID.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: stringProp("Task entity ID to update; omit to create"),
        matter_id: stringProp(
          "Matter/workspace ID to create the task in; required when creating",
        ),
        name: stringProp("Task name; required when creating", {
          maxLength: 255,
        }),
        status: stringProp("Task status (e.g. open, in_progress, done)", {
          maxLength: 32,
        }),
        priority: stringProp("Task priority (e.g. none, low, medium, high)", {
          maxLength: 16,
        }),
        due_date: nullableStringProp(
          "Due date (ISO YYYY-MM-DD); pass null to clear",
          { maxLength: 10 },
        ),
        add_assignee_user_id: stringProp(
          "User ID to assign to the task (must be a workspace member)",
        ),
        remove_assignee_user_id: stringProp(
          "User ID to unassign from the task",
        ),
        link_entity_id: stringProp(
          "Entity ID to link to the task (document, folder, or another task)",
        ),
        unlink_link_id: stringProp("Entity-link ID to remove"),
      },
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "save_task",
    scope: "stella:matters_write",
  },
  {
    description:
      "Link a contact to a matter in a party role (opposing party/counsel, " +
      "co-counsel, witness, expert witness, third party, judge, mediator, or " +
      "other), or remove such a link. Pass contact_id with role to link. To " +
      "unlink, pass workspace_contact_id (precise, from list_matters) " +
      "or contact_id alone; contact_id alone is rejected when the contact " +
      "holds several roles on the matter.",
    inputSchema: {
      type: "object",
      properties: {
        matter_id: stringProp("Matter/workspace ID"),
        contact_id: stringProp(
          "Contact ID: with role to link the contact, or alone to unlink it " +
            "from the matter",
        ),
        role: enumProp(
          "Party role for the linked contact; provide it only when linking",
          WORKSPACE_CONTACT_ROLES,
        ),
        workspace_contact_id: stringProp(
          "Existing matter-contact link ID to remove, from list_matters",
        ),
      },
      required: ["matter_id"],
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "link_matter_contact",
    scope: "stella:matters_write",
  },
] as const satisfies readonly McpToolDefinition[];

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

// --- save_matter --------------------------------------------------------

const saveMatterArgsSchema = v.pipe(
  v.strictObject({
    matter_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
    client_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    reference: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
    billing_reference: v.optional(
      v.nullable(v.pipe(v.string(), v.maxLength(128))),
    ),
    status: v.optional(v.picklist(MATTER_STATUSES)),
  }),
  // Creating (no matter_id) requires a name.
  v.forward(
    v.partialCheck(
      [["matter_id"], ["name"]],
      ({ matter_id, name }) => matter_id !== undefined || name !== undefined,
      "name is required to create a matter",
    ),
    ["name"],
  ),
  // reference, billing_reference, status, and client_id apply to existing
  // matters or to creation respectively; keep the two modes from mixing.
  v.partialCheck(
    [["matter_id"], ["reference"], ["billing_reference"], ["status"]],
    ({ matter_id, reference, billing_reference, status }) =>
      matter_id !== undefined ||
      (reference === undefined &&
        billing_reference === undefined &&
        status === undefined),
    "reference, billing_reference, and status apply to an existing matter; pass matter_id",
  ),
  v.forward(
    v.partialCheck(
      [["matter_id"], ["client_id"]],
      ({ matter_id, client_id }) =>
        matter_id === undefined || client_id === undefined,
      "client_id can only be set when creating a matter",
    ),
    ["client_id"],
  ),
  // An update must request at least one change.
  v.partialCheck(
    [["matter_id"], ["name"], ["reference"], ["billing_reference"], ["status"]],
    ({ matter_id, name, reference, billing_reference, status }) =>
      matter_id === undefined ||
      name !== undefined ||
      reference !== undefined ||
      billing_reference !== undefined ||
      status !== undefined,
    "Provide at least one change: name, reference, billing_reference, or status",
  ),
);

const handleSaveMatterTool: McpToolHandler = async ({ args, context }) => {
  const parsed = v.safeParse(saveMatterArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult({
      issues: parsed.issues,
      message: crossFieldOrGeneric(
        parsed.issues,
        "Invalid input: expected { matter_id?: string, name?: string, client_id?: string, reference?: string, billing_reference?: string|null, status?: 'active'|'archived' }",
      ),
    });
  }
  const input = parsed.output;

  // Create branch.
  if (input.matter_id === undefined) {
    if (
      !roles[context.memberRole].authorize({ workspace: ["create"] }).success
    ) {
      return errorResult("Forbidden");
    }
    const name = input.name ?? "";
    // Validate the client contact up front so matter creation cannot half-run
    // and then fail on an unknown client. Not transactional: the contact could
    // be deleted between this check and creation (an accepted TOCTOU window).
    if (input.client_id !== undefined) {
      const clientId = brandPersistedContactId(input.client_id);
      const client = await context.scopedDb((tx) =>
        tx.query.contacts.findFirst({
          where: {
            id: { eq: clientId },
            organizationId: { eq: context.organizationId },
          },
          columns: { id: true },
        }),
      );
      if (!client) {
        return notFoundResult("client_id contact not found");
      }
    }
    const workspaceId = createSafeId<"workspace">();
    const created = await Result.gen(() =>
      createWorkspaceHandler({
        safeDb: context.safeDb,
        organizationId: context.organizationId,
        userId: context.userId,
        recordAuditEvent: context.recordAuditEvent,
        body: {
          id: workspaceId,
          name,
          filePropertyName: DEFAULT_FILE_PROPERTY_NAME,
          ...(input.client_id === undefined
            ? {}
            : { clientId: brandPersistedContactId(input.client_id) }),
        },
      }),
    );
    if (Result.isError(created)) {
      return internalFailureResult(created.error);
    }
    return textResult({ matterId: created.value.id });
  }

  // Update branch.
  if (!roles[context.memberRole].authorize({ workspace: ["update"] }).success) {
    return errorResult("Forbidden");
  }
  const workspaceId = ensureWorkspaceAccess({
    context,
    workspaceId: input.matter_id,
  });
  if (!workspaceId) {
    return notFoundResult("Matter not found or not accessible");
  }

  // Archived matters are read-only except for an unarchive. The only save_matter
  // request allowed on an archived matter is a pure status:"active" flip
  // (mirrors the HTTP unarchive route, which is the sole mutation mounted
  // outside the active-only workspace group). Any field edit, or re-archiving an
  // already-archived matter, is rejected before touching the backing handlers.
  if (getWorkspaceStatus({ context, workspaceId }) !== "active") {
    const isPureUnarchive =
      input.status === "active" &&
      input.name === undefined &&
      input.reference === undefined &&
      input.billing_reference === undefined;
    if (!isPureUnarchive) {
      if (input.status === "archived") {
        return errorResult("Matter is already archived");
      }
      return errorResult("Matter is archived; unarchive it first");
    }
  }

  const recordAuditEvent = bindWorkspaceRecorder(context, workspaceId);

  if (
    input.name !== undefined ||
    input.reference !== undefined ||
    input.billing_reference !== undefined
  ) {
    const updated = await Result.gen(() =>
      updateWorkspaceHandler({
        safeDb: context.safeDb,
        organizationId: context.organizationId,
        workspaceId,
        recordAuditEvent,
        body: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.reference === undefined
            ? {}
            : { reference: input.reference }),
          ...(input.billing_reference === undefined
            ? {}
            : { billingReference: input.billing_reference }),
        },
      }),
    );
    if (Result.isError(updated)) {
      return internalFailureResult(updated.error);
    }
  }

  if (input.status === "archived") {
    const archived = await Result.gen(() =>
      archiveWorkspaceHandler({
        safeDb: context.safeDb,
        workspaceId,
        recordAuditEvent,
      }),
    );
    if (Result.isError(archived)) {
      return internalFailureResult(archived.error);
    }
  } else if (input.status === "active") {
    const unarchived = await Result.gen(() =>
      unarchiveWorkspaceHandler({
        safeDb: context.safeDb,
        workspaceId,
        recordAuditEvent,
      }),
    );
    if (Result.isError(unarchived)) {
      return internalFailureResult(unarchived.error);
    }
  }

  return textResult({ matterId: workspaceId, updated: true });
};

// --- delete_matter ------------------------------------------------------

const deleteMatterArgsSchema = v.strictObject({
  matter_id: v.pipe(v.string(), v.minLength(1)),
  confirm: v.optional(v.boolean()),
});

const handleDeleteMatterTool: McpToolHandler = async ({ args, context }) => {
  if (!roles[context.memberRole].authorize({ workspace: ["delete"] }).success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(deleteMatterArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult({
      issues: parsed.issues,
      message: "Invalid input: expected { matter_id: string }",
    });
  }

  // The HTTP delete route sits inside the active-only workspace group, so an
  // archived matter cannot be deleted until it is unarchived; mirror that here.
  const workspaceId = ensureActiveWorkspace({
    context,
    workspaceId: parsed.output.matter_id,
  });
  if (typeof workspaceId !== "string") {
    return workspaceId;
  }

  const deleted = await Result.gen(() =>
    deleteWorkspaceHandler({
      scopedDb: context.scopedDb,
      safeDb: context.safeDb,
      workspaceId,
      organizationId: context.organizationId,
      recordAuditEvent: bindWorkspaceRecorder(context, workspaceId),
    }),
  );
  if (Result.isError(deleted)) {
    return internalFailureResult(deleted.error);
  }
  return textResult({ deleted: true });
};

// --- save_contact -------------------------------------------------------

const saveContactArgsSchema = v.pipe(
  v.strictObject({
    contact_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    type: v.optional(v.picklist(CONTACT_TYPES)),
    display_name: v.optional(
      v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
    ),
    first_name: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(256)))),
    last_name: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(256)))),
    organization_name: v.optional(
      v.nullable(v.pipe(v.string(), v.maxLength(512))),
    ),
    notes: v.optional(v.nullable(v.string())),
  }),
  // Creating (no contact_id) requires type and display_name.
  v.forward(
    v.partialCheck(
      [["contact_id"], ["type"]],
      ({ contact_id, type }) => contact_id !== undefined || type !== undefined,
      "type is required to create a contact",
    ),
    ["type"],
  ),
  v.forward(
    v.partialCheck(
      [["contact_id"], ["display_name"]],
      ({ contact_id, display_name }) =>
        contact_id !== undefined || display_name !== undefined,
      "display_name is required to create a contact",
    ),
    ["display_name"],
  ),
  // An update must request at least one change.
  v.partialCheck(
    [
      ["contact_id"],
      ["type"],
      ["display_name"],
      ["first_name"],
      ["last_name"],
      ["organization_name"],
      ["notes"],
    ],
    (i) =>
      i.contact_id === undefined ||
      i.type !== undefined ||
      i.display_name !== undefined ||
      i.first_name !== undefined ||
      i.last_name !== undefined ||
      i.organization_name !== undefined ||
      i.notes !== undefined,
    "Provide at least one field to change",
  ),
);

const handleSaveContactTool: McpToolHandler = async ({ args, context }) => {
  const parsed = v.safeParse(saveContactArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult({
      issues: parsed.issues,
      message: crossFieldOrGeneric(
        parsed.issues,
        "Invalid input: expected { contact_id?: string, type?: 'person'|'organization', display_name?: string, first_name?: string|null, last_name?: string|null, organization_name?: string|null, notes?: string|null }",
      ),
    });
  }
  const input = parsed.output;

  // Create branch.
  if (input.contact_id === undefined) {
    if (!roles[context.memberRole].authorize({ contact: ["create"] }).success) {
      return errorResult("Forbidden");
    }
    // The schema guarantees type and display_name are present on create.
    const type = input.type ?? "person";
    const displayName = input.display_name ?? "";
    const created = await Result.gen(() =>
      createContactHandler({
        safeDb: context.safeDb,
        organizationId: context.organizationId,
        userId: context.userId,
        recordAuditEvent: context.recordAuditEvent,
        body: {
          id: createSafeId<"contact">(),
          type,
          displayName,
          ...(input.first_name === undefined || input.first_name === null
            ? {}
            : { firstName: input.first_name }),
          ...(input.last_name === undefined || input.last_name === null
            ? {}
            : { lastName: input.last_name }),
          ...(input.organization_name === undefined ||
          input.organization_name === null
            ? {}
            : { organizationName: input.organization_name }),
          ...(input.notes === undefined || input.notes === null
            ? {}
            : { notes: input.notes }),
        },
      }),
    );
    if (Result.isError(created)) {
      return internalFailureResult(created.error);
    }
    return textResult({ contactId: created.value.id });
  }

  // Update branch.
  if (!roles[context.memberRole].authorize({ contact: ["update"] }).success) {
    return errorResult("Forbidden");
  }
  const contactId = brandPersistedContactId(input.contact_id);
  const updated = await Result.gen(() =>
    updateContactHandler({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
      contactId,
      recordAuditEvent: context.recordAuditEvent,
      body: {
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.display_name === undefined
          ? {}
          : { displayName: input.display_name }),
        ...(input.first_name === undefined
          ? {}
          : { firstName: input.first_name }),
        ...(input.last_name === undefined ? {} : { lastName: input.last_name }),
        ...(input.organization_name === undefined
          ? {}
          : { organizationName: input.organization_name }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      },
    }),
  );
  if (Result.isError(updated)) {
    return internalFailureResult(updated.error);
  }
  return textResult({ contactId: updated.value.id });
};

// --- delete_contact -----------------------------------------------------

const deleteContactArgsSchema = v.strictObject({
  contact_id: v.pipe(v.string(), v.minLength(1)),
  confirm: v.optional(v.boolean()),
});

const handleDeleteContactTool: McpToolHandler = async ({ args, context }) => {
  if (!roles[context.memberRole].authorize({ contact: ["delete"] }).success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(deleteContactArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult({
      issues: parsed.issues,
      message: "Invalid input: expected { contact_id: string }",
    });
  }

  const deleted = await Result.gen(() =>
    deleteContactHandler({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
      contactId: brandPersistedContactId(parsed.output.contact_id),
      recordAuditEvent: context.recordAuditEvent,
    }),
  );
  if (Result.isError(deleted)) {
    return internalFailureResult(deleted.error);
  }
  return textResult({ deleted: true });
};

// --- lookup_business_registry -------------------------------------------

const lookupBusinessRegistryArgsSchema = v.strictObject({
  registry: v.picklist(BUSINESS_REGISTRY_SLUGS),
  query: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
});

const handleLookupBusinessRegistryTool: McpToolHandler = async ({
  args,
  context,
}) => {
  if (!roles[context.memberRole].authorize({ workspace: ["read"] }).success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(lookupBusinessRegistryArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult({
      issues: parsed.issues,
      message: `Invalid input: expected { registry: one of ${BUSINESS_REGISTRY_SLUGS.join(", ")}, query: string }`,
    });
  }

  const result = await lookupBusinessRegistryShared({
    safeDb: context.safeDb,
    organizationId: context.organizationId,
    registry: parsed.output.registry,
    q: parsed.output.query,
  });
  if (Result.isError(result)) {
    return internalFailureResult(result.error);
  }
  // Passthrough: the output is public business-register data and the query is
  // caller-supplied, so no tenant-authored text needs redaction.
  return textResult(result.value);
};

// --- list_tasks ---------------------------------------------------------

/** Resolve the accessible workspace owning a task, confined to kind "task". */
type ResolvedTask =
  | { status: "ok"; workspaceId: SafeId<"workspace"> }
  | { status: "not-found" }
  | { status: "wrong-kind" };

const resolveTaskWorkspace = async ({
  context,
  taskId,
}: {
  context: McpRequestContext;
  taskId: SafeId<"entity">;
}): Promise<ResolvedTask> => {
  if (context.accessibleWorkspaceIds.length === 0) {
    return { status: "not-found" };
  }
  const entity = await context.scopedDb((tx) =>
    tx.query.entities.findFirst({
      where: {
        id: { eq: taskId },
        workspaceId: { in: context.accessibleWorkspaceIds },
      },
      columns: { workspaceId: true, kind: true },
    }),
  );
  if (!entity) {
    return { status: "not-found" };
  }
  if (entity.kind !== "task") {
    return { status: "wrong-kind" };
  }
  return { status: "ok", workspaceId: entity.workspaceId };
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

const listTasksArgsSchema = v.pipe(
  v.strictObject({
    matter_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    task_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    date_from: v.optional(v.pipe(v.string(), v.regex(ISO_DATE))),
    date_to: v.optional(v.pipe(v.string(), v.regex(ISO_DATE))),
    status: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(32))),
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
  // List mode needs a matter to scope to; detail mode uses task_id alone.
  v.forward(
    v.partialCheck(
      [["matter_id"], ["task_id"]],
      ({ matter_id, task_id }) =>
        task_id !== undefined || matter_id !== undefined,
      "Provide matter_id to list tasks, or task_id to read one task",
    ),
    ["matter_id"],
  ),
);

const decodeTaskPageCursor = (
  cursor: string,
): { createdAt: string; id: SafeId<"entity"> } | null => {
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 2) {
    return null;
  }
  const [createdAt, id] = parts;
  if (typeof createdAt !== "string" || typeof id !== "string") {
    return null;
  }
  return { createdAt, id: brandPersistedEntityId(id) };
};

const readTaskDetail = async ({
  context,
  taskId,
  workspaceId,
}: {
  context: McpRequestContext;
  taskId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
}) => {
  const linkColumns = {
    id: true,
    linkType: true,
    sourceEntityId: true,
    targetEntityId: true,
  } as const;
  const linkWith = {
    sourceEntity: { columns: { id: true, name: true, kind: true } },
    targetEntity: { columns: { id: true, name: true, kind: true } },
  } as const;

  // Serialize on one scopedDb client: a single pooled connection cannot
  // multiplex concurrent queries, so these run sequentially rather than under
  // Promise.all on the shared tx.
  const { assigneeRows, linksAsSource, linksAsTarget, taskRow } =
    await context.scopedDb(async (tx) => {
      const task = await tx.query.entities.findFirst({
        where: { id: { eq: taskId }, workspaceId: { eq: workspaceId } },
        columns: {
          id: true,
          name: true,
          status: true,
          priority: true,
          dueDate: true,
          startAt: true,
          endAt: true,
          location: true,
          agendaKind: true,
        },
      });

      const assignees = await tx.query.taskAssignees.findMany({
        where: {
          entityId: { eq: taskId },
          workspaceId: { eq: workspaceId },
        },
        columns: { role: true },
        with: { user: { columns: { id: true, name: true } } },
        limit: LIMITS.workspaceMembersCount,
      });
      const outgoing = await tx.query.entityLinks.findMany({
        where: {
          workspaceId: { eq: workspaceId },
          sourceEntityId: { eq: taskId },
        },
        columns: linkColumns,
        with: linkWith,
        limit: LIMITS.taskEntityLinksPerDirectionMax,
      });

      const incoming = await tx.query.entityLinks.findMany({
        where: {
          workspaceId: { eq: workspaceId },
          targetEntityId: { eq: taskId },
        },
        columns: linkColumns,
        with: linkWith,
        limit: LIMITS.taskEntityLinksPerDirectionMax,
      });
      return {
        assigneeRows: assignees,
        linksAsSource: outgoing,
        linksAsTarget: incoming,
        taskRow: task,
      };
    });

  return {
    taskRow,
    assigneeRows,
    linkRows: [...linksAsSource, ...linksAsTarget],
  };
};

const handleListTasksTool: McpToolHandler = async ({ args, context }) => {
  if (!roles[context.memberRole].authorize({ workspace: ["read"] }).success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(listTasksArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult({
      issues: parsed.issues,
      message: crossFieldOrGeneric(
        parsed.issues,
        "Invalid input: expected { matter_id?: string, task_id?: string, date_from?: YYYY-MM-DD, date_to?: YYYY-MM-DD, status?: string, limit?: integer, cursor?: string }",
      ),
    });
  }
  const input = parsed.output;

  // Detail mode.
  if (input.task_id !== undefined) {
    const taskId = brandPersistedEntityId(input.task_id);
    const owner = await resolveTaskWorkspace({ context, taskId });
    if (owner.status === "wrong-kind") {
      return errorResult("Not a task entity");
    }
    if (owner.status !== "ok") {
      return notFoundResult("Task not found or not accessible");
    }
    // When matter_id is also supplied it must name the task's own matter;
    // otherwise a task from a different accessible matter would be returned.
    // Mirrors the save_task pairing check.
    if (
      input.matter_id !== undefined &&
      input.matter_id !== owner.workspaceId
    ) {
      return errorResult("task_id does not belong to matter_id");
    }
    const { taskRow, assigneeRows, linkRows } = await readTaskDetail({
      context,
      taskId,
      workspaceId: owner.workspaceId,
    });
    if (!taskRow) {
      return notFoundResult("Task not found or not accessible");
    }
    const workspaceId = owner.workspaceId;

    const assignees = assigneeRows.flatMap((row) =>
      row.user === null
        ? []
        : [{ userId: row.user.id, name: row.user.name, role: row.role }],
    );
    const links = linkRows.map((row) => {
      const linked =
        row.sourceEntityId === taskId ? row.targetEntity : row.sourceEntity;
      return {
        linkId: row.id,
        linkType: row.linkType,
        direction: row.sourceEntityId === taskId ? "outgoing" : "incoming",
        entity: {
          id: linked?.id ?? null,
          name: linked?.name ?? null,
          kind: linked?.kind ?? null,
        },
      };
    });

    const task = {
      taskId: taskRow.id,
      name: taskRow.name,
      status: taskRow.status,
      priority: taskRow.priority,
      dueDate: taskRow.dueDate,
      startAt: taskRow.startAt?.toISOString() ?? null,
      endAt: taskRow.endAt?.toISOString() ?? null,
      location: taskRow.location,
      agendaKind: taskRow.agendaKind,
      assignees,
      links,
    };

    const textFields = runTextFieldSpecs(
      taskDetailTextFieldSpecs(workspaceId),
      {
        task,
      },
    );

    return { egress: "structured", payload: { task }, textFields };
  }

  // List mode. matter_id is guaranteed present by the schema.
  const matterId = input.matter_id ?? "";
  const workspaceId = ensureWorkspaceAccess({ context, workspaceId: matterId });
  if (!workspaceId) {
    return notFoundResult("Matter not found or not accessible");
  }

  let boundary: { createdAt: string; id: SafeId<"entity"> } | null = null;
  if (input.cursor !== undefined) {
    boundary = decodeTaskPageCursor(input.cursor);
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
      .select({
        createdAt: entityListTimestampCursorExpr(sql`${entities.createdAt}`),
        id: entities.id,
        name: entities.name,
        status: entities.status,
        priority: entities.priority,
        dueDate: entities.dueDate,
      })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          eq(entities.kind, "task"),
          input.status === undefined
            ? undefined
            : eq(entities.status, input.status),
          input.date_from === undefined
            ? undefined
            : gte(entities.dueDate, input.date_from),
          input.date_to === undefined
            ? undefined
            : lte(entities.dueDate, input.date_to),
          entityListCursorCondition(boundary),
        ),
      )
      .orderBy(asc(entities.createdAt), asc(entities.id))
      .limit(limit + 1),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) => encodePaginationCursor([item.createdAt, item.id]),
  });

  const tasks = page.items.map(({ createdAt: _createdAt, ...task }) => task);

  const textFields = runTextFieldSpecs(taskListTextFieldSpecs(workspaceId), {
    tasks,
  });

  return {
    egress: "structured",
    payload: { tasks, nextCursor: page.nextCursor },
    textFields,
  };
};

// --- save_task ----------------------------------------------------------

const saveTaskArgsSchema = v.pipe(
  v.strictObject({
    task_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    matter_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(255))),
    status: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(32))),
    priority: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(16))),
    due_date: v.optional(v.nullable(v.pipe(v.string(), v.regex(ISO_DATE)))),
    add_assignee_user_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    remove_assignee_user_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    link_entity_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    unlink_link_id: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  // Creating (no task_id) requires matter_id and name.
  v.forward(
    v.partialCheck(
      [["task_id"], ["matter_id"]],
      ({ task_id, matter_id }) =>
        task_id !== undefined || matter_id !== undefined,
      "matter_id is required to create a task",
    ),
    ["matter_id"],
  ),
  v.forward(
    v.partialCheck(
      [["task_id"], ["name"]],
      ({ task_id, name }) => task_id !== undefined || name !== undefined,
      "name is required to create a task",
    ),
    ["name"],
  ),
  // Assignee/link operations and matter_id only apply to an existing task.
  v.partialCheck(
    [
      ["task_id"],
      ["add_assignee_user_id"],
      ["remove_assignee_user_id"],
      ["link_entity_id"],
      ["unlink_link_id"],
      ["matter_id"],
    ],
    (i) =>
      i.task_id !== undefined ||
      (i.add_assignee_user_id === undefined &&
        i.remove_assignee_user_id === undefined &&
        i.link_entity_id === undefined &&
        i.unlink_link_id === undefined),
    "assignee and link changes require task_id (they apply to an existing task)",
  ),
  // An update must request at least one action.
  v.partialCheck(
    [
      ["task_id"],
      ["name"],
      ["status"],
      ["priority"],
      ["due_date"],
      ["add_assignee_user_id"],
      ["remove_assignee_user_id"],
      ["link_entity_id"],
      ["unlink_link_id"],
    ],
    (i) =>
      i.task_id === undefined ||
      i.name !== undefined ||
      i.status !== undefined ||
      i.priority !== undefined ||
      i.due_date !== undefined ||
      i.add_assignee_user_id !== undefined ||
      i.remove_assignee_user_id !== undefined ||
      i.link_entity_id !== undefined ||
      i.unlink_link_id !== undefined,
    "Provide at least one change to the task",
  ),
);

/**
 * Validate a save_task link_entity_id target: not the task itself, exists in
 * the matter with a linkable kind, not itself a read-only task, and not
 * already linked to the task in either direction. Mirrors every rejection in
 * entity-links-create.ts. Returns an error result, or null when valid.
 */
const validateLinkTarget = async ({
  context,
  linkEntityId,
  taskId,
  workspaceId,
}: {
  context: McpRequestContext;
  linkEntityId: string;
  taskId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
}): Promise<ReturnType<typeof errorResult> | null> => {
  const linkTargetId = brandPersistedEntityId(linkEntityId);
  if (linkTargetId === taskId) {
    return errorResult("Cannot link an entity to itself");
  }
  const target = await context.scopedDb((tx) =>
    tx.query.entities.findFirst({
      where: { id: { eq: linkTargetId }, workspaceId: { eq: workspaceId } },
      columns: { kind: true, readOnly: true },
    }),
  );
  if (!target) {
    return notFoundResult("Link target entity not found in this matter");
  }
  if (!includes(LINKABLE_ENTITY_KINDS, target.kind)) {
    return errorResult("Link target must be a document, folder, or task");
  }
  if (target.kind === "task" && target.readOnly) {
    return errorResult("Task is read-only");
  }
  // One query for both directions; a single scopedDb client must not run
  // concurrent queries (see the serialized task-detail reads above).
  const existingLink = await context.scopedDb((tx) =>
    tx.query.entityLinks.findFirst({
      where: {
        workspaceId: { eq: workspaceId },
        OR: [
          {
            sourceEntityId: { eq: taskId },
            targetEntityId: { eq: linkTargetId },
          },
          {
            sourceEntityId: { eq: linkTargetId },
            targetEntityId: { eq: taskId },
          },
        ],
      },
      columns: { id: true },
    }),
  );
  if (existingLink) {
    return errorResult("A link between these entities already exists");
  }
  return null;
};

/**
 * Validate a save_task unlink_link_id target: exists in the matter, belongs
 * to this task, and the entity on the other end of the link is not itself a
 * read-only task. Mirrors every rejection in entity-links-delete.ts. Returns
 * an error result, or null when valid.
 */
const validateUnlinkTarget = async ({
  context,
  taskId,
  unlinkLinkId,
  workspaceId,
}: {
  context: McpRequestContext;
  taskId: SafeId<"entity">;
  unlinkLinkId: string;
  workspaceId: SafeId<"workspace">;
}): Promise<ReturnType<typeof errorResult> | null> => {
  const linkId = brandPersistedEntityLinkId(unlinkLinkId);
  const link = await context.scopedDb((tx) =>
    tx.query.entityLinks.findFirst({
      where: { id: { eq: linkId }, workspaceId: { eq: workspaceId } },
      columns: { sourceEntityId: true, targetEntityId: true },
      with: {
        sourceEntity: { columns: { kind: true, readOnly: true } },
        targetEntity: { columns: { kind: true, readOnly: true } },
      },
    }),
  );
  if (!link) {
    return notFoundResult("Entity-link not found in this matter");
  }
  if (link.sourceEntityId !== taskId && link.targetEntityId !== taskId) {
    return errorResult("unlink_link_id does not belong to this task");
  }
  // The task side is already covered by the read-only check in
  // validateSaveTaskTargets; the other side of the link can also be a
  // read-only task, which deleteEntityLinkHandler rejects on too.
  const other =
    link.sourceEntityId === taskId ? link.targetEntity : link.sourceEntity;
  if (other?.kind === "task" && other.readOnly) {
    return errorResult("Task is read-only");
  }
  return null;
};

/**
 * Validate every failure-capable save_task target up front so no partial
 * mutation can commit before a later step fails. Covers the matter_id/task_id
 * pairing; the task's own read-only state, which every assignee and link
 * handler rejects on; the link target (via validateLinkTarget); assignee
 * membership; and the unlink target (via validateUnlinkTarget). Mirrors every
 * rejection in entity-links-create.ts, entity-links-delete.ts,
 * assignees-add.ts, and assignees-remove.ts so they surface before any of the
 * five backing handlers run. Not transactional: a target could change kind,
 * membership, read-only state, or existence between this check and the
 * mutation (an accepted TOCTOU window); this only removes the common
 * partial-failure mode. Returns an error result, or null when valid.
 */
const validateSaveTaskTargets = async ({
  context,
  input,
  taskId,
  workspaceId,
}: {
  context: McpRequestContext;
  input: v.InferOutput<typeof saveTaskArgsSchema>;
  taskId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
}): Promise<ReturnType<typeof errorResult> | null> => {
  // matter_id is optional on update; when given it must name the task's matter.
  if (input.matter_id !== undefined && input.matter_id !== workspaceId) {
    return errorResult("task_id does not belong to matter_id");
  }

  // Every assignee/link handler rejects once the task itself is read-only
  // (e.g. a task imported from an external agenda source). Field-only edits
  // are validated atomically inside updateTaskHandler itself, so they do not
  // need a duplicate check here.
  if (
    input.add_assignee_user_id !== undefined ||
    input.remove_assignee_user_id !== undefined ||
    input.link_entity_id !== undefined ||
    input.unlink_link_id !== undefined
  ) {
    const task = await context.scopedDb((tx) =>
      tx.query.entities.findFirst({
        where: { id: { eq: taskId }, workspaceId: { eq: workspaceId } },
        columns: { readOnly: true },
      }),
    );
    if (task?.readOnly) {
      return errorResult("Task is read-only");
    }
  }

  if (input.link_entity_id !== undefined) {
    const linkError = await validateLinkTarget({
      context,
      linkEntityId: input.link_entity_id,
      taskId,
      workspaceId,
    });
    if (linkError) {
      return linkError;
    }
  }

  if (input.add_assignee_user_id !== undefined) {
    const userId = brandPersistedUserId(input.add_assignee_user_id);
    const member = await context.scopedDb((tx) =>
      tx.query.workspaceMembers.findFirst({
        where: { workspaceId: { eq: workspaceId }, userId: { eq: userId } },
        columns: { id: true },
      }),
    );
    if (!member) {
      return errorResult("add_assignee_user_id is not a member of this matter");
    }
  }

  if (input.unlink_link_id !== undefined) {
    const unlinkError = await validateUnlinkTarget({
      context,
      taskId,
      unlinkLinkId: input.unlink_link_id,
      workspaceId,
    });
    if (unlinkError) {
      return unlinkError;
    }
  }

  return null;
};

const handleSaveTaskTool: McpToolHandler = async ({ args, context }) => {
  const parsed = v.safeParse(saveTaskArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult({
      issues: parsed.issues,
      message: crossFieldOrGeneric(
        parsed.issues,
        "Invalid input: expected { task_id?, matter_id?, name?, status?, priority?, due_date?, add_assignee_user_id?, remove_assignee_user_id?, link_entity_id?, unlink_link_id? }",
      ),
    });
  }
  const input = parsed.output;

  // Create branch.
  if (input.task_id === undefined) {
    if (!roles[context.memberRole].authorize({ entity: ["create"] }).success) {
      return errorResult("Forbidden");
    }
    const workspaceId = ensureActiveWorkspace({
      context,
      workspaceId: input.matter_id ?? "",
    });
    if (typeof workspaceId !== "string") {
      return workspaceId;
    }
    const created = await Result.gen(() =>
      createTaskEntityHandler({
        safeDb: context.safeDb,
        workspaceId,
        userId: context.userId,
        recordAuditEvent: bindWorkspaceRecorder(context, workspaceId),
        body: {
          name: input.name ?? "",
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.due_date === undefined ? {} : { dueDate: input.due_date }),
        },
      }),
    );
    if (Result.isError(created)) {
      return internalFailureResult(created.error);
    }
    return textResult({ taskId: created.value.entityId });
  }

  // Update branch.
  if (!roles[context.memberRole].authorize({ entity: ["update"] }).success) {
    return errorResult("Forbidden");
  }
  const taskId = brandPersistedEntityId(input.task_id);
  const owner = await resolveTaskWorkspace({ context, taskId });
  if (owner.status === "wrong-kind") {
    return errorResult("Not a task entity");
  }
  if (owner.status !== "ok") {
    return notFoundResult("Task not found or not accessible");
  }
  const workspaceId = owner.workspaceId;
  // A task in an archived matter is read-only, matching the HTTP task routes
  // that sit behind the active-only workspace group.
  const active = ensureActiveWorkspace({ context, workspaceId });
  if (typeof active !== "string") {
    return active;
  }
  const recordAuditEvent = bindWorkspaceRecorder(context, workspaceId);

  const targetError = await validateSaveTaskTargets({
    context,
    input,
    taskId,
    workspaceId,
  });
  if (targetError) {
    return targetError;
  }

  if (
    input.name !== undefined ||
    input.status !== undefined ||
    input.priority !== undefined ||
    input.due_date !== undefined
  ) {
    const updated = await Result.gen(() =>
      updateTaskHandler({
        safeDb: context.safeDb,
        workspaceId,
        recordAuditEvent,
        body: {
          taskId,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.due_date === undefined ? {} : { dueDate: input.due_date }),
        },
      }),
    );
    if (Result.isError(updated)) {
      return internalFailureResult(updated.error);
    }
  }

  if (input.add_assignee_user_id !== undefined) {
    const userId = brandPersistedUserId(input.add_assignee_user_id);
    const added = await Result.gen(() =>
      addAssigneeHandler({
        safeDb: context.safeDb,
        workspaceId,
        recordAuditEvent,
        body: { taskId, userId },
      }),
    );
    if (Result.isError(added)) {
      return internalFailureResult(added.error);
    }
  }

  if (input.remove_assignee_user_id !== undefined) {
    const userId = brandPersistedUserId(input.remove_assignee_user_id);
    const removed = await Result.gen(() =>
      removeAssigneeHandler({
        safeDb: context.safeDb,
        workspaceId,
        recordAuditEvent,
        body: { taskId, userId },
      }),
    );
    if (Result.isError(removed)) {
      return internalFailureResult(removed.error);
    }
  }

  if (input.link_entity_id !== undefined) {
    const targetEntityId = brandPersistedEntityId(input.link_entity_id);
    const linked = await Result.gen(() =>
      createEntityLinkHandler({
        safeDb: context.safeDb,
        workspaceId,
        recordAuditEvent,
        body: { sourceEntityId: taskId, targetEntityId },
      }),
    );
    if (Result.isError(linked)) {
      return internalFailureResult(linked.error);
    }
  }

  if (input.unlink_link_id !== undefined) {
    const linkId = brandPersistedEntityLinkId(input.unlink_link_id);
    const unlinked = await Result.gen(() =>
      deleteEntityLinkHandler({
        safeDb: context.safeDb,
        workspaceId,
        recordAuditEvent,
        body: { linkId },
      }),
    );
    if (Result.isError(unlinked)) {
      return internalFailureResult(unlinked.error);
    }
  }

  return textResult({ taskId, updated: true });
};

// --- link_matter_contact ------------------------------------------------

const linkMatterContactArgsSchema = v.pipe(
  v.strictObject({
    matter_id: v.pipe(v.string(), v.minLength(1)),
    contact_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    role: v.optional(v.picklist(WORKSPACE_CONTACT_ROLES)),
    workspace_contact_id: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  // Exactly one target selector: contact_id (link with role, or unlink the
  // contact) or workspace_contact_id (unlink one specific link).
  v.partialCheck(
    [["contact_id"], ["workspace_contact_id"]],
    ({ contact_id, workspace_contact_id }) =>
      (contact_id === undefined) !== (workspace_contact_id === undefined),
    "Provide exactly one of contact_id or workspace_contact_id",
  ),
  // role selects the link operation, so it only pairs with contact_id.
  v.forward(
    v.partialCheck(
      [["contact_id"], ["role"]],
      ({ contact_id, role }) => role === undefined || contact_id !== undefined,
      "role only applies when linking a contact by contact_id",
    ),
    ["role"],
  ),
);

/**
 * Resolve the matter-contact link to remove. An explicit workspace_contact_id
 * wins; otherwise the (matter, contact) row is looked up. A contact can hold
 * several roles on one matter (several rows), so contact_id alone is ambiguous
 * and the caller is told to pass workspace_contact_id. Returns the resolved id
 * or an error result.
 */
const resolveUnlinkWorkspaceContactId = async ({
  contactId,
  context,
  workspaceContactId,
  workspaceId,
}: {
  contactId: string | undefined;
  context: McpRequestContext;
  workspaceContactId: string | undefined;
  workspaceId: SafeId<"workspace">;
}): Promise<SafeId<"workspaceContact"> | ReturnType<typeof errorResult>> => {
  if (workspaceContactId !== undefined) {
    return brandPersistedWorkspaceContactId(workspaceContactId);
  }
  // contact_id is guaranteed present by the schema when role is absent.
  const contact = brandPersistedContactId(contactId ?? "");
  const rows = await context.scopedDb((tx) =>
    tx.query.workspaceContacts.findMany({
      where: {
        workspaceId: { eq: workspaceId },
        contactId: { eq: contact },
      },
      columns: { id: true },
      limit: 2,
    }),
  );
  const first = rows.at(0);
  if (!first) {
    return errorResult("No matter-contact link found for that contact");
  }
  if (rows.length > 1) {
    return errorResult(
      "That contact holds multiple roles on the matter; pass workspace_contact_id to remove one link",
    );
  }
  return brandPersistedWorkspaceContactId(first.id);
};

const handleLinkMatterContactTool: McpToolHandler = async ({
  args,
  context,
}) => {
  if (!roles[context.memberRole].authorize({ workspace: ["update"] }).success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(linkMatterContactArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult({
      issues: parsed.issues,
      message: crossFieldOrGeneric(
        parsed.issues,
        "Invalid input: expected { matter_id: string, contact_id?: string, role?: string, workspace_contact_id?: string }",
      ),
    });
  }
  const input = parsed.output;

  const workspaceId = ensureActiveWorkspace({
    context,
    workspaceId: input.matter_id,
  });
  if (typeof workspaceId !== "string") {
    return workspaceId;
  }
  const recordAuditEvent = bindWorkspaceRecorder(context, workspaceId);

  // Unlink branch: absence of role means remove an existing link.
  if (input.role === undefined) {
    const workspaceContactId = await resolveUnlinkWorkspaceContactId({
      contactId: input.contact_id,
      context,
      workspaceContactId: input.workspace_contact_id,
      workspaceId,
    });
    if (typeof workspaceContactId !== "string") {
      return workspaceContactId;
    }
    const removed = await Result.gen(() =>
      deleteWorkspaceContactHandler({
        safeDb: context.safeDb,
        workspaceId,
        workspaceContactId,
        recordAuditEvent,
      }),
    );
    if (Result.isError(removed)) {
      return internalFailureResult(removed.error);
    }
    return textResult({ unlinked: true });
  }

  // Link branch. The schema guarantees contact_id is present alongside role.
  // Bind role to a local so its narrowed (non-undefined) type survives inside
  // the handler closure.
  const role = input.role;
  const created = await Result.gen(() =>
    createWorkspaceContactHandler({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
      workspaceId,
      recordAuditEvent,
      body: {
        contactId: brandPersistedContactId(input.contact_id ?? ""),
        role,
      },
    }),
  );
  if (Result.isError(created)) {
    return internalFailureResult(created.error);
  }
  return textResult({ workspaceContactId: created.value.id });
};

export const MATTER_TOOL_HANDLERS = {
  save_matter: handleSaveMatterTool,
  delete_matter: handleDeleteMatterTool,
  save_contact: handleSaveContactTool,
  delete_contact: handleDeleteContactTool,
  lookup_business_registry: handleLookupBusinessRegistryTool,
  list_tasks: handleListTasksTool,
  save_task: handleSaveTaskTool,
  link_matter_contact: handleLinkMatterContactTool,
} satisfies Record<MatterToolName, McpToolHandler>;

export const MATTER_TOOL_SET = defineMcpToolSet(
  MATTER_TOOL_DEFINITIONS,
  MATTER_TOOL_HANDLERS,
);
