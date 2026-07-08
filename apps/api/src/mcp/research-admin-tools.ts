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
import { roles } from "@stll/permissions";

import {
  type AuditLogFilter,
  queryAuditLogPage,
  validateAuditLogFilter,
} from "@/api/handlers/audit-logs/read";
import { mapBoeError } from "@/api/handlers/legislation/boe-error";
import { updateOrganizationSettingsHandler } from "@/api/handlers/organization-settings/update";
import { addWorkspaceMemberHandler } from "@/api/handlers/workspaces/workspace-members-add";
import { removeWorkspaceMemberHandler } from "@/api/handlers/workspaces/workspace-members-remove";
import { LIMITS } from "@/api/lib/limits";
import {
  brandPersistedUserId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import type { McpRequestContext } from "@/api/mcp/context";
import type { McpToolDefinition, McpToolHandler } from "@/api/mcp/tool-types";
import {
  bindWorkspaceRecorder,
  confirmProp,
  ensureActiveWorkspace,
  enumProp,
  errorResult,
  intProp,
  stringProp,
  structuredErrorResult,
  textResult,
} from "@/api/mcp/tool-utils";

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

export const RESEARCH_ADMIN_TOOL_DEFINITIONS = [
  {
    annotations: { readOnlyHint: true },
    description:
      "Search and read Spanish consolidated legislation from the BOE. In " +
      "search mode, pass query (free text) and/or filters (title, " +
      "department_code, legal_range_code, matter_code, date_from/date_to as " +
      "YYYYMMDD); at least one filter is required. In read mode, pass law_id " +
      "(e.g. BOE-A-1889-4763) to return the law with its block structure; add " +
      "full_text to include the consolidated text, block_id to return one " +
      "text block, or relation_type to list related laws instead. Returns " +
      "public statutory data.",
    inputSchema: {
      type: "object",
      properties: {
        query: stringProp("Free-text search over consolidated legislation", {
          maxLength: 256,
        }),
        title: stringProp("Filter search results by title text", {
          maxLength: 256,
        }),
        department_code: stringProp(
          "Filter search results by department code",
          {
            maxLength: 32,
          },
        ),
        legal_range_code: stringProp(
          "Filter search results by legal-range code (law rank)",
          { maxLength: 32 },
        ),
        matter_code: stringProp(
          "Filter search results by subject-matter code",
          {
            maxLength: 32,
          },
        ),
        date_from: stringProp(
          "Only laws published on or after this date (YYYYMMDD)",
          { maxLength: 8 },
        ),
        date_to: stringProp(
          "Only laws published on or before this date (YYYYMMDD)",
          { maxLength: 8 },
        ),
        limit: intProp("Max search results to return", { min: 1, max: 100 }),
        cursor: stringProp(
          "Opaque cursor from a previous search_legislation call for the next page",
          { maxLength: 5 },
        ),
        law_id: stringProp(
          "BOE consolidated-law id (e.g. BOE-A-1889-4763) to read; omit to search",
        ),
        block_id: stringProp(
          "With law_id, return this text block's content instead of the whole law",
          { maxLength: 128 },
        ),
        relation_type: enumProp(
          "With law_id, list related laws of this relation kind instead of the law body",
          RELATION_TYPE_VALUES,
        ),
        full_text: {
          type: "boolean",
          description:
            "With law_id (no block_id/relation_type), include the consolidated full text",
        },
      },
    },
    access: "read",
    anonymized: { exposure: "passthrough" },
    feature: "FEATURE_PUBLIC_LAW",
    name: "search_legislation",
    scope: "stella:read",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Read the organization's audit trail (compliance view). Returns audit " +
      "entries newest first, each with its action, resource type and id, actor " +
      "user id, workspace, timestamp, and change detail. Filter by workspace_id, " +
      "action, resource_type (with optional resource_id), user_id, and a " +
      "created-at range (from/to, ISO date-time). Paginate with limit and " +
      "cursor. Requires organization audit-log access.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: stringProp(
          "Only entries scoped to this matter/workspace",
        ),
        action: stringProp("Only entries with this audit action"),
        resource_type: stringProp("Only entries about this resource type"),
        resource_id: stringProp(
          "Only entries about this resource id; requires resource_type",
        ),
        user_id: stringProp("Only entries whose actor is this user"),
        from: stringProp(
          "Only entries created on or after this ISO date-time",
          { maxLength: 40 },
        ),
        to: stringProp("Only entries created on or before this ISO date-time", {
          maxLength: 40,
        }),
        limit: intProp("Max entries to return", {
          min: 1,
          max: LIMITS.auditLogPageSizeMax,
        }),
        cursor: stringProp(
          "Opaque cursor from a previous list_audit_log call to fetch the next page",
          { maxLength: 512 },
        ),
      },
    },
    // Audit payloads carry free-form tenant-authored change diffs whose text
    // fields cannot be enumerated for redaction, so this read tool fails closed
    // and never appears on the anonymized surface.
    access: "read",
    anonymized: { exposure: "excluded", reason: "dynamic_tenant_payload" },
    name: "list_audit_log",
    scope: "stella:admin_read",
  },
  {
    description:
      "Administer the organization (owner/admin actions). Set action to " +
      "add_member or remove_member to add/remove a workspace member (matter_id " +
      "and user_id required); or update_org_settings to change non-secret " +
      "organization settings: matter_number_pattern with matter_number_padding " +
      "(sent together) and/or prompt_caching_enabled. Provider API keys and " +
      "other secrets are managed only in the dashboard, not here.",
    inputSchema: {
      type: "object",
      properties: {
        action: enumProp(
          "Administrative action to perform",
          MANAGE_ORG_ACTIONS,
        ),
        matter_id: stringProp(
          "Matter/workspace id for add_member and remove_member",
        ),
        user_id: stringProp("User id to add or remove for the member actions"),
        matter_number_pattern: stringProp(
          "Matter-number pattern (update_org_settings); send with matter_number_padding",
          { maxLength: 128 },
        ),
        matter_number_padding: intProp(
          "Matter-number zero-padding width (update_org_settings); send with matter_number_pattern",
          { min: 1, max: 6 },
        ),
        prompt_caching_enabled: {
          type: "boolean",
          description:
            "Toggle AI prompt caching for the organization (update_org_settings)",
        },
        confirm: confirmProp(
          "Required for the remove_member action: must be true to remove a " +
            "member (an irreversible action). Set it only after a human user " +
            "has approved the removal; ignored by the other actions.",
        ),
      },
      required: ["action"],
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "manage_organization",
    scope: "stella:admin_write",
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

// --- search_legislation -------------------------------------------------

const searchLegislationArgsSchema = v.pipe(
  v.strictObject({
    query: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
    title: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
    department_code: v.optional(
      v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
    ),
    legal_range_code: v.optional(
      v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
    ),
    matter_code: v.optional(
      v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
    ),
    date_from: v.optional(v.pipe(v.string(), v.regex(BOE_DATE))),
    date_to: v.optional(v.pipe(v.string(), v.regex(BOE_DATE))),
    limit: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
    ),
    cursor: v.optional(
      v.pipe(v.string(), v.regex(BOE_OFFSET_CURSOR), v.maxLength(5)),
    ),
    law_id: v.optional(v.pipe(v.string(), v.regex(BOE_LAW_ID))),
    block_id: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
    relation_type: v.optional(v.picklist(RELATION_TYPE_VALUES)),
    full_text: v.optional(v.boolean()),
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

const handleSearchLegislationTool: McpToolHandler = async ({
  args,
  context,
}) => {
  if (!roles[context.memberRole].authorize({ workspace: ["read"] }).success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(searchLegislationArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      crossFieldOrGeneric(
        parsed.issues,
        "Invalid input: expected search filters (query/title/…) or law_id with optional block_id/relation_type/full_text",
      ),
    );
  }
  const input = parsed.output;

  // Read mode: a single consolidated law.
  if (input.law_id !== undefined) {
    const lawId = input.law_id;

    if (input.block_id !== undefined) {
      const blockId = input.block_id;
      const block = await Result.tryPromise({
        try: async () => await getLawTextBlock(lawId, blockId),
        catch: mapBoeError,
      });
      if (Result.isError(block)) {
        return errorResult(block.error.message);
      }
      return textResult({ lawId, blockId, block: block.value });
    }

    if (input.relation_type !== undefined) {
      const relationType = input.relation_type;
      const related = await Result.tryPromise({
        try: async () => await findRelatedLaws(lawId, relationType),
        catch: mapBoeError,
      });
      if (Result.isError(related)) {
        return errorResult(related.error.message);
      }
      return textResult(related.value);
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
      return errorResult(detail.error.message);
    }
    return textResult(detail.value);
  }

  // Search mode.
  const offset =
    input.cursor === undefined ? undefined : Number.parseInt(input.cursor, 10);
  const result = await Result.tryPromise({
    try: async () =>
      await searchConsolidatedLegislation({
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
    return errorResult(result.error.message);
  }
  // Passthrough: the output is public BOE statutory data and the query is
  // caller-supplied, so no tenant-authored text needs redaction.
  return textResult(result.value);
};

// --- list_audit_log -----------------------------------------------------

const ISO_DATE_INPUT = v.pipe(
  v.string(),
  v.minLength(1),
  v.check(
    (value) => !Number.isNaN(Date.parse(value)),
    "must be an ISO date or date-time",
  ),
);

const listAuditLogArgsSchema = v.strictObject({
  workspace_id: v.optional(v.pipe(v.string(), v.minLength(1))),
  action: v.optional(v.pipe(v.string(), v.minLength(1))),
  resource_type: v.optional(v.pipe(v.string(), v.minLength(1))),
  resource_id: v.optional(v.pipe(v.string(), v.minLength(1))),
  user_id: v.optional(v.pipe(v.string(), v.minLength(1))),
  from: v.optional(ISO_DATE_INPUT),
  to: v.optional(ISO_DATE_INPUT),
  limit: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(LIMITS.auditLogPageSizeMax),
    ),
  ),
  cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
});

const handleListAuditLogTool: McpToolHandler = async ({ args, context }) => {
  if (!roles[context.memberRole].authorize({ auditLog: ["read"] }).success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(listAuditLogArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      "Invalid input: expected { workspace_id?, action?, resource_type?, resource_id?, user_id?, from?, to?, limit?, cursor? }",
    );
  }
  const input = parsed.output;

  const filter: AuditLogFilter = {
    ...(input.workspace_id === undefined
      ? {}
      : { workspaceId: brandPersistedWorkspaceId(input.workspace_id) }),
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
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.to === undefined ? {} : { to: input.to }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  };

  // Replicate every rejection the backing read applies before querying.
  const invalid = validateAuditLogFilter(filter);
  if (invalid !== null) {
    return errorResult(invalid);
  }

  const page = await Result.gen(() =>
    queryAuditLogPage({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
      query: filter,
    }),
  );
  if (Result.isError(page)) {
    return errorResult(page.error.message);
  }
  return textResult(page.value);
};

// --- manage_organization ------------------------------------------------

const manageOrganizationArgsSchema = v.pipe(
  v.strictObject({
    action: v.picklist(MANAGE_ORG_ACTIONS),
    matter_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    user_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    matter_number_pattern: v.optional(
      v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    ),
    matter_number_padding: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)),
    ),
    prompt_caching_enabled: v.optional(v.boolean()),
    // The CLI's --yes flow injects `confirm: true` for the destructive
    // remove_member subcommand; the strictObject would otherwise reject it.
    // Other actions accept but ignore it.
    confirm: v.optional(v.boolean()),
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
    ],
    (i) =>
      i.action === "update_org_settings" ||
      (i.matter_number_pattern === undefined &&
        i.matter_number_padding === undefined &&
        i.prompt_caching_enabled === undefined),
    "matter_number_pattern, matter_number_padding, and prompt_caching_enabled apply only to update_org_settings",
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
    ],
    (i) =>
      i.action !== "update_org_settings" ||
      i.matter_number_pattern !== undefined ||
      i.matter_number_padding !== undefined ||
      i.prompt_caching_enabled !== undefined,
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

const handleAddMember = async ({
  context,
  matterId,
  userId,
}: {
  context: McpRequestContext;
  matterId: string;
  userId: string;
}) => {
  if (!roles[context.memberRole].authorize({ workspace: ["update"] }).success) {
    return errorResult("Forbidden");
  }
  const workspaceId = ensureActiveWorkspace({ context, workspaceId: matterId });
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
    return errorResult(added.error.message);
  }
  return textResult({ memberId: added.value.id });
};

const handleRemoveMember = async ({
  context,
  matterId,
  userId,
}: {
  context: McpRequestContext;
  matterId: string;
  userId: string;
}) => {
  if (!roles[context.memberRole].authorize({ workspace: ["update"] }).success) {
    return errorResult("Forbidden");
  }
  const workspaceId = ensureActiveWorkspace({ context, workspaceId: matterId });
  if (typeof workspaceId !== "string") {
    return workspaceId;
  }
  const removed = await Result.gen(() =>
    removeWorkspaceMemberHandler({
      safeDb: context.safeDb,
      workspaceId,
      userId: brandPersistedUserId(userId),
      recordAuditEvent: bindWorkspaceRecorder(context, workspaceId),
    }),
  );
  if (Result.isError(removed)) {
    return errorResult(removed.error.message);
  }
  return textResult({ removed: true, id: removed.value.id });
};

const handleManageOrganizationTool: McpToolHandler = async ({
  args,
  context,
}) => {
  const parsed = v.safeParse(manageOrganizationArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      crossFieldOrGeneric(
        parsed.issues,
        "Invalid input: expected { action: 'add_member'|'remove_member'|'update_org_settings', matter_id?, user_id?, matter_number_pattern?, matter_number_padding?, prompt_caching_enabled? }",
      ),
    );
  }
  const input = parsed.output;

  if (input.action === "add_member") {
    // matter_id and user_id are guaranteed present by the schema.
    return await handleAddMember({
      context,
      matterId: input.matter_id ?? "",
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
      context,
      matterId: input.matter_id ?? "",
      userId: input.user_id ?? "",
    });
  }

  // update_org_settings.
  if (
    !roles[context.memberRole].authorize({ organizationSettings: ["update"] })
      .success
  ) {
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
      },
    }),
  );
  if (Result.isError(updated)) {
    return errorResult(updated.error.message);
  }
  return textResult(updated.value);
};

export const RESEARCH_ADMIN_TOOL_HANDLERS = {
  search_legislation: handleSearchLegislationTool,
  list_audit_log: handleListAuditLogTool,
  manage_organization: handleManageOrganizationTool,
} satisfies Record<ResearchAdminToolName, McpToolHandler>;
