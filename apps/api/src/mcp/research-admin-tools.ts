import { Result } from "better-result";
import * as v from "valibot";

import { AUDIT_CHANGES_STATUS } from "@stll/api-contract/audit-log";
import { BOE_SEARCH_PAGE_LIMITS, RELATION_TYPES } from "@stll/boe";
import { parsePlainDate } from "@stll/time";

import { DOCUMENT_PROCESSING_MODES } from "@/api/db/schema";
import {
  type AuditLogFilter,
  queryAuditLogPage,
  validateAuditLogFilter,
} from "@/api/handlers/audit-logs/query";
import { mapBoeError } from "@/api/handlers/legislation/boe-error";
import { updateOrganizationSettingsHandler } from "@/api/handlers/organization-settings/update";
import { addWorkspaceMemberHandler } from "@/api/handlers/workspaces/members/add";
import { removeWorkspaceMemberHandler } from "@/api/handlers/workspaces/members/remove";
import {
  MANAGE_ORGANIZATION_ADD_MEMBER_PROJECTION,
  MANAGE_ORGANIZATION_REMOVE_MEMBER_PROJECTION,
  MANAGE_ORGANIZATION_SETTINGS_PROJECTION,
  MANAGE_ORGANIZATION_PROJECTION,
  SEARCH_BOE_LEGISLATION_PROJECTION,
} from "@/api/lib/chat/projections";
import { boeClient } from "@/api/lib/legal-search/boe-client";
import { LIMITS } from "@/api/lib/limits";
import { TIME_ZONE_ID_MAX_LENGTH } from "@/api/lib/organization-time-zone";
import { projectionPayload } from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import {
  brandPersistedUserId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import type { McpRequestContext } from "@/api/mcp/context";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import { withThirdPartyOutbound } from "@/api/mcp/third-party-outbound";
import type {
  McpToolDefinition,
  McpToolHandler,
  TypedMcpToolHandler,
  TypedMcpToolResponse,
} from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import {
  bindWorkspaceRecorder,
  cursorInput,
  ensureActiveWorkspace,
  errorResult,
  internalFailureResult,
  nullAsAbsent,
  structuredErrorResult,
  toolDataResult,
  legalCitationLinkFields,
  uuidInputSchema,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import {
  defineChatProjectionMcpToolOutput,
  defineMcpToolOutput,
  defineValibotMcpTool,
} from "@/api/mcp/valibot-tool-definition";
import { selectOperationByValue } from "@/api/mcp/write-tool-authority";

type ResearchAdminToolName =
  | "search_boe_legislation"
  | "list_audit_log"
  | "manage_organization";

/** Consolidated-law relation kinds accepted by search_boe_legislation `relation_type`. */
const RELATION_TYPE_VALUES = [
  RELATION_TYPES.modifies,
  RELATION_TYPES.modifiedBy,
  RELATION_TYPES.derogates,
  RELATION_TYPES.derogatedBy,
  RELATION_TYPES.all,
] as const;

/** BOE consolidated-law identifier, e.g. BOE-A-1889-4763. Mirrors the routes. */
const BOE_LAW_ID = /^BOE-[A-Z]-\d{4}-\d+$/u;
/** BOE search date filters are YYYYMMDD (mirrors legislation/boe/search.ts). */
const BOE_DATE = /^\d{8}$/u;
/** BOE search cursor is a numeric offset (mirrors legislation/boe/search.ts). */
const BOE_OFFSET_CURSOR = /^\d{1,5}$/u;

const isBoeOffsetCursor = (value: string): boolean =>
  BOE_OFFSET_CURSOR.test(value);

/** Discriminator for the manage_organization admin write tool. */
export const MANAGE_ORG_ACTIONS = [
  "add_member",
  "remove_member",
  "update_org_settings",
] as const;

const DATE_ONLY_BOUND = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_TIMESTAMP_BOUND =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

const isRealCalendarDate = (value: string): boolean =>
  parsePlainDate(value.slice(0, 10)) !== null;

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

const listAuditLogArgsSchema = nullAsAbsent(
  v.pipe(
    v.strictObject({
      matter_id: v.optional(
        uuidInputSchema("Only entries scoped to this matter."),
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
      cursor: cursorInput({
        description:
          "Opaque cursor from a previous list_audit_log call to fetch the next page",
      }),
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
  ),
);

const LIST_AUDIT_LOG_TOOL_DEFINITION = defineValibotMcpTool({
  consumesServices: false,
  annotations: {
    title: "List audit log",
    destructiveHint: false,
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
  readClass: "tenant",
  anonymized: { exposure: "excluded", reason: "dynamic_tenant_payload" },
  name: "list_audit_log",
  scope: "stella:admin_read",
});

const LIST_AUDIT_LOG_OUTPUT_SCHEMA = v.strictObject({
  items: v.array(
    v.strictObject({
      id: v.string(),
      createdAt: v.string(),
      userId: v.string(),
      actor: v.string(),
      action: v.string(),
      resourceType: v.string(),
      resourceId: v.string(),
      changes: v.unknown(),
      changesStatus: v.picklist(Object.values(AUDIT_CHANGES_STATUS)),
    }),
  ),
  limit: v.pipe(v.number(), v.integer()),
  nextCursor: v.nullable(v.string()),
});

// --- search_boe_legislation -------------------------------------------------

const searchBoeLegislationArgsSchema = nullAsAbsent(
  v.pipe(
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
          v.description(
            "Only laws published on or before this date (YYYYMMDD)",
          ),
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
      cursor: cursorInput({
        description:
          "Opaque cursor from a previous search_boe_legislation call for the next page",
        // The one surface not paginated by a base64 codec: the BOE numbers its
        // own pages, so the offset it issued is what a continuation echoes.
        // The offset's own width lives in the reader rather than in a declared
        // maxLength, so a made-up value wider than an offset is read as no
        // cursor instead of refused for being too long.
        issuedBy: isBoeOffsetCursor,
      }),
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
        ({ law_id, block_id }) =>
          block_id === undefined || law_id !== undefined,
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
  ),
);

const SEARCH_BOE_LEGISLATION_TOOL_DEFINITION = defineValibotMcpTool({
  consumesServices: true,
  annotations: {
    title: "Search BOE legislation",
    destructiveHint: false,
    readOnlyHint: true,
    openWorldHint: true,
  },
  description:
    "Search and read Spanish consolidated legislation from the BOE. Search hits return the publisher link as primary `url`. In " +
    "search mode, pass query (free text) and/or filters (title, " +
    "department_code, legal_range_code, matter_code, date_from/date_to as " +
    "YYYYMMDD); at least one filter is required. In read mode, pass law_id " +
    "(e.g. BOE-A-1889-4763) to return the law with its block structure; add " +
    "full_text to include the consolidated text, block_id to return one " +
    "text block, or relation_type to list related laws instead. Returns " +
    "public statutory data.",
  inputSchema: searchBoeLegislationArgsSchema,
  jsonSchemaProjectionWaiver: {
    ignoreActions: ["regex", "partial_check"],
    reason:
      "BOE date/id/cursor patterns and the law_id read/search mode rules remain authoritative in the runtime schema; the wire schema only advertises type and length bounds.",
  },
  access: "read",
  readClass: "public",
  anonymized: { exposure: "passthrough" },
  feature: "FEATURE_PUBLIC_LAW",
  name: "search_boe_legislation",
  scope: "stella:read",
});

const handleSearchBoeLegislationTool = withThirdPartyOutbound<
  v.InferInput<typeof SEARCH_BOE_LEGISLATION_PROJECTION>
>(async ({ args, context, permit }) => {
  if (!hasEffectiveAuthority(context, { workspace: ["read"] })) {
    return errorResult("Forbidden");
  }
  const boe = boeClient(permit);

  const parsed = v.safeParse(searchBoeLegislationArgsSchema, args);
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
          await (
            context.testDependencies?.getLawTextBlock ?? boe.getLawTextBlock
          )(lawId, blockId),
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
        try: async () => await boe.findRelatedLaws(lawId, relationType),
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
          boe.getConsolidatedLaw(lawId, {
            metadata: true,
            ...(includeFullText ? { fullText: true } : {}),
          }),
          boe.getLawStructure(lawId),
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
  // agent-input-normalization-ignore: cursor is an opaque server token, not a
  // caller-authored numeric field; decoding it remains owned by this tool.
  const offset =
    input.cursor === undefined ? undefined : Number.parseInt(input.cursor, 10);
  const result = await Result.tryPromise({
    try: async () =>
      await (
        context.testDependencies?.searchConsolidatedLegislation ??
        boe.searchConsolidatedLegislation
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
        limit: normalizeTenantPageLimit(
          input.limit ?? BOE_SEARCH_PAGE_LIMITS.default,
        ),
        ...(offset === undefined ? {} : { offset }),
      }),
    catch: mapBoeError,
  });
  if (Result.isError(result)) {
    return internalFailureResult(result.error);
  }
  // Publisher search has no held corpus identity. Its existing source URL
  // remains primary through the same citation resolver as corpus reads.
  const { data, ...envelope } = result.value;
  const payload = {
    ...envelope,
    ...(data === undefined
      ? {}
      : {
          data: data.map((item) => {
            const { url } = legalCitationLinkFields({
              appUrl: null,
              sourceUrl: item.url_html_consolidada ?? item.url_eli ?? null,
            });
            return { ...item, url };
          }),
        }),
  };
  return toolDataResult(
    projectionPayload(SEARCH_BOE_LEGISLATION_PROJECTION, payload),
  );
});

// --- list_audit_log -----------------------------------------------------

const handleListAuditLogTool: McpToolHandler<
  v.InferInput<typeof LIST_AUDIT_LOG_OUTPUT_SCHEMA>
> = async ({ args, context }) => {
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
      userId: context.userId,
      featureAccessSnapshot: context.featureAccessSnapshot,
      recordAuditEvent: context.recordAuditEvent,
      query: filter,
    }),
  );
  if (Result.isError(page)) {
    return internalFailureResult(page.error);
  }
  return toolDataResult(
    projectionPayload(LIST_AUDIT_LOG_OUTPUT_SCHEMA, {
      ...page.value,
      items: page.value.items.map((item) => ({
        id: item.id,
        createdAt: item.createdAt.toISOString(),
        userId: item.userId,
        actor: item.actor,
        action: item.action,
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        changes: item.changes,
        changesStatus: item.changesStatus,
      })),
    }),
  );
};

// --- manage_organization ------------------------------------------------

const manageOrganizationArgsSchema = nullAsAbsent(
  v.pipe(
    v.strictObject({
      action: v.pipe(
        v.picklist(MANAGE_ORG_ACTIONS),
        v.description("Administrative action to perform"),
      ),
      matter_id: v.optional(
        uuidInputSchema("Matter ID for add_member and remove_member."),
      ),
      user_id: v.optional(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.description("User id to add or remove for the member actions"),
        ),
      ),
      reassign_to: v.optional(
        v.pipe(
          v.string(),
          v.nonEmpty(),
          v.description(
            "Replacement matter member for remove_member; omit to leave tasks unassigned",
          ),
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
          v.description("Toggle AI prompt caching (update_org_settings)"),
        ),
      ),
      document_processing_mode: v.optional(
        v.pipe(
          v.picklist(DOCUMENT_PROCESSING_MODES),
          v.description(
            "Set automatic PDF searchable-text extraction (update_org_settings)",
          ),
        ),
      ),
      time_minimum_unit_minutes: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(60),
          v.description(
            "Minimum time increment in minutes; must divide 60 (update_org_settings)",
          ),
        ),
      ),
      time_edit_window_days: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(0),
          v.description(
            "Days a timekeeper may edit an entry (update_org_settings)",
          ),
        ),
      ),
      time_locked_through_month: v.optional(
        v.pipe(
          v.nullable(v.pipe(v.string(), v.isoDate())),
          v.description(
            "Last day of the latest locked month, or null to unlock (update_org_settings)",
          ),
        ),
      ),
      time_narrative_required: v.optional(
        v.pipe(
          v.boolean(),
          v.description(
            "Require a narrative on time entries (update_org_settings)",
          ),
        ),
      ),
      time_zone: v.optional(
        v.pipe(
          v.nullable(
            v.pipe(
              v.string(),
              v.nonEmpty(),
              v.maxLength(TIME_ZONE_ID_MAX_LENGTH),
            ),
          ),
          v.description(
            "IANA time zone, e.g. Europe/Prague; null follows the primary " +
              "practice jurisdiction",
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
    v.partialCheck(
      [["action"], ["reassign_to"]],
      ({ action, reassign_to }) =>
        action === "remove_member" || reassign_to === undefined,
      "reassign_to is only supported for remove_member",
    ),
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
        ["time_minimum_unit_minutes"],
        ["time_edit_window_days"],
        ["time_locked_through_month"],
        ["time_narrative_required"],
        ["time_zone"],
      ],
      (i) =>
        i.action === "update_org_settings" ||
        (i.matter_number_pattern === undefined &&
          i.matter_number_padding === undefined &&
          i.prompt_caching_enabled === undefined &&
          i.document_processing_mode === undefined &&
          i.time_minimum_unit_minutes === undefined &&
          i.time_edit_window_days === undefined &&
          i.time_locked_through_month === undefined &&
          i.time_narrative_required === undefined &&
          i.time_zone === undefined),
      "Settings fields apply only to update_org_settings",
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
        ["time_minimum_unit_minutes"],
        ["time_edit_window_days"],
        ["time_locked_through_month"],
        ["time_narrative_required"],
        ["time_zone"],
      ],
      (i) =>
        i.action !== "update_org_settings" ||
        i.matter_number_pattern !== undefined ||
        i.matter_number_padding !== undefined ||
        i.prompt_caching_enabled !== undefined ||
        i.document_processing_mode !== undefined ||
        i.time_minimum_unit_minutes !== undefined ||
        i.time_edit_window_days !== undefined ||
        i.time_locked_through_month !== undefined ||
        i.time_narrative_required !== undefined ||
        i.time_zone !== undefined,
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
  ),
);

const MANAGE_ORGANIZATION_TOOL_DEFINITION = defineValibotMcpTool({
  consumesServices: false,
  description:
    "Manage organization members and non-secret settings. Member actions " +
    "require matter_id and user_id; the other fields apply to " +
    "update_org_settings. Manage provider secrets in the dashboard.",
  inputSchema: manageOrganizationArgsSchema,
  jsonSchemaProjectionWaiver: {
    ignoreActions: ["partial_check"],
    reason:
      "The action-conditional field requirements (member vs. settings fields, matter_number_pattern/padding pairing) remain authoritative in the runtime schema.",
  },
  annotations: {
    title: "Manage organization",
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
    readOnlyHint: false,
  },
  access: "write",
  accountAccess: "account-control",
  permissions: selectOperationByValue<(typeof MANAGE_ORG_ACTIONS)[number]>(
    "action",
    {
      add_member: {
        operation: "add_member",
        permissions: { workspace: ["update"] },
      },
      remove_member: {
        operation: "remove_member",
        permissions: { workspace: ["update"] },
      },
      update_org_settings: {
        operation: "update_org_settings",
        permissions: { organizationSettings: ["update"] },
      },
    },
  ),
  anonymized: { exposure: "excluded", reason: "write" },
  destructiveBehavior: {
    type: "input-discriminator",
    property: "action",
    destructiveValues: ["remove_member"],
  },
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
}): Promise<
  TypedMcpToolResponse<
    v.InferInput<typeof MANAGE_ORGANIZATION_ADD_MEMBER_PROJECTION>
  >
> => {
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
  return toolDataResult(
    projectionPayload(MANAGE_ORGANIZATION_ADD_MEMBER_PROJECTION, {
      memberId: added.value.id,
    }),
  );
};

const handleRemoveMember = async ({
  context,
  requestedWorkspaceId,
  userId,
  reassignTo,
}: {
  context: McpRequestContext;
  requestedWorkspaceId: string;
  userId: string;
  reassignTo?: string | undefined;
}): Promise<
  TypedMcpToolResponse<
    v.InferInput<typeof MANAGE_ORGANIZATION_REMOVE_MEMBER_PROJECTION>
  >
> => {
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
      reassignTo:
        reassignTo === undefined ? undefined : brandPersistedUserId(reassignTo),
      recordAuditEvent: bindWorkspaceRecorder(context, workspaceId),
    }),
  );
  if (Result.isError(removed)) {
    return internalFailureResult(removed.error);
  }
  return toolDataResult(
    projectionPayload(MANAGE_ORGANIZATION_REMOVE_MEMBER_PROJECTION, {
      removed: true,
      id: removed.value.id,
    }),
  );
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
    // matter_id and user_id are guaranteed present by the schema.
    return await handleRemoveMember({
      context,
      requestedWorkspaceId: input.matter_id ?? "",
      userId: input.user_id ?? "",
      reassignTo: input.reassign_to,
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
        ...(input.time_minimum_unit_minutes === undefined
          ? {}
          : { timeMinimumUnitMinutes: input.time_minimum_unit_minutes }),
        ...(input.time_edit_window_days === undefined
          ? {}
          : { timeEditWindowDays: input.time_edit_window_days }),
        ...(input.time_locked_through_month === undefined
          ? {}
          : { timeLockedThroughMonth: input.time_locked_through_month }),
        ...(input.time_narrative_required === undefined
          ? {}
          : { timeNarrativeRequired: input.time_narrative_required }),
        ...(input.time_zone === undefined ? {} : { timeZone: input.time_zone }),
      },
    }),
  );
  if (Result.isError(updated)) {
    return internalFailureResult(updated.error);
  }
  return toolDataResult(
    projectionPayload(MANAGE_ORGANIZATION_SETTINGS_PROJECTION, updated.value),
  );
};

export const RESEARCH_ADMIN_TOOL_DEFINITIONS = [
  SEARCH_BOE_LEGISLATION_TOOL_DEFINITION,
  LIST_AUDIT_LOG_TOOL_DEFINITION,
  MANAGE_ORGANIZATION_TOOL_DEFINITION,
] as const satisfies readonly McpToolDefinition[];

export const RESEARCH_ADMIN_TOOL_HANDLERS = {
  search_boe_legislation: handleSearchBoeLegislationTool,
  list_audit_log: handleListAuditLogTool,
  manage_organization: handleManageOrganizationTool,
} satisfies Record<ResearchAdminToolName, McpToolHandler>;

export const RESEARCH_ADMIN_TOOL_SET = defineMcpToolSet(
  RESEARCH_ADMIN_TOOL_DEFINITIONS,
  RESEARCH_ADMIN_TOOL_HANDLERS,
  {
    list_audit_log: defineMcpToolOutput(LIST_AUDIT_LOG_OUTPUT_SCHEMA),
    manage_organization: defineChatProjectionMcpToolOutput(
      MANAGE_ORGANIZATION_PROJECTION,
    ),
    search_boe_legislation: defineChatProjectionMcpToolOutput(
      SEARCH_BOE_LEGISLATION_PROJECTION,
    ),
  },
);
