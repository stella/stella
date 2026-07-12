import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, desc, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { COUNTRY_CODES } from "@stll/country-codes";
import { roles } from "@stll/permissions";

import type { PracticeJurisdiction } from "@/api/db/schema";
import { workspaces } from "@/api/db/schema";
import type { ContactEmail, ContactPhone } from "@/api/db/schema-validators";
import { readDecisionHandler } from "@/api/handlers/case-law/decisions/read-by-id";
import { searchDecisionsHandler } from "@/api/handlers/case-law/decisions/search";
import { hasUsableAst } from "@/api/handlers/case-law/document-ast";
import {
  normalizePracticeJurisdictions,
  upsertPracticeJurisdictions,
} from "@/api/handlers/organization-settings/practice-jurisdictions";
import { readWorkspaceHandler } from "@/api/handlers/workspaces/read-by-id";
import { readOverviewHandler } from "@/api/handlers/workspaces/read-overview";
import { readWorkspaceContactsHandler } from "@/api/handlers/workspaces/workspace-contacts-read";
import { readWorkspaceMembersHandler } from "@/api/handlers/workspaces/workspace-members-read";
import { arrayOrEmpty } from "@/api/lib/array";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { decryptContent } from "@/api/lib/content-encryption";
import { isUuid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedCaseLawSourceId,
  brandPersistedContactId,
  brandPersistedEntityId,
} from "@/api/lib/safe-id-boundaries";
import { decodeCursor } from "@/api/lib/search/cursor";
import { getSearchProvider } from "@/api/lib/search/provider";
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
  buildCaseLawDecisionAppUrl,
  DEFAULT_LIST_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  ensureWorkspaceAccess,
  enumProp,
  errorResult,
  getAppBaseUrl,
  intProp,
  isToolErrorResult,
  MAX_LIST_LIMIT,
  MAX_SEARCH_LIMIT,
  notFoundResult,
  parseOptionalCursor,
  parseOptionalEnum,
  parseOptionalLimit,
  parseRequiredString,
  resolveWindowBounds,
  stringProp,
  structuredErrorResult,
  textResult,
  validationErrorResult,
} from "@/api/mcp/tool-utils";

const MCP_CONTENT_MAX_CHARS = 8000;
// Page size for each citation list on read_case_law_decision. The decision
// text and both citation lists are paged together by a single compound cursor.
const MCP_CASE_LAW_CITATIONS_PER_DECISION = 50;
type StellaToolName =
  | "list_matters"
  | "read_case_law_decision"
  | "read_contact"
  | "read_content_across_matters"
  | "search_case_law"
  | "search_across_matters"
  | "set_practice_jurisdictions";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

// --- Text-field specs (plan 049, Option B) --------------------------------

/**
 * list_matters, list mode: one matter per row, scoped under its own matter id
 * (a matter's workspace id IS its anonymization scope). Both fields already
 * ride in the served payload, so no external attribution is needed.
 */
type ListedMatter = { id: string; name: string; reference: string };
type ListMattersListPayload = { matters: readonly ListedMatter[] };

const LIST_MATTERS_LIST_TEXT_FIELD_SPECS: readonly McpTextFieldSpec<ListMattersListPayload>[] =
  [
    defineTextFieldSpec({
      path: "matters[].name",
      items: (payload: ListMattersListPayload) => payload.matters,
      scope: (matter: ListedMatter) => matter.id,
      read: (matter: ListedMatter) => matter.name,
      apply: (matter: ListedMatter, value) => {
        matter.name = value;
      },
    }),
    defineTextFieldSpec({
      path: "matters[].reference",
      items: (payload: ListMattersListPayload) => payload.matters,
      scope: (matter: ListedMatter) => matter.id,
      read: (matter: ListedMatter) => matter.reference,
      apply: (matter: ListedMatter, value) => {
        matter.reference = value;
      },
    }),
  ];

/**
 * list_matters, detail mode (one matter's overview): every field below
 * belongs to the one matter this response describes, so `payload.matter.id`
 * is the anonymization scope throughout — including the nested
 * entity/contact/member cards, which carry no workspace id of their own on
 * the wire. Each nested item selector pairs the item with that scope id
 * read straight off the payload, so no request-scoped closure is needed.
 */
type MatterOverviewMatter = {
  clientName: string | null;
  id: string;
  name: string;
  reference: string;
};
type MatterOverviewEntity = {
  assignedTo: string | null;
  createdBy: string | null;
  name: string;
};
type MatterOverviewContact = { displayName: string };
type MatterOverviewMember = { name: string };
type MatterOverviewPayload = {
  contacts: readonly MatterOverviewContact[];
  matter: MatterOverviewMatter;
  members: readonly MatterOverviewMember[];
  overview: { recentEntities: readonly MatterOverviewEntity[] };
};

const matterOverviewMatterItems = (
  payload: MatterOverviewPayload,
): readonly [MatterOverviewMatter] => [payload.matter];

type EntityWithScope = { entity: MatterOverviewEntity; workspaceId: string };
const matterOverviewEntityItems = (
  payload: MatterOverviewPayload,
): readonly EntityWithScope[] =>
  payload.overview.recentEntities.map((entity) => ({
    entity,
    workspaceId: payload.matter.id,
  }));

type ContactWithScope = {
  contact: MatterOverviewContact;
  workspaceId: string;
};
const matterOverviewContactItems = (
  payload: MatterOverviewPayload,
): readonly ContactWithScope[] =>
  payload.contacts.map((contact) => ({
    contact,
    workspaceId: payload.matter.id,
  }));

type MemberWithScope = { member: MatterOverviewMember; workspaceId: string };
const matterOverviewMemberItems = (
  payload: MatterOverviewPayload,
): readonly MemberWithScope[] =>
  payload.members.map((member) => ({
    member,
    workspaceId: payload.matter.id,
  }));

const MATTER_OVERVIEW_TEXT_FIELD_SPECS: readonly McpTextFieldSpec<MatterOverviewPayload>[] =
  [
    defineTextFieldSpec({
      path: "matter.name",
      items: matterOverviewMatterItems,
      scope: (matter: MatterOverviewMatter) => matter.id,
      read: (matter: MatterOverviewMatter) => matter.name,
      apply: (matter: MatterOverviewMatter, value) => {
        matter.name = value;
      },
    }),
    defineTextFieldSpec({
      path: "matter.reference",
      items: matterOverviewMatterItems,
      scope: (matter: MatterOverviewMatter) => matter.id,
      read: (matter: MatterOverviewMatter) => matter.reference,
      apply: (matter: MatterOverviewMatter, value) => {
        matter.reference = value;
      },
    }),
    defineTextFieldSpec({
      path: "matter.clientName",
      items: matterOverviewMatterItems,
      scope: (matter: MatterOverviewMatter) => matter.id,
      read: (matter: MatterOverviewMatter) => matter.clientName,
      apply: (matter: MatterOverviewMatter, value) => {
        matter.clientName = value;
      },
    }),
    defineTextFieldSpec({
      path: "overview.recentEntities[].name",
      items: matterOverviewEntityItems,
      scope: (item: EntityWithScope) => item.workspaceId,
      read: (item: EntityWithScope) => item.entity.name,
      apply: (item: EntityWithScope, value) => {
        item.entity.name = value;
      },
    }),
    defineTextFieldSpec({
      path: "overview.recentEntities[].createdBy",
      items: matterOverviewEntityItems,
      scope: (item: EntityWithScope) => item.workspaceId,
      read: (item: EntityWithScope) => item.entity.createdBy,
      apply: (item: EntityWithScope, value) => {
        item.entity.createdBy = value;
      },
    }),
    defineTextFieldSpec({
      path: "overview.recentEntities[].assignedTo",
      items: matterOverviewEntityItems,
      scope: (item: EntityWithScope) => item.workspaceId,
      read: (item: EntityWithScope) => item.entity.assignedTo,
      apply: (item: EntityWithScope, value) => {
        item.entity.assignedTo = value;
      },
    }),
    defineTextFieldSpec({
      path: "contacts[].displayName",
      items: matterOverviewContactItems,
      scope: (item: ContactWithScope) => item.workspaceId,
      read: (item: ContactWithScope) => item.contact.displayName,
      apply: (item: ContactWithScope, value) => {
        item.contact.displayName = value;
      },
    }),
    defineTextFieldSpec({
      path: "members[].name",
      items: matterOverviewMemberItems,
      scope: (item: MemberWithScope) => item.workspaceId,
      read: (item: MemberWithScope) => item.member.name,
      apply: (item: MemberWithScope, value) => {
        item.member.name = value;
      },
    }),
  ];

/**
 * search_across_matters: hits span multiple matters, each already carrying
 * its own `workspaceId` on the wire (P2 per-item attribution).
 */
type SearchAcrossMattersHit = {
  headline: string | null;
  name: string;
  workspaceId: string;
  workspaceName: string | null;
};
type SearchAcrossMattersPayload = { hits: readonly SearchAcrossMattersHit[] };

const SEARCH_ACROSS_MATTERS_TEXT_FIELD_SPECS: readonly McpTextFieldSpec<SearchAcrossMattersPayload>[] =
  [
    defineTextFieldSpec({
      path: "hits[].name",
      items: (payload: SearchAcrossMattersPayload) => payload.hits,
      scope: (hit: SearchAcrossMattersHit) => hit.workspaceId,
      read: (hit: SearchAcrossMattersHit) => hit.name,
      apply: (hit: SearchAcrossMattersHit, value) => {
        hit.name = value;
      },
    }),
    defineTextFieldSpec({
      path: "hits[].headline",
      items: (payload: SearchAcrossMattersPayload) => payload.hits,
      scope: (hit: SearchAcrossMattersHit) => hit.workspaceId,
      read: (hit: SearchAcrossMattersHit) => hit.headline,
      apply: (hit: SearchAcrossMattersHit, value) => {
        hit.headline = value;
      },
    }),
    defineTextFieldSpec({
      path: "hits[].workspaceName",
      items: (payload: SearchAcrossMattersPayload) => payload.hits,
      scope: (hit: SearchAcrossMattersHit) => hit.workspaceId,
      read: (hit: SearchAcrossMattersHit) => hit.workspaceName,
      apply: (hit: SearchAcrossMattersHit, value) => {
        hit.workspaceName = value;
      },
    }),
  ];

/**
 * read_content_across_matters: a single document, windowed after
 * anonymization (P8). The window co-declaration in the handler is untouched;
 * only the `name`/`text` textFields construction migrates here. `workspaceId`
 * already rides in the payload (stripped by nothing — this tool has no
 * compat-style field-stripping), so it is read straight off the item.
 */
type ReadContentAcrossMattersPayload = {
  name: string;
  text: string;
  workspaceId: string;
};

const READ_CONTENT_ACROSS_MATTERS_TEXT_FIELD_SPECS: readonly McpTextFieldSpec<ReadContentAcrossMattersPayload>[] =
  [
    defineTextFieldSpec({
      path: "name",
      items: (payload: ReadContentAcrossMattersPayload) => [payload],
      scope: (item: ReadContentAcrossMattersPayload) => item.workspaceId,
      read: (item: ReadContentAcrossMattersPayload) => item.name,
      apply: (item: ReadContentAcrossMattersPayload, value) => {
        item.name = value;
      },
    }),
    defineTextFieldSpec({
      path: "text",
      items: (payload: ReadContentAcrossMattersPayload) => [payload],
      scope: (item: ReadContentAcrossMattersPayload) => item.workspaceId,
      read: (item: ReadContentAcrossMattersPayload) => item.text,
      apply: (item: ReadContentAcrossMattersPayload, value) => {
        item.text = value;
      },
    }),
  ];

/**
 * read_contact: contacts are organization-scoped (no owning workspace), so
 * `organizationId` is the anonymization scope for every field. Unlike the
 * per-item/per-matter cases above, `organizationId` is not part of the served
 * payload, so it is threaded in as a builder argument. `STELLA_TOOL_DEFINITIONS`
 * below calls this same builder with a placeholder id purely to derive the
 * documented `textFields` path list — `deriveTextFieldPaths` only reads each
 * spec's static `path`, never `scope`, so the placeholder never affects the
 * declaration.
 */
type ContactPayload = {
  displayName: string;
  emails: readonly ContactEmail[];
  firstName: string | null;
  lastName: string | null;
  organizationName: string | null;
  phones: readonly ContactPhone[];
};

const buildContactTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<ContactPayload>[] => [
  defineTextFieldSpec({
    path: "displayName",
    items: (payload: ContactPayload) => [payload],
    scope: () => organizationId,
    read: (item: ContactPayload) => item.displayName,
    apply: (item: ContactPayload, value) => {
      item.displayName = value;
    },
  }),
  defineTextFieldSpec({
    path: "firstName",
    items: (payload: ContactPayload) => [payload],
    scope: () => organizationId,
    read: (item: ContactPayload) => item.firstName,
    apply: (item: ContactPayload, value) => {
      item.firstName = value;
    },
  }),
  defineTextFieldSpec({
    path: "lastName",
    items: (payload: ContactPayload) => [payload],
    scope: () => organizationId,
    read: (item: ContactPayload) => item.lastName,
    apply: (item: ContactPayload, value) => {
      item.lastName = value;
    },
  }),
  defineTextFieldSpec({
    path: "organizationName",
    items: (payload: ContactPayload) => [payload],
    scope: () => organizationId,
    read: (item: ContactPayload) => item.organizationName,
    apply: (item: ContactPayload, value) => {
      item.organizationName = value;
    },
  }),
  defineTextFieldSpec({
    path: "emails[].label",
    items: (payload: ContactPayload) => payload.emails,
    scope: () => organizationId,
    read: (email: ContactEmail) => email.label,
    apply: (email: ContactEmail, value) => {
      email.label = value;
    },
  }),
  defineTextFieldSpec({
    path: "emails[].address",
    items: (payload: ContactPayload) => payload.emails,
    scope: () => organizationId,
    read: (email: ContactEmail) => email.address,
    apply: (email: ContactEmail, value) => {
      email.address = value;
    },
  }),
  defineTextFieldSpec({
    path: "phones[].label",
    items: (payload: ContactPayload) => payload.phones,
    scope: () => organizationId,
    read: (phone: ContactPhone) => phone.label,
    apply: (phone: ContactPhone, value) => {
      phone.label = value;
    },
  }),
  defineTextFieldSpec({
    path: "phones[].number",
    items: (payload: ContactPayload) => payload.phones,
    scope: () => organizationId,
    read: (phone: ContactPhone) => phone.number,
    apply: (phone: ContactPhone, value) => {
      phone.number = value;
    },
  }),
];

export const STELLA_TOOL_DEFINITIONS = [
  {
    annotations: { readOnlyHint: true },
    description:
      "List the matters you can access, or get one matter's overview. Omit " +
      "matter_id to list accessible matters (filter with status, page with " +
      "cursor); list first when the user does not name a matter or you need " +
      "matter IDs for follow-up tools. Pass matter_id to return that matter's " +
      "overview instead: counts, recent entities, linked contacts, and members.",
    inputSchema: {
      type: "object",
      properties: {
        matter_id: stringProp(
          "Matter/workspace ID to return a single matter's overview; omit to list matters",
        ),
        status: enumProp("Filter by matter status (list mode)", [
          "active",
          "all",
        ]),
        limit: intProp("Max matters to return (list mode)", {
          min: 1,
          max: MAX_LIST_LIMIT,
        }),
        cursor: stringProp(
          "Opaque cursor from a previous list_matters call to fetch the next page",
          { maxLength: 512 },
        ),
      },
    },
    access: "read",
    anonymized: {
      exposure: "anonymize",
      textFields: [
        ...deriveTextFieldPaths(LIST_MATTERS_LIST_TEXT_FIELD_SPECS),
        ...deriveTextFieldPaths(MATTER_OVERVIEW_TEXT_FIELD_SPECS),
      ],
    },
    name: "list_matters",
    scope: "stella:read",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Search across all accessible matters. Use this when the user explicitly " +
      "asks to search outside a single matter or you do not yet know the right matter.",
    inputSchema: {
      type: "object",
      properties: {
        query: stringProp("Search query", {
          maxLength: LIMITS.searchQueryMaxLength,
        }),
        limit: intProp("Max results to return", {
          min: 1,
          max: MAX_SEARCH_LIMIT,
        }),
        cursor: stringProp(
          "Opaque cursor from a previous search_across_matters call to fetch the next page",
          { maxLength: 512 },
        ),
      },
      required: ["query"],
    },
    access: "read",
    anonymized: {
      exposure: "anonymize",
      textFields: deriveTextFieldPaths(SEARCH_ACROSS_MATTERS_TEXT_FIELD_SPECS),
    },
    name: "search_across_matters",
    scope: "stella:search",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Search the shared case-law corpus. Supports free-text search plus " +
      "optional filters such as court, country, language, date range, and " +
      "decision type.",
    inputSchema: {
      type: "object",
      properties: {
        query: stringProp("Search query", {
          maxLength: LIMITS.searchQueryMaxLength,
        }),
        limit: intProp("Max results to return", {
          min: 1,
          max: MAX_SEARCH_LIMIT,
        }),
        cursor: stringProp(
          "Opaque cursor from a previous search_case_law call",
          { maxLength: 128 },
        ),
        court: stringProp("Filter by court name", { maxLength: 512 }),
        country: stringProp("Filter by country code", { maxLength: 3 }),
        language: stringProp("Filter by language code", { maxLength: 8 }),
        decision_type: stringProp("Filter by decision type", {
          maxLength: 128,
        }),
        source_id: stringProp("Filter by source ID", { maxLength: 36 }),
        date_from: stringProp(
          "Filter decisions from this ISO date (YYYY-MM-DD)",
          { maxLength: 10 },
        ),
        date_to: stringProp(
          "Filter decisions up to this ISO date (YYYY-MM-DD)",
          { maxLength: 10 },
        ),
      },
      required: ["query"],
    },
    access: "read",
    anonymized: { exposure: "passthrough" },
    // Backed by the public case-law corpus (caseLawPublicReadDb), the same
    // surface the public routes gate behind env.isDev || env.FEATURE_PUBLIC_LAW.
    feature: "FEATURE_PUBLIC_LAW",
    name: "search_case_law",
    scope: "stella:search",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Read extracted text from a document found anywhere in your accessible " +
      "matters. Use after search_across_matters. Long documents are returned " +
      "in windows; pass the returned nextCursor back as cursor to read more.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: stringProp("Entity ID"),
        cursor: stringProp(
          "Opaque cursor from a previous call to read the next window of text",
          { maxLength: 512 },
        ),
      },
      required: ["entity_id"],
    },
    access: "read",
    anonymized: {
      exposure: "anonymize",
      textFields: deriveTextFieldPaths(
        READ_CONTENT_ACROSS_MATTERS_TEXT_FIELD_SPECS,
      ),
    },
    name: "read_content_across_matters",
    scope: "stella:read",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Read a single case-law decision by its decision ID. Returns metadata, " +
      "plain text, citation links, and source URLs. Long decision text and " +
      "large citation lists are returned in windows; pass the returned " +
      "nextCursor back as cursor to read more.",
    inputSchema: {
      type: "object",
      properties: {
        decision_id: stringProp("Case-law decision ID"),
        cursor: stringProp(
          "Opaque cursor from a previous call to read the next window of decision text and citations",
          { maxLength: 512 },
        ),
      },
      required: ["decision_id"],
    },
    access: "read",
    anonymized: { exposure: "passthrough" },
    // Backed by the public case-law corpus (caseLawPublicReadDb), the same
    // surface the public routes gate behind env.isDev || env.FEATURE_PUBLIC_LAW.
    feature: "FEATURE_PUBLIC_LAW",
    name: "read_case_law_decision",
    scope: "stella:read",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Read a contact by ID. Use this after matter overview or entity metadata " +
      "surfaces a contact the user wants to inspect more closely.",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: stringProp("Contact ID"),
      },
      required: ["contact_id"],
    },
    access: "read",
    anonymized: {
      exposure: "anonymize",
      // Placeholder org id: derivation only ever reads `.path`, see
      // `buildContactTextFieldSpecs`'s doc comment above.
      textFields: deriveTextFieldPaths(buildContactTextFieldSpecs("")),
    },
    name: "read_contact",
    scope: "stella:read",
  },
  {
    description:
      "Set the practice jurisdictions for the user's stella organization. " +
      "Call this when the org's practice jurisdictions are empty (e.g., the " +
      "user signed up via an OAuth client and skipped onboarding). Pass an " +
      "array of {countryCode, isPrimary}; exactly one entry should be primary.",
    inputSchema: {
      type: "object",
      properties: {
        jurisdictions: {
          type: "array",
          description:
            "Practice jurisdictions for this organization. countryCode is an " +
            "ISO 3166-1 alpha-2 code; exactly one entry should set isPrimary " +
            "to true.",
          minItems: 1,
          maxItems: LIMITS.practiceJurisdictionsPerOrganization,
          items: {
            type: "object",
            properties: {
              countryCode: {
                type: "string",
                description: "ISO 3166-1 alpha-2 country code",
                enum: [...COUNTRY_CODES],
              },
              isPrimary: {
                type: "boolean",
                description:
                  "Whether this is the organization's primary jurisdiction",
              },
            },
            required: ["countryCode", "isPrimary"],
          },
        },
      },
      required: ["jurisdictions"],
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "set_practice_jurisdictions",
    scope: "stella:onboarding",
  },
] as const satisfies readonly McpToolDefinition[];

const loadPracticeJurisdictions = async (
  context: McpRequestContext,
): Promise<readonly PracticeJurisdiction[]> => {
  const row = await context.scopedDb((tx) =>
    tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: context.organizationId } },
      columns: { practiceJurisdictions: true },
    }),
  );
  return arrayOrEmpty(row?.practiceJurisdictions);
};

const buildOnboardingHintText = () =>
  `Your stella organization has not configured its practice jurisdictions ` +
  `yet. Call \`set_practice_jurisdictions\` (input: array of ` +
  `\`{ countryCode, isPrimary }\`) to enable jurisdiction-aware tools, or ` +
  `have the user complete onboarding at ${getAppBaseUrl()}.`;

const withOnboardingHintIfApplicable = async ({
  context,
  isEmpty,
  result,
}: {
  context: McpRequestContext;
  isEmpty: boolean;
  result: CallToolResult;
}): Promise<CallToolResult> => {
  if (!isEmpty) {
    return result;
  }
  const jurisdictions = await loadPracticeJurisdictions(context);
  if (jurisdictions.length > 0) {
    return result;
  }
  return {
    ...result,
    content: [
      ...result.content,
      { type: "text", text: buildOnboardingHintText() },
    ],
  };
};

// The list_matters cursor is the boundary matter id alone; the query
// resolves its (lastActivityAt, id) in-DB. A malformed id is rejected here
// so it never reaches the SQL comparison.
const decodeMatterPageCursor = (cursor: string): string | null => {
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 1) {
    return null;
  }
  const [rawId] = parts;
  return isUuidPaginationCursorPart(rawId) ? rawId : null;
};

const handleListMattersTool: McpToolHandler = async ({ args, context }) => {
  // Detail mode: matter_id selects one matter's overview. The list-only
  // filters (status/limit/cursor) do not apply, so reject the mixed request
  // up front rather than silently ignoring them.
  if (args["matter_id"] !== undefined) {
    if (
      args["status"] !== undefined ||
      args["limit"] !== undefined ||
      args["cursor"] !== undefined
    ) {
      return structuredErrorResult({
        code: "validation_error",
        message:
          "status, limit, and cursor apply when listing matters; omit matter_id to list",
        issues: [
          {
            path: "matter_id",
            message:
              "status, limit, and cursor apply when listing matters; omit matter_id to list",
          },
        ],
        hint: "Omit 'matter_id' to list matters with 'status'/'limit'/'cursor', or pass only 'matter_id' to read one matter's overview.",
      });
    }
    return await readMatterOverview({ args, context });
  }

  const status = parseOptionalEnum({
    args,
    defaultValue: "active",
    key: "status",
    values: ["active", "all"] as const,
  });
  if (typeof status !== "string") {
    return status;
  }

  const limit = parseOptionalLimit({
    args,
    defaultValue: DEFAULT_LIST_LIMIT,
    key: "limit",
    max: MAX_LIST_LIMIT,
  });
  if (typeof limit !== "number") {
    return limit;
  }

  const cursor = parseOptionalCursor({ args, key: "cursor" });
  if (isToolErrorResult(cursor)) {
    return cursor;
  }
  let boundaryId: string | undefined;
  if (cursor !== undefined) {
    const decoded = decodeMatterPageCursor(cursor);
    if (decoded === null) {
      return structuredErrorResult({
        code: "validation_error",
        message: "Invalid cursor",
        issues: [{ path: "cursor", message: "Invalid cursor" }],
        hint: "Pass the 'cursor' verbatim as returned by a previous call, or omit it for the first page.",
      });
    }
    boundaryId = decoded;
  }

  const rows = await context.scopedDb((tx) =>
    tx
      .select({
        id: workspaces.id,
        name: workspaces.name,
        reference: workspaces.reference,
        status: workspaces.status,
        lastActivityAt: workspaces.lastActivityAt,
        createdAt: workspaces.createdAt,
      })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.organizationId, context.organizationId),
          status === "all" ? undefined : eq(workspaces.status, status),
          // Compare the full-precision (lastActivityAt, id) tuple in-DB
          // against the boundary row (looked up by id) so the cursor never
          // round-trips lastActivityAt through a millisecond JS Date;
          // matters sharing a now()-generated microsecond timestamp cannot
          // be skipped or duplicated across pages. The boundary lookup is
          // scoped to the same org and status filter as the page (defense in
          // depth beyond RLS) so a cursor carrying a foreign or out-of-filter
          // workspace id cannot shift this page's boundary. The status clause
          // is conditional: comparing against the synthetic "all" value would
          // fail to cast to the status enum.
          boundaryId === undefined
            ? undefined
            : sql`(${workspaces.lastActivityAt}, ${workspaces.id}) < (select b.last_activity_at, b.id from workspaces b where b.id = ${boundaryId} and b.organization_id = ${context.organizationId}${status === "all" ? sql`` : sql` and b.status = ${status}`})`,
        ),
      )
      .orderBy(desc(workspaces.lastActivityAt), desc(workspaces.id))
      .limit(limit + 1),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) => encodePaginationCursor([item.id]),
  });

  const matters = page.items.map((matter) => ({
    id: matter.id,
    name: matter.name,
    reference: matter.reference,
    status: matter.status,
    lastActivityAt: matter.lastActivityAt.toISOString(),
    createdAt: matter.createdAt.toISOString(),
  }));

  // An empty page carries no tenant text to anonymize, so return the finished
  // result directly (and let the onboarding hint attach). A non-empty page runs
  // through the egress pipeline, which anonymizes each matter's name under its
  // own workspace scope in anonymized mode. The matter id is its workspace id.
  if (matters.length === 0) {
    return await withOnboardingHintIfApplicable({
      context,
      isEmpty: true,
      result: textResult({ matters, nextCursor: page.nextCursor }),
    });
  }

  const payload = { matters, nextCursor: page.nextCursor };
  const textFields = runTextFieldSpecs(
    LIST_MATTERS_LIST_TEXT_FIELD_SPECS,
    payload,
  );

  return { egress: "structured", payload, textFields };
};

// Detail branch of list_matters: one matter's overview (counts, recent
// entities, contacts, members). Reused verbatim from the former
// get_matter_overview tool, which list_matters absorbed.
const readMatterOverview: McpToolHandler = async ({ args, context }) => {
  const matterId = parseRequiredString(args, "matter_id");
  if (typeof matterId !== "string") {
    return matterId;
  }

  const workspaceId = ensureWorkspaceAccess({
    context,
    workspaceId: matterId,
  });
  if (!workspaceId) {
    return notFoundResult("Matter not found or not accessible");
  }

  const [workspace, overview, contacts, members] = await Promise.all([
    readWorkspaceHandler({
      organizationId: context.organizationId,
      scopedDb: context.scopedDb,
      workspaceId,
    }),
    readOverviewHandler({
      scopedDb: context.scopedDb,
      workspaceId,
    }),
    readWorkspaceContactsHandler({
      scopedDb: context.scopedDb,
      workspaceId,
    }),
    readWorkspaceMembersHandler({
      scopedDb: context.scopedDb,
      workspaceId,
    }),
  ]);

  if (typeof workspace !== "object" || !("name" in workspace)) {
    return notFoundResult("Matter not found or not accessible");
  }

  const matter = {
    id: workspace.id,
    name: workspace.name,
    reference: workspace.reference,
    status: workspace.status,
    clientName: workspace.client?.displayName ?? null,
  };
  const contactCards = contacts.flatMap((workspaceContact) => {
    if (!workspaceContact.contact) {
      return [];
    }
    return [
      {
        // The matter-contact link id, so link_matter_contact can unlink a
        // precise role even when the contact holds several.
        workspaceContactId: workspaceContact.id,
        contactId: workspaceContact.contact.id,
        displayName: workspaceContact.contact.displayName,
        role: workspaceContact.role,
        type: workspaceContact.contact.type,
      },
    ];
  });
  // Workspace members are the users save_task can assign, so surface their ids
  // and names here for discoverability. Bounded by readWorkspaceMembersHandler's
  // LIMITS.workspaceMembersCount cap.
  const memberCards = members.flatMap((member) =>
    member.user === null
      ? []
      : [{ userId: member.user.id, name: member.user.name }],
  );

  const overviewWithoutAvatarUrls = {
    ...overview,
    recentEntities: overview.recentEntities.map(
      ({
        assignedToImage: _assignedToImage,
        createdByImage: _createdByImage,
        ...entity
      }) => entity,
    ),
  };
  const payload = {
    matter,
    overview: overviewWithoutAvatarUrls,
    contacts: contactCards,
    members: memberCards,
  };

  // Everything below belongs to one matter, so it all anonymizes under this
  // single workspace scope. Ids/status/dates pass through; user-authored
  // matter references and free-text party/person names are redacted. The
  // entity/contact/member item selectors above read `payload.matter.id` for
  // the scope and `payload.overview.recentEntities` (not the source
  // `overview.recentEntities`) for the entities — the avatar-URL strip above
  // copies each entity into a new object, so extracting items from the
  // object actually placed in the payload (not the pre-strip source) is what
  // keeps the write-back landing on the object the response serializes.
  const textFields = runTextFieldSpecs(
    MATTER_OVERVIEW_TEXT_FIELD_SPECS,
    payload,
  );

  return { egress: "structured", payload, textFields };
};

const handleSearchAcrossMattersTool: McpToolHandler = async ({
  args,
  context,
}) => {
  const query = parseRequiredString(args, "query", {
    maxLength: LIMITS.searchQueryMaxLength,
  });
  if (typeof query !== "string") {
    return query;
  }

  const limit = parseOptionalLimit({
    args,
    defaultValue: DEFAULT_SEARCH_LIMIT,
    key: "limit",
    max: MAX_SEARCH_LIMIT,
  });
  if (typeof limit !== "number") {
    return limit;
  }

  const cursor = parseOptionalCursor({ args, key: "cursor" });
  if (isToolErrorResult(cursor)) {
    return cursor;
  }
  // Reject an undecodable provider cursor instead of forwarding it: the
  // provider treats a malformed cursor as no cursor and silently returns the
  // first page, which would duplicate hits or loop a paginating client.
  if (cursor !== undefined && decodeCursor(cursor) === null) {
    return structuredErrorResult({
      code: "validation_error",
      message: "Invalid cursor",
      issues: [{ path: "cursor", message: "Invalid cursor" }],
      hint: "Pass the 'cursor' verbatim as returned by a previous call, or omit it for the first page.",
    });
  }

  const result = await getSearchProvider().search({
    query,
    organizationId: context.organizationId,
    workspaceIds: context.accessibleWorkspaceIds,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  });

  const hits = result.hits.map((hit) => ({
    entityId: hit.entityId,
    workspaceId: hit.workspaceId,
    workspaceName: hit.workspaceName,
    name: hit.title,
    kind: hit.kind,
    headline: hit.headline,
  }));

  // Hits span multiple matters; each anonymizes under its own workspace scope.
  // `workspaceName` embeds the matter name (party names), so it is redacted
  // alongside the hit name and headline to stay consistent with list_matters.
  const payload = {
    totalCount: result.totalCount,
    nextCursor: result.nextCursor,
    hits,
  };
  const textFields = runTextFieldSpecs(
    SEARCH_ACROSS_MATTERS_TEXT_FIELD_SPECS,
    payload,
  );

  return { egress: "structured", payload, textFields };
};

const parseOptionalStringArg = ({
  args,
  key,
  maxLength,
}: {
  args: Record<string, unknown>;
  key: string;
  maxLength?: number;
}): string | undefined | ReturnType<typeof errorResult> => {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    const message = `Invalid parameter: ${key}. Expected a string`;
    return structuredErrorResult({
      code: "validation_error",
      message,
      issues: [{ path: key, message }],
    });
  }
  if (maxLength !== undefined && value.length > maxLength) {
    const message = `Parameter ${key} exceeds maximum length of ${maxLength}`;
    return structuredErrorResult({
      code: "validation_error",
      message,
      issues: [{ path: key, message }],
      hint: `Shorten '${key}' to at most ${maxLength} characters.`,
    });
  }
  return value;
};

const parseOptionalDateArg = ({
  args,
  key,
}: {
  args: Record<string, unknown>;
  key: string;
}): string | undefined | ReturnType<typeof errorResult> => {
  const value = parseOptionalStringArg({ args, key });
  if (typeof value !== "string") {
    return value;
  }
  if (!ISO_DATE_PATTERN.test(value)) {
    const message = `Invalid parameter: ${key}. Expected an ISO date in YYYY-MM-DD format`;
    return structuredErrorResult({
      code: "validation_error",
      message,
      issues: [{ path: key, message }],
      hint: `Set '${key}' to a calendar date formatted as YYYY-MM-DD.`,
    });
  }
  const parsed = new Date(value);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    const message = `Invalid parameter: ${key}. Expected an ISO date in YYYY-MM-DD format`;
    return structuredErrorResult({
      code: "validation_error",
      message,
      issues: [{ path: key, message }],
      hint: `Set '${key}' to a calendar date formatted as YYYY-MM-DD.`,
    });
  }
  return value;
};

const getResultMessage = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  if ("message" in value && typeof value.message === "string") {
    return value.message;
  }

  if (
    "response" in value &&
    typeof value.response === "object" &&
    value.response !== null &&
    "message" in value.response &&
    typeof value.response.message === "string"
  ) {
    return value.response.message;
  }

  return null;
};

type SearchCaseLawSuccess = Extract<
  Awaited<ReturnType<typeof searchDecisionsHandler>>,
  { hits: unknown[] }
>;

const isSearchCaseLawSuccess = (
  value: Awaited<ReturnType<typeof searchDecisionsHandler>>,
): value is SearchCaseLawSuccess =>
  typeof value === "object" && "hits" in value && Array.isArray(value.hits);

type ReadCaseLawDecisionSuccess = Extract<
  Awaited<ReturnType<typeof readDecisionHandler>>,
  { caseNumber: string; citationsFrom: unknown[]; citationsTo: unknown[] }
>;

const isReadCaseLawDecisionSuccess = (
  value: Awaited<ReturnType<typeof readDecisionHandler>>,
): value is ReadCaseLawDecisionSuccess =>
  typeof value === "object" &&
  "caseNumber" in value &&
  typeof value.caseNumber === "string" &&
  "citationsFrom" in value &&
  Array.isArray(value.citationsFrom) &&
  "citationsTo" in value &&
  Array.isArray(value.citationsTo);

const toPlainDecisionText = (decision: {
  documentAst: unknown;
  fulltext: string | null;
}) => {
  if (typeof decision.fulltext === "string" && decision.fulltext.length > 0) {
    return decision.fulltext;
  }
  if (!hasUsableAst(decision.documentAst)) {
    return null;
  }
  return decision.documentAst.blocks
    .map((block) => block.plainText)
    .join("\n\n");
};

const toIsoDateString = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return null;
};

const handleReadContentAcrossMattersTool: McpToolHandler = async ({
  args,
  context,
}) => {
  const rawEntityId = parseRequiredString(args, "entity_id");
  if (typeof rawEntityId !== "string") {
    return rawEntityId;
  }

  const entityId = brandPersistedEntityId(rawEntityId);

  const cursor = parseOptionalCursor({ args, key: "cursor" });
  if (isToolErrorResult(cursor)) {
    return cursor;
  }

  if (context.accessibleWorkspaceIds.length === 0) {
    return errorResult("No extracted content available for this entity.");
  }

  const row = await context.scopedDb((tx) =>
    tx.query.extractedContent.findFirst({
      where: {
        entityId: { eq: entityId },
        organizationId: { eq: context.organizationId },
        workspaceId: { in: context.accessibleWorkspaceIds },
      },
      with: {
        entity: {
          columns: {
            kind: true,
            name: true,
            workspaceId: true,
          },
        },
      },
    }),
  );

  if (!row?.entity) {
    return errorResult("No extracted content available for this entity.");
  }

  const plaintext = await decryptContent(
    context.organizationId,
    row.ciphertext,
    row.iv,
  );

  const workspaceId = row.entity.workspaceId;
  // Carry the FULL decrypted text and window it in the egress pipeline, so an
  // anonymized read redacts the whole document before slicing (slicing raw text
  // first could split an entity name across the window boundary and leak its
  // prefix). Default mode leaves name/text as-is and windows the same way.
  const initialNextCursor = (): string | null => null;
  const payload = {
    charCount: plaintext.length,
    entityId,
    kind: row.entity.kind,
    name: row.entity.name,
    text: plaintext,
    truncated: false,
    nextCursor: initialNextCursor(),
    workspaceId,
  };

  return {
    egress: "structured",
    payload,
    textFields: runTextFieldSpecs(
      READ_CONTENT_ACROSS_MATTERS_TEXT_FIELD_SPECS,
      payload,
    ),
    window: {
      cursor,
      maxChars: MCP_CONTENT_MAX_CHARS,
      read: () => payload.text,
      apply: (textWindow) => {
        payload.text = textWindow.text;
        payload.charCount = textWindow.charCount;
        payload.truncated = textWindow.truncated;
        payload.nextCursor = textWindow.nextCursor;
      },
    },
  };
};

const handleSearchCaseLawTool: McpToolHandler = async ({ args, context }) => {
  const query = parseRequiredString(args, "query", {
    maxLength: LIMITS.searchQueryMaxLength,
  });
  if (typeof query !== "string") {
    return query;
  }

  const limit = parseOptionalLimit({
    args,
    defaultValue: DEFAULT_SEARCH_LIMIT,
    key: "limit",
    max: MAX_SEARCH_LIMIT,
  });
  if (typeof limit !== "number") {
    return limit;
  }

  const cursor = parseOptionalStringArg({
    args,
    key: "cursor",
    maxLength: 128,
  });
  if (isToolErrorResult(cursor)) {
    return cursor;
  }
  const court = parseOptionalStringArg({
    args,
    key: "court",
    maxLength: 512,
  });
  if (isToolErrorResult(court)) {
    return court;
  }
  const country = parseOptionalStringArg({
    args,
    key: "country",
    maxLength: 3,
  });
  if (isToolErrorResult(country)) {
    return country;
  }
  const language = parseOptionalStringArg({
    args,
    key: "language",
    maxLength: 8,
  });
  if (isToolErrorResult(language)) {
    return language;
  }
  const decisionType = parseOptionalStringArg({
    args,
    key: "decision_type",
    maxLength: 128,
  });
  if (isToolErrorResult(decisionType)) {
    return decisionType;
  }
  const sourceId = parseOptionalStringArg({
    args,
    key: "source_id",
    maxLength: 36,
  });
  if (isToolErrorResult(sourceId)) {
    return sourceId;
  }
  if (sourceId !== undefined && !isUuid(sourceId)) {
    return structuredErrorResult({
      code: "validation_error",
      message: "Invalid parameter: source_id. Expected a UUID",
      issues: [
        {
          path: "source_id",
          message: "Invalid parameter: source_id. Expected a UUID",
        },
      ],
    });
  }
  const dateFrom = parseOptionalDateArg({ args, key: "date_from" });
  if (isToolErrorResult(dateFrom)) {
    return dateFrom;
  }
  const dateTo = parseOptionalDateArg({ args, key: "date_to" });
  if (isToolErrorResult(dateTo)) {
    return dateTo;
  }

  const result = await searchDecisionsHandler(
    {
      query,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
      ...(court === undefined ? {} : { court }),
      ...(country === undefined ? {} : { country }),
      ...(language === undefined ? {} : { language }),
      ...(decisionType === undefined ? {} : { decisionType }),
      ...(sourceId === undefined
        ? {}
        : { sourceId: brandPersistedCaseLawSourceId(sourceId) }),
      ...(dateFrom === undefined ? {} : { dateFrom }),
      ...(dateTo === undefined ? {} : { dateTo }),
    },
    caseLawPublicReadDb,
  );

  const resultMessage = getResultMessage(result);
  if (resultMessage) {
    return errorResult(resultMessage);
  }
  if (!isSearchCaseLawSuccess(result)) {
    return errorResult("Case-law search failed");
  }

  const payload = textResult({
    facets: result.facets,
    nextCursor: result.nextCursor,
    results: result.hits.map((hit) => ({
      appUrl: buildCaseLawDecisionAppUrl({
        caseNumber: hit.caseNumber,
        country: hit.country,
        court: hit.court,
        language: hit.language,
        languageAlternateCount: hit.languageAlternateCount,
        slug: hit.slug,
      }),
      caseNumber: hit.caseNumber,
      citationCount: hit.citationCount,
      country: hit.country,
      court: hit.court,
      decisionDate: hit.decisionDate,
      decisionId: hit.decisionId,
      decisionType: hit.decisionType,
      ecli: hit.ecli,
      language: hit.language,
      snippet: hit.headline,
      sourceUrl: hit.sourceUrl,
    })),
    totalCount: result.totalCount,
  });

  return await withOnboardingHintIfApplicable({
    context,
    isEmpty: result.hits.length === 0,
    result: payload,
  });
};

type DecisionCursorOffsets = { text: number; from: number; to: number };

// read_case_law_decision pages the decision text and both citation lists with
// a single compound cursor encoding [textOffset, fromOffset, toOffset].
const decodeDecisionCursor = (
  cursor: string | undefined,
): DecisionCursorOffsets | null => {
  if (cursor === undefined) {
    return { text: 0, from: 0, to: 0 };
  }
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 3) {
    return null;
  }
  const [text, from, to] = parts;
  if (
    typeof text !== "number" ||
    !Number.isInteger(text) ||
    text < 0 ||
    typeof from !== "number" ||
    !Number.isInteger(from) ||
    from < 0 ||
    typeof to !== "number" ||
    !Number.isInteger(to) ||
    to < 0
  ) {
    return null;
  }
  return { text, from, to };
};

const handleReadCaseLawDecisionTool: McpToolHandler = async ({ args }) => {
  const decisionId = parseRequiredString(args, "decision_id");
  if (typeof decisionId !== "string") {
    return decisionId;
  }

  const cursor = parseOptionalCursor({ args, key: "cursor" });
  if (isToolErrorResult(cursor)) {
    return cursor;
  }
  const offsets = decodeDecisionCursor(cursor);
  if (offsets === null) {
    return structuredErrorResult({
      code: "validation_error",
      message: "Invalid cursor",
      issues: [{ path: "cursor", message: "Invalid cursor" }],
      hint: "Pass the 'cursor' verbatim as returned by a previous call, or omit it for the first page.",
    });
  }

  const result = await readDecisionHandler(
    brandPersistedCaseLawDecisionId(decisionId),
    caseLawPublicReadDb,
  );
  const resultMessage = getResultMessage(result);
  if (resultMessage) {
    return errorResult(resultMessage);
  }
  if (!isReadCaseLawDecisionSuccess(result)) {
    return notFoundResult("Decision not found");
  }

  // allowsRedistribution gates whether the decision is publicly
  // readable; allowsDerivedAi additionally gates feeding full text to a
  // model, which is exactly this tool's context.
  const aiTextAllowed = result.source.allowsDerivedAi;

  const plainText = aiTextAllowed
    ? (toPlainDecisionText({
        documentAst: result.documentAst,
        fulltext: result.fulltext,
      }) ?? null)
    : null;
  const textLength = plainText === null ? 0 : plainText.length;

  const textBounds = resolveWindowBounds(
    textLength,
    offsets.text,
    MCP_CONTENT_MAX_CHARS,
  );
  const fromBounds = resolveWindowBounds(
    result.citationsFrom.length,
    offsets.from,
    MCP_CASE_LAW_CITATIONS_PER_DECISION,
  );
  const toBounds = resolveWindowBounds(
    result.citationsTo.length,
    offsets.to,
    MCP_CASE_LAW_CITATIONS_PER_DECISION,
  );

  // One compound cursor advances all three streams together; it resolves to
  // null only once the text and both citation lists are fully consumed.
  const hasMore =
    textBounds.nextOffset !== null ||
    fromBounds.nextOffset !== null ||
    toBounds.nextOffset !== null;
  const nextCursor = hasMore
    ? encodePaginationCursor([textBounds.end, fromBounds.end, toBounds.end])
    : null;

  return textResult({
    nextCursor,
    decision: {
      appUrl: buildCaseLawDecisionAppUrl({
        caseNumber: result.caseNumber,
        country: result.country,
        court: result.court,
        language: result.language,
        languageAlternates: result.languageAlternates,
        slug: result.slug,
      }),
      caseNumber: result.caseNumber,
      citationsFrom: result.citationsFrom.slice(
        fromBounds.start,
        fromBounds.end,
      ),
      citationsFromTotal: result.citationsFrom.length,
      citationsTo: result.citationsTo.slice(toBounds.start, toBounds.end),
      citationsToTotal: result.citationsTo.length,
      country: result.country,
      court: result.court,
      decisionDate: toIsoDateString(result.decisionDate),
      decisionId: result.id,
      decisionType: result.decisionType,
      documentUrl: result.documentUrl,
      ecli: result.ecli,
      language: result.language,
      metadata: result.metadata,
      source: result.source,
      sourceUrl: result.sourceUrl,
      text:
        plainText === null
          ? null
          : plainText.slice(textBounds.start, textBounds.end),
      charCount: plainText === null ? null : textLength,
      truncated: textBounds.nextOffset !== null,
      ...(aiTextAllowed
        ? {}
        : {
            textWithheldReason:
              "The source licence does not permit AI use of the full text.",
          }),
    },
  });
};

const handleReadContactTool: McpToolHandler = async ({ args, context }) => {
  const rawContactId = parseRequiredString(args, "contact_id");
  if (typeof rawContactId !== "string") {
    return rawContactId;
  }

  const contactId = brandPersistedContactId(rawContactId);

  const contact = await context.scopedDb((tx) =>
    tx.query.contacts.findFirst({
      where: {
        id: { eq: contactId },
        organizationId: { eq: context.organizationId },
      },
      columns: {
        id: true,
        type: true,
        displayName: true,
        firstName: true,
        lastName: true,
        organizationName: true,
        emails: true,
        phones: true,
      },
    }),
  );

  if (!contact) {
    return notFoundResult("Contact not found");
  }

  // Contacts are organization-scoped (no owning workspace), so the org id is
  // the anonymization scope. The placeholder card is intentional and consistent
  // with how chat anonymizes contact fields.
  const payload = {
    contactId: contact.id,
    type: contact.type,
    displayName: contact.displayName,
    firstName: contact.firstName,
    lastName: contact.lastName,
    organizationName: contact.organizationName,
    // The rows are request-scoped and owned by this handler, so the address /
    // number fields are anonymized in place below.
    emails: arrayOrEmpty(contact.emails),
    phones: arrayOrEmpty(contact.phones),
  };

  const textFields = runTextFieldSpecs(
    buildContactTextFieldSpecs(context.organizationId),
    payload,
  );

  return { egress: "structured", payload, textFields };
};

const countryCodeSchema = v.picklist(COUNTRY_CODES);

const practiceJurisdictionInputSchema = v.strictObject({
  countryCode: countryCodeSchema,
  isPrimary: v.boolean(),
});

const setPracticeJurisdictionsArgsSchema = v.strictObject({
  jurisdictions: v.pipe(
    v.array(practiceJurisdictionInputSchema),
    v.minLength(1),
    v.maxLength(LIMITS.practiceJurisdictionsPerOrganization),
  ),
});

const handleSetPracticeJurisdictionsTool: McpToolHandler = async ({
  args,
  context,
}) => {
  const hasPermission = roles[context.memberRole].authorize({
    organizationSettings: ["update"],
  });
  if (!hasPermission.success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(setPracticeJurisdictionsArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult({
      issues: parsed.issues,
      message:
        "Invalid input: expected { jurisdictions: Array<{ countryCode: ISO 3166-1 alpha-2, isPrimary: boolean }> }",
    });
  }

  const primaryCount = parsed.output.jurisdictions.filter(
    (jurisdiction) => jurisdiction.isPrimary,
  ).length;
  if (primaryCount > 1) {
    return errorResult("Only one jurisdiction can be primary");
  }

  const practiceJurisdictions = normalizePracticeJurisdictions(
    parsed.output.jurisdictions,
  );

  await context.scopedDb(async (tx) => {
    await upsertPracticeJurisdictions({
      organizationId: context.organizationId,
      practiceJurisdictions,
      recordAuditEvent: context.recordAuditEvent,
      tx,
    });
  });

  return textResult({ practiceJurisdictions });
};

export const STELLA_TOOL_HANDLERS = {
  list_matters: handleListMattersTool,
  read_case_law_decision: handleReadCaseLawDecisionTool,
  read_contact: handleReadContactTool,
  read_content_across_matters: handleReadContentAcrossMattersTool,
  search_case_law: handleSearchCaseLawTool,
  search_across_matters: handleSearchAcrossMattersTool,
  set_practice_jurisdictions: handleSetPracticeJurisdictionsTool,
} satisfies Record<StellaToolName, McpToolHandler>;

export const STELLA_TOOL_SET = defineMcpToolSet(
  STELLA_TOOL_DEFINITIONS,
  STELLA_TOOL_HANDLERS,
);
