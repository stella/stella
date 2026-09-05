import { Result } from "better-result";
import * as v from "valibot";

import {
  findRelatedLaws,
  getConsolidatedLaw,
  getLawStructure,
  getLawTextBlock,
  RELATION_TYPES,
  searchConsolidatedLegislation,
} from "@stll/boe";

import { DOCUMENT_PROCESSING_MODES } from "@/api/db/schema";
import {
  type AuditLogFilter,
  queryAuditLogPage,
  validateAuditLogFilter,
} from "@/api/handlers/audit-logs/query";
import { mapBoeError } from "@/api/handlers/legislation/boe-error";
import { updateOrganizationSettingsHandler } from "@/api/handlers/organization-settings/update";
import { addWorkspaceMemberHandler } from "@/api/handlers/workspaces/workspace-members-add";
import { removeWorkspaceMemberHandler } from "@/api/handlers/workspaces/workspace-members-remove";
import type {
  AssertNoExtraFields,
  MANAGE_ORGANIZATION_ADD_MEMBER_PROJECTION,
  MANAGE_ORGANIZATION_REMOVE_MEMBER_PROJECTION,
  MANAGE_ORGANIZATION_SETTINGS_PROJECTION,
  MANAGE_ORGANIZATION_PROJECTION,
  SEARCH_LEGISLATION_PROJECTION,
} from "@/api/lib/chat/projections";
import { LIMITS } from "@/api/lib/limits";
import {
  brandPersistedUserId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import {
  bindApprovedMcpAuditContext,
  type McpRequestContext,
} from "@/api/mcp/context";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import type {
  McpToolDefinition,
  McpToolHandler,
  TypedMcpToolHandler,
} from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import {
  bindWorkspaceRecorder,
  ensureActiveWorkspace,
  errorResult,
  internalFailureResult,
  structuredErrorResult,
  toolDataResult,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import { defineValibotMcpTool } from "@/api/mcp/valibot-tool-definition";

type ResearchAdminToolName =
  | "search_legislation"
  | "list_audit_log"
  | "manage_organization";

/** Consolidated-law relation kinds accepted by search_legislation `relation_type`. */
const RELATION_TYPE_VALUES = [
  RELATION_TYPES.modifies,
  RELATION_TYPES.modifiedBy,
  RELATION_TYPES.derogates,
  RELATION_TYPES.derogatedBy,
  RELATION_TYPES.all,
] as const;

/** BOE consolidated-law identifier, e.g. BOE-A-1889-4763. Mirrors the routes. */
const BOE_LAW_ID = /^BOE-[A-Z]-\d{4}-\d+$/u;
/** BOE search date filters are YYYYMMDD (mirrors legislation/boe-search.ts). */
const BOE_DATE = /^\d{8}$/u;
/** BOE search cursor is a numeric offset (mirrors legislation/boe-search.ts). */
const BOE_OFFSET_CURSOR = /^\d+$/u;

/** Discriminator for the manage_organization admin write tool. */
const MANAGE_ORG_ACTIONS = [
  "add_member",
  "remove_member",
  "update_org_settings",
] as const;

const DATE_ONLY_BOUND = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_TIMESTAMP_BOUND =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

/**
 * Calendar validity from the components themselves: `Date` silently normalizes
 * `2026-02-31` to March, so a parsed instant proves nothing about the input.
 */
const isRealCalendarDate = (value: string): boolean => {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
};

const isRangeBound = (value: string): boolean =>
  DATE_ONLY_BOUND.test(value)
    ? isRealCalendarDate(value)
    : ISO_TIMESTAMP_BOUND.test(value) && isRealCalendarDate(value);

/** A range bound: an ISO date-time, or a date whose whole UTC day the bound covers. */
const auditRangeBoundSchema = v.pipe(
  v.string(),
  v.maxLength(40),
  v.check(isRangeBound, "Expected an ISO date-time or a YYYY-MM-DD date"),
);

/** Widen a date-only bound to the edge of its UTC day so `to: 2026-09-05` includes that day. */
const widenDateOnlyBound = (bound: string, edge: "start" | "end"): string =>
  DATE_ONLY_BOUND.test(bound)
    ? `${bound}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z`
    : bound;

const listAuditLogArgsSchema = v.pipe(
  v.strictObject({
    matter_id: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description("Only entries scoped to this matter."),
      ),
    ),
    action: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description("Only entries with this audit action"),
      ),
    ),
    resource_type: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description("Only entries about this resource type"),
      ),
    ),
    resource_id: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description(
          "Only entries about this resource id; requires resource_type",
        ),
      ),
    ),
    user_id: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description("Only entries whose actor is this user"),
      ),
    ),
    from: v.optional(
      v.pipe(
        auditRangeBoundSchema,
        v.description(
          "Only entries created on or after this ISO date-time, or from the start of this YYYY-MM-DD date (UTC)",
        ),
      ),
    ),
    to: v.optional(
      v.pipe(
        auditRangeBoundSchema,
        v.description(
          "Only entries created on or before this ISO date-time, or up to the end of this YYYY-MM-DD date (UTC)",
        ),
      ),
    ),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(LIMITS.auditLogPageSizeMax),
        v.description("Max entries to return"),
      ),
    ),
    cursor: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(512),
        v.description(
          "Opaque cursor from a previous list_audit_log call to fetch the next page",
        ),
      ),
    ),
  }),
  v.forward(
    v.partialCheck(
      [["resource_type"], ["resource_id"]],
      ({ resource_id, resource_type }) =>
        resource_id === undefined || resource_type !== undefined,
      "resourceType is required when resourceId is provided",
    ),
    ["resource_id"],
  ),
);

const LIST_AUDIT_LOG_TOOL_DEFINITION = defineValibotMcpTool({
  annotations: {
    title: "List audit log",
    readOnlyHint: true,
    openWorldHint: false,
  },
  description:
    "Read the organization's audit trail (compliance view). Returns audit " +
    "entries newest first, each with its action, resource type and id, actor " +
    "user id, matter, timestamp, and change detail. Filter by matter_id, " +
    "action, resource_type (with optional resource_id), user_id, and a " +
    "created-at range (from/to, ISO date-time). Paginate with limit and " +
    "cursor. Requires organization audit-log access.",
  inputSchema: listAuditLogArgsSchema,
  jsonSchemaProjectionWaiver: {
    ignoreActions: ["check", "partial_check"],
    reason:
      "The range-bound check (ISO date-time or date) and the resource_id dependency cannot be projected; both remain authoritative in the runtime schema.",
  },
  // Audit payloads carry free-form tenant-authored change diffs whose text
  // fields cannot be enumerated for redaction, so this read tool fails closed
  // and never appears on the anonymized surface.
  access: "read",
  anonymized: { exposure: "excluded", reason: "dynamic_tenant_payload" },
  name: "list_audit_log",
  scope: "stella:admin_read",
});

// --- search_legislation -------------------------------------------------

const searchLegislationArgsSchema = v.pipe(
  v.strictObject({
    query: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(256),
        v.description("Free-text search over consolidated legislation"),
      ),
    ),
    title: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(256),
        v.description("Filter search results by title text"),
      ),
    ),
    department_code: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(32),
        v.description("Filter search results by department code"),
      ),
    ),
    legal_range_code: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(32),
        v.description("Filter search results by legal-range code (law rank)"),
      ),
    ),
    matter_code: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(32),
        v.description("Filter search results by subject-matter code"),
      ),
    ),
    date_from: v.optional(
      v.pipe(
        v.string(),
        v.regex(BOE_DATE),
        v.maxLength(8),
        v.description("Only laws published on or after this date (YYYYMMDD)"),
      ),
    ),
    date_to: v.optional(
      v.pipe(
        v.string(),
        v.regex(BOE_DATE),
        v.maxLength(8),
        v.description("Only laws published on or before this date (YYYYMMDD)"),
      ),
    ),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(100),
        v.description("Max search results to return"),
      ),
    ),
    cursor: v.optional(
      v.pipe(
        v.string(),
        v.regex(BOE_OFFSET_CURSOR),
        v.maxLength(5),
        v.description(
          "Opaque cursor from a previous search_legislation call for the next page",
        ),
      ),
    ),
    law_id: v.optional(
      v.pipe(
        v.string(),
        v.regex(BOE_LAW_ID),
        v.description(
          "BOE consolidated-law id (e.g. BOE-A-1889-4763) to read; omit to search",
        ),
      ),
    ),
    block_id: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(128),
        v.description(
          "With law_id, return this text block's content instead of the whole law",
        ),
      ),
    ),
    relation_type: v.optional(
      v.pipe(
        v.picklist(RELATION_TYPE_VALUES),
        v.description(
          "With law_id, list related laws of this relation kind instead of the law body",
        ),
      ),
    ),
    full_text: v.optional(
      v.pipe(
        v.boolean(),
        v.description(
          "With law_id (no block_id/relation_type), include the consolidated full text",
        ),
      ),
    ),
  }),
  // block_id, relation_type, and full_text all read a specific law.
  v.forward(
    v.partialCheck(
      [["law_id"], ["block_id"]],
      ({ law_id, block_id }) => block_id === undefined || law_id !== undefined,
      "block_id requires law_id",
    ),
    ["block_id"],
  ),
  v.forward(
    v.partialCheck(
      [["law_id"], ["relation_type"]],
      ({ law_id, relation_type }) =>
        relation_type === undefined || law_id !== undefined,
      "relation_type requires law_id",
    ),
    ["relation_type"],
  ),
  v.forward(
    v.partialCheck(
      [["law_id"], ["full_text"]],
      ({ law_id, full_text }) =>
        full_text === undefined || law_id !== undefined,
      "full_text requires law_id",
    ),
    ["full_text"],
  ),
  // block_id and relation_type each replace the law body; they cannot combine.
  v.partialCheck(
    [["block_id"], ["relation_type"]],
    ({ block_id, relation_type }) =>
      block_id === undefined || relation_type === undefined,
    "Provide at most one of block_id or relation_type",
  ),
  // full_text applies to the law body, not to a single block or the relations.
  v.partialCheck(
    [["full_text"], ["block_id"], ["relation_type"]],
    ({ full_text, block_id, relation_type }) =>
      full_text === undefined ||
      (block_id === undefined && relation_type === undefined),
    "full_text does not apply with block_id or relation_type",
  ),
  // Search filters belong to search mode; a law_id selects read mode.
  v.partialCheck(
    [
      ["law_id"],
      ["query"],
      ["title"],
      ["department_code"],
      ["legal_range_code"],
      ["matter_code"],
      ["date_from"],
      ["date_to"],
      ["limit"],
      ["cursor"],
    ],
    (i) =>
      i.law_id === undefined ||
      (i.query === undefined &&
        i.title === undefined &&
        i.department_code === undefined &&
        i.legal_range_code === undefined &&
        i.matter_code === undefined &&
        i.date_from === undefined &&
        i.date_to === undefined &&
        i.limit === undefined &&
        i.cursor === undefined),
    "Search filters apply to search mode; drop law_id to search",
  ),
  // Search mode needs at least one substantive filter (mirrors boe-search).
  v.partialCheck(
    [
      ["law_id"],
      ["query"],
      ["title"],
      ["department_code"],
      ["legal_range_code"],
      ["matter_code"],
      ["date_from"],
      ["date_to"],
    ],
    (i) =>
      i.law_id !== undefined ||
      i.query !== undefined ||
      i.title !== undefined ||
      i.department_code !== undefined ||
      i.legal_range_code !== undefined ||
      i.matter_code !== undefined ||
      i.date_from !== undefined ||
      i.date_to !== undefined,
    "Provide law_id to read a law, or at least one search filter",
  ),
);

const SEARCH_LEGISLATION_TOOL_DEFINITION = defineValibotMcpTool({
  annotations: {
    title: "Search legislation",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description:
    "Search and read Spanish consolidated legislation from the BOE. In " +
    "search mode, pass query (free text) and/or filters (title, " +
    "department_code, legal_range_code, matter_code, date_from/date_to as " +
    "YYYYMMDD); at least one filter is required. In read mode, pass law_id " +
    "(e.g. BOE-A-1889-4763) to return the law with its block structure; add " +
    "full_text to include the consolidated text, block_id to return one " +
    "text block, or relation_type to list related laws instead. Returns " +
    "public statutory data.",
  inputSchema: searchLegislationArgsSchema,
  jsonSchemaProjectionWaiver: {
    ignoreActions: ["regex", "partial_check"],
    reason:
      "BOE date/id/cursor patterns and the law_id read/search mode rules remain authoritative in the runtime schema; the wire schema only advertises type and length bounds.",
  },
  access: "read",
  anonymized: { exposure: "passthrough" },
  feature: "FEATURE_PUBLIC_LAW",
  name: "search_legislation",
  scope: "stella:read",
});

const handleSearchLegislationTool: TypedMcpToolHandler<
  v.InferInput<typeof SEARCH_LEGISLATION_PROJECTION>
> = async ({ args, context }) => {
  if (!hasEffectiveAuthority(context, { workspace: ["read"] })) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(searchLegislationArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const input = parsed.output;

  // Read mode: a single consolidated law.
  if (input.law_id !== undefined) {
    const lawId = input.law_id;

    if (input.block_id !== undefined) {
      const blockId = input.block_id;
      const block = await Result.tryPromise({
        try: async () =>
          await (context.testDependencies?.getLawTextBlock ?? getLawTextBlock)(
            lawId,
            blockId,
          ),
        catch: mapBoeError,
      });
      if (Result.isError(block)) {
        return internalFailureResult(block.error);
      }
      return toolDataResult({ lawId, blockId, block: block.value });
    }

    if (input.relation_type !== undefined) {
      const relationType = input.relation_type;
      const related = await Result.tryPromise({
        try: async () => await findRelatedLaws(lawId, relationType),
        catch: mapBoeError,
      });
      if (Result.isError(related)) {
        return internalFailureResult(related.error);
      }
      return toolDataResult(related.value);
    }

    // Default read: the law plus its block structure. Both are external BOE
    // fetches with no shared DB client, so they run concurrently.
    const includeFullText = input.full_text === true;
    const detail = await Result.tryPromise({
      try: async () => {
        const [law, structure] = await Promise.all([
          getConsolidatedLaw(lawId, {
            metadata: true,
            ...(includeFullText ? { fullText: true } : {}),
          }),
          getLawStructure(lawId),
        ]);
        return { law, structure };
      },
      catch: mapBoeError,
    });
    if (Result.isError(detail)) {
      return internalFailureResult(detail.error);
    }
    return toolDataResult(detail.value);
  }

  // Search mode.
  const offset =
    input.cursor === undefined ? undefined : Number.parseInt(input.cursor, 10);
  const result = await Result.tryPromise({
    try: async () =>
      await (
        context.testDependencies?.searchConsolidatedLegislation ??
        searchConsolidatedLegislation
      )({
        ...(input.query === undefined ? {} : { text: input.query }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.department_code === undefined
          ? {}
          : { departmentCode: input.department_code }),
        ...(input.legal_range_code === undefined
          ? {}
          : { legalRangeCode: input.legal_range_code }),
        ...(input.matter_code === undefined
          ? {}
          : { matterCode: input.matter_code }),
        ...(input.date_from === undefined ? {} : { dateFrom: input.date_from }),
        ...(input.date_to === undefined ? {} : { dateTo: input.date_to }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(offset === undefined ? {} : { offset }),
      }),
    catch: mapBoeError,
  });
  if (Result.isError(result)) {
    return internalFailureResult(result.error);
  }
  // Passthrough: the output is public BOE statutory data and the query is
  // caller-supplied, so no tenant-authored text needs redaction. Forwarded
  // verbatim, so the projection tie is on the BOE client's return type.
  type SearchLegislationPayload = AssertNoExtraFields<
    typeof result.value,
    v.InferInput<typeof SEARCH_LEGISLATION_PROJECTION>
  >;
  return toolDataResult(result.value satisfies SearchLegislationPayload);
};

// --- list_audit_log -----------------------------------------------------

const handleListAuditLogTool: McpToolHandler = async ({ args, context }) => {
  if (!hasEffectiveAuthority(context, { auditLog: ["read"] })) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(
    LIST_AUDIT_LOG_TOOL_DEFINITION.inputSchemaSource,
    args,
  );
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const input = parsed.output;

  const filter: AuditLogFilter = {
    ...(input.matter_id === undefined
      ? {}
      : { workspaceId: brandPersistedWorkspaceId(input.matter_id) }),
    ...(input.action === undefined ? {} : { action: input.action }),
    ...(input.resource_type === undefined
      ? {}
      : { resourceType: input.resource_type }),
    ...(input.resource_id === undefined
      ? {}
      : { resourceId: input.resource_id }),
    ...(input.user_id === undefined
      ? {}
      : { userId: brandPersistedUserId(input.user_id) }),
    ...(input.from === undefined
      ? {}
      : { from: widenDateOnlyBound(input.from, "start") }),
    ...(input.to === undefined
      ? {}
      : { to: widenDateOnlyBound(input.to, "end") }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  };

  // Replicate every rejection the backing read applies before querying.
  const invalid = validateAuditLogFilter(filter);
  if (invalid !== null) {
    return structuredErrorResult({
      code: "validation_error",
      message: invalid,
      issues: [{ path: "", message: invalid }],
    });
  }

  const page = await Result.gen(() =>
    queryAuditLogPage({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
      recordAuditEvent: context.recordAuditEvent,
      query: filter,
    }),
  );
  if (Result.isError(page)) {
    return internalFailureResult(page.error);
  }
  return toolDataResult(page.value);
};

// --- manage_organization ------------------------------------------------

const manageOrganizationArgsSchema = v.pipe(
  v.strictObject({
    action: v.pipe(
      v.picklist(MANAGE_ORG_ACTIONS),
      v.description("Administrative action to perform"),
    ),
    matter_id: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description("Matter ID for add_member and remove_member."),
      ),
    ),
    user_id: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description("User id to add or remove for the member actions"),
      ),
    ),
    matter_number_pattern: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(128),
        v.description(
          "Matter-number pattern (update_org_settings); send with matter_number_padding",
        ),
      ),
    ),
    matter_number_padding: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(6),
        v.description(
          "Matter-number zero-padding width (update_org_settings); send with matter_number_pattern",
        ),
      ),
    ),
    prompt_caching_enabled: v.optional(
      v.pipe(
        v.boolean(),
        v.description(
          "Toggle AI prompt caching for the organization (update_org_settings)",
        ),
      ),
    ),
    document_processing_mode: v.optional(
      v.pipe(
        v.picklist(DOCUMENT_PROCESSING_MODES),
        v.description(
          "Set automatic PDF searchable-text extraction for the organization (update_org_settings)",
        ),
      ),
    ),
    // The CLI's --yes flow injects `confirm: true` for the destructive
    // remove_member subcommand; the strictObject would otherwise reject it.
    // Other actions accept but ignore it.
    confirm: v.optional(
      v.pipe(
        v.boolean(),
        v.description(
          "Required for the remove_member action: must be true to remove a " +
            "member (an irreversible action). Set it only after a human user " +
            "has approved the removal; ignored by the other actions.",
        ),
      ),
    ),
  }),
  // Member actions need a matter and a user.
  v.forward(
    v.partialCheck(
      [["action"], ["matter_id"]],
      ({ action, matter_id }) =>
        action === "update_org_settings" || matter_id !== undefined,
      "matter_id is required for add_member and remove_member",
    ),
    ["matter_id"],
  ),
  v.forward(
    v.partialCheck(
      [["action"], ["user_id"]],
      ({ action, user_id }) =>
        action === "update_org_settings" || user_id !== undefined,
      "user_id is required for add_member and remove_member",
    ),
    ["user_id"],
  ),
  // Org-settings fields belong only to update_org_settings.
  v.partialCheck(
    [
      ["action"],
      ["matter_number_pattern"],
      ["matter_number_padding"],
      ["prompt_caching_enabled"],
      ["document_processing_mode"],
    ],
    (i) =>
      i.action === "update_org_settings" ||
      (i.matter_number_pattern === undefined &&
        i.matter_number_padding === undefined &&
        i.prompt_caching_enabled === undefined &&
        i.document_processing_mode === undefined),
    "matter_number_pattern, matter_number_padding, prompt_caching_enabled, and document_processing_mode apply only to update_org_settings",
  ),
  // matter_id/user_id are meaningless for an org-settings update.
  v.partialCheck(
    [["action"], ["matter_id"], ["user_id"]],
    (i) =>
      i.action !== "update_org_settings" ||
      (i.matter_id === undefined && i.user_id === undefined),
    "matter_id and user_id do not apply to update_org_settings",
  ),
  // An org-settings update must change at least one field.
  v.partialCheck(
    [
      ["action"],
      ["matter_number_pattern"],
      ["matter_number_padding"],
      ["prompt_caching_enabled"],
      ["document_processing_mode"],
    ],
    (i) =>
      i.action !== "update_org_settings" ||
      i.matter_number_pattern !== undefined ||
      i.matter_number_padding !== undefined ||
      i.prompt_caching_enabled !== undefined ||
      i.document_processing_mode !== undefined,
    "Provide at least one setting to change for update_org_settings",
  ),
  // The matter-number pattern and padding are a unit (mirrors the backing).
  v.partialCheck(
    [["matter_number_pattern"], ["matter_number_padding"]],
    ({ matter_number_pattern, matter_number_padding }) =>
      (matter_number_pattern === undefined) ===
      (matter_number_padding === undefined),
    "matter_number_pattern and matter_number_padding must be sent together",
  ),
);

const MANAGE_ORGANIZATION_TOOL_DEFINITION = defineValibotMcpTool({
  description:
    "Manage organization members and non-secret settings. Member actions " +
    "require matter_id and user_id. update_org_settings controls matter " +
    "numbering, prompt caching, and document processing. Manage provider " +
    "secrets in the dashboard.",
  inputSchema: manageOrganizationArgsSchema,
  jsonSchemaProjectionWaiver: {
    ignoreActions: ["partial_check"],
    reason:
      "The action-conditional field requirements (member vs. settings fields, matter_number_pattern/padding pairing) remain authoritative in the runtime schema.",
  },
  annotations: {
    title: "Manage organization",
    idempotentHint: false,
    openWorldHint: false,
  },
  access: "write",
  anonymized: { exposure: "excluded", reason: "write" },
  name: "manage_organization",
  scope: "stella:admin_write",
});

const handleAddMember = async ({
  context,
  requestedWorkspaceId,
  userId,
}: {
  context: McpRequestContext;
  requestedWorkspaceId: string;
  userId: string;
}) => {
  if (!hasEffectiveAuthority(context, { workspace: ["update"] })) {
    return errorResult("Forbidden");
  }
  const workspaceId = ensureActiveWorkspace({
    context,
    workspaceId: requestedWorkspaceId,
  });
  if (typeof workspaceId !== "string") {
    return workspaceId;
  }
  const added = await Result.gen(() =>
    addWorkspaceMemberHandler({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
      workspaceId,
      recordAuditEvent: bindWorkspaceRecorder(context, workspaceId),
      body: { userId: brandPersistedUserId(userId) },
    }),
  );
  if (Result.isError(added)) {
    return internalFailureResult(added.error);
  }
  return toolDataResult({
    memberId: added.value.id,
  } satisfies v.InferInput<typeof MANAGE_ORGANIZATION_ADD_MEMBER_PROJECTION>);
};

const handleRemoveMember = async ({
  context,
  requestedWorkspaceId,
  userId,
}: {
  context: McpRequestContext;
  requestedWorkspaceId: string;
  userId: string;
}) => {
  if (!hasEffectiveAuthority(context, { workspace: ["update"] })) {
    return errorResult("Forbidden");
  }
  const workspaceId = ensureActiveWorkspace({
    context,
    workspaceId: requestedWorkspaceId,
  });
  if (typeof workspaceId !== "string") {
    return workspaceId;
  }
  const removed = await Result.gen(() =>
    removeWorkspaceMemberHandler({
      safeDb: context.safeDb,
      workspaceId,
      userId: brandPersistedUserId(userId),
      actorUserId: context.userId,
      recordAuditEvent: bindWorkspaceRecorder(context, workspaceId),
    }),
  );
  if (Result.isError(removed)) {
    return internalFailureResult(removed.error);
  }
  return toolDataResult({
    removed: true,
    id: removed.value.id,
  } satisfies v.InferInput<
    typeof MANAGE_ORGANIZATION_REMOVE_MEMBER_PROJECTION
  >);
};

const handleManageOrganizationTool: TypedMcpToolHandler<
  v.InferInput<typeof MANAGE_ORGANIZATION_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(manageOrganizationArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const input = parsed.output;

  if (input.action === "add_member") {
    // matter_id and user_id are guaranteed present by the schema.
    return await handleAddMember({
      context,
      requestedWorkspaceId: input.matter_id ?? "",
      userId: input.user_id ?? "",
    });
  }

  if (input.action === "remove_member") {
    // Action-level confirm gate: manage_organization is not `destructiveHint`
    // as a whole (it also adds members and updates settings), so the central
    // gate in tools.ts cannot cover this. Removing a member is irreversible,
    // so refuse until the human-approved `confirm: true` arrives (the CLI's
    // --yes flow injects it). Mirrors the central gate's wording.
    if (input.confirm !== true) {
      return structuredErrorResult({
        code: "confirmation_required",
        message:
          "remove_member is an irreversible operation and was called without confirmation",
        hint: "Removing a member is irreversible. Confirm with the human user, then retry with confirm: true.",
      });
    }
    // matter_id and user_id are guaranteed present by the schema.
    return await handleRemoveMember({
      context: bindApprovedMcpAuditContext(context),
      requestedWorkspaceId: input.matter_id ?? "",
      userId: input.user_id ?? "",
    });
  }

  // update_org_settings.
  if (!hasEffectiveAuthority(context, { organizationSettings: ["update"] })) {
    return errorResult("Forbidden");
  }
  const updated = await Result.gen(() =>
    updateOrganizationSettingsHandler({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
      recordAuditEvent: context.recordAuditEvent,
      body: {
        ...(input.matter_number_pattern === undefined
          ? {}
          : { matterNumberPattern: input.matter_number_pattern }),
        ...(input.matter_number_padding === undefined
          ? {}
          : { matterNumberPadding: input.matter_number_padding }),
        ...(input.prompt_caching_enabled === undefined
          ? {}
          : { promptCachingEnabled: input.prompt_caching_enabled }),
        ...(input.document_processing_mode === undefined
          ? {}
          : { documentProcessingMode: input.document_processing_mode }),
      },
    }),
  );
  if (Result.isError(updated)) {
    return internalFailureResult(updated.error);
  }
  type ManageOrganizationSettingsPayload = AssertNoExtraFields<
    typeof updated.value,
    v.InferInput<typeof MANAGE_ORGANIZATION_SETTINGS_PROJECTION>
  >;
  return toolDataResult(
    updated.value satisfies ManageOrganizationSettingsPayload,
  );
};

export const RESEARCH_ADMIN_TOOL_DEFINITIONS = [
  SEARCH_LEGISLATION_TOOL_DEFINITION,
  LIST_AUDIT_LOG_TOOL_DEFINITION,
  MANAGE_ORGANIZATION_TOOL_DEFINITION,
] as const satisfies readonly McpToolDefinition[];

export const RESEARCH_ADMIN_TOOL_HANDLERS = {
  search_legislation: handleSearchLegislationTool,
  list_audit_log: handleListAuditLogTool,
  manage_organization: handleManageOrganizationTool,
} satisfies Record<ResearchAdminToolName, McpToolHandler>;

export const RESEARCH_ADMIN_TOOL_SET = defineMcpToolSet(
  RESEARCH_ADMIN_TOOL_DEFINITIONS,
  RESEARCH_ADMIN_TOOL_HANDLERS,
);
