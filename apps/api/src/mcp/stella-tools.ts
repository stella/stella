import { panic, Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";
import { COUNTRY_CODES } from "@stll/country-codes";
import { docxToMarkdown } from "@stll/folio-core/server";

import type { PracticeJurisdiction } from "@/api/db/schema";
import { workspaces } from "@/api/db/schema";
import type {
  ContactEmail,
  ContactPhone,
  FieldContent,
} from "@/api/db/schema-validators";
import type { readGatedDecisionWithDocument } from "@/api/handlers/case-law/decisions/get-deferred-document";
import type { searchDecisionsHandler } from "@/api/handlers/case-law/decisions/search";
import { parseUsableDocumentAst } from "@/api/handlers/case-law/document-ast";
import {
  identifyOrganizationJurisdictions,
  normalizePracticeJurisdictions,
  upsertPracticeJurisdictions,
} from "@/api/handlers/organization-settings/practice-jurisdictions";
import type { readWorkspaceHandler } from "@/api/handlers/workspaces/get";
import type { readOverviewHandler } from "@/api/handlers/workspaces/read-overview";
import type { readWorkspaceContactsHandler } from "@/api/handlers/workspaces/workspace-contacts-read";
import type { readWorkspaceMembersHandler } from "@/api/handlers/workspaces/workspace-members-read";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type {
  AssertNoExtraFields,
  LIST_MATTERS_DETAIL_PROJECTION,
  LIST_MATTERS_LIST_PROJECTION,
  LIST_MATTERS_PROJECTION,
  READ_CASE_LAW_DECISION_PROJECTION,
  READ_CONTACT_PROJECTION,
  READ_CONTENT_ACROSS_MATTERS_PROJECTION,
  SEARCH_ACROSS_MATTERS_PROJECTION,
  SEARCH_CASE_LAW_PROJECTION,
  SET_PRACTICE_JURISDICTIONS_PROJECTION,
} from "@/api/lib/chat/projections";
import { decryptContent } from "@/api/lib/content-encryption";
import { isUuid } from "@/api/lib/custom-schema";
import {
  resolveCurrentFileSourceField,
  selectCurrentExtractedContent,
  type ExtractedContentSourceProvenance,
} from "@/api/lib/document-content-provenance";
import { createFileKey } from "@/api/lib/files/utils";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { readS3ArrayBuffer } from "@/api/lib/s3";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedCaseLawSourceId,
  brandPersistedContactId,
  brandPersistedEntityId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { decodeCursor } from "@/api/lib/search/cursor";
import { getSearchProvider } from "@/api/lib/search/provider";
import { withTimeout } from "@/api/lib/with-timeout";
import type { McpRequestContext } from "@/api/mcp/context";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import { serializeAuthorizedCorpusMcpResourceName } from "@/api/mcp/resource-serialization";
import {
  defineTextFieldSpec,
  deriveTextFieldPaths,
  runTextFieldSpecs,
} from "@/api/mcp/text-field-spec";
import type {
  InternalToolErrorResult,
  InternalToolSuccess,
  McpTextFieldSpec,
  McpToolDefinition,
  McpToolHandler,
  TypedMcpToolHandler,
} from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import {
  buildCaseLawDecisionAppUrl,
  DEFAULT_LIST_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  ensureWorkspaceAccess,
  errorResult,
  getAppBaseUrl,
  MAX_CURSOR_LENGTH,
  MAX_LIST_LIMIT,
  MAX_SEARCH_LIMIT,
  notFoundResult,
  resolveWindowBounds,
  structuredErrorResult,
  toolDataResult,
  toPlainTextSnippet,
  validationErrorResult,
  uuidInputSchema,
} from "@/api/mcp/tool-utils";
import { defineValibotMcpTool } from "@/api/mcp/valibot-tool-definition";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const defaultReadGatedDecisionWithDocument: typeof readGatedDecisionWithDocument =
  async (input) =>
    await (
      await import("@/api/handlers/case-law/decisions/get-deferred-document")
    ).readGatedDecisionWithDocument(input);
const defaultSearchDecisionsHandler: typeof searchDecisionsHandler = async (
  input,
  database,
) =>
  await (
    await import("@/api/handlers/case-law/decisions/search")
  ).searchDecisionsHandler(input, database);
const defaultReadWorkspaceHandler: typeof readWorkspaceHandler = async (
  input,
) =>
  await (
    await import("@/api/handlers/workspaces/get")
  ).readWorkspaceHandler(input);
const defaultReadOverviewHandler: typeof readOverviewHandler = async (input) =>
  await (
    await import("@/api/handlers/workspaces/read-overview")
  ).readOverviewHandler(input);
const defaultReadWorkspaceContactsHandler: typeof readWorkspaceContactsHandler =
  async (input) =>
    await (
      await import("@/api/handlers/workspaces/workspace-contacts-read")
    ).readWorkspaceContactsHandler(input);
const defaultReadWorkspaceMembersHandler: typeof readWorkspaceMembersHandler =
  async (input) =>
    await (
      await import("@/api/handlers/workspaces/workspace-members-read")
    ).readWorkspaceMembersHandler(input);

const MCP_CONTENT_MAX_CHARS = 8000;
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

// --- Input schemas --------------------------------------------------------
// One Valibot schema per tool: the handler parses it and the advertised JSON
// Schema is projected from it, so an unknown key is rejected on both.

const listMattersArgsSchema = v.strictObject({
  matter_id: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.description(
        "Matter ID to return a single matter's overview; omit to list matters",
      ),
    ),
  ),
  status: v.optional(
    v.pipe(
      v.picklist(["active", "all"]),
      v.description("Filter by matter status (list mode)"),
    ),
  ),
  limit: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(MAX_LIST_LIMIT),
      v.description("Max matters to return (list mode)"),
    ),
  ),
  cursor: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(MAX_CURSOR_LENGTH),
      v.description(
        "Opaque cursor from a previous list_matters call to fetch the next page",
      ),
    ),
  ),
});

const searchAcrossMattersArgsSchema = v.strictObject({
  query: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(LIMITS.searchQueryMaxLength),
    v.description("Search query"),
  ),
  limit: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(MAX_SEARCH_LIMIT),
      v.description("Max results to return"),
    ),
  ),
  cursor: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(MAX_CURSOR_LENGTH),
      v.description(
        "Opaque cursor from a previous search_across_matters call to fetch the next page",
      ),
    ),
  ),
});

const searchCaseLawArgsSchema = v.strictObject({
  query: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(LIMITS.searchQueryMaxLength),
    v.description("Search query"),
  ),
  limit: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(MAX_SEARCH_LIMIT),
      v.description("Max results to return"),
    ),
  ),
  cursor: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(128),
      v.description("Opaque cursor from a previous search_case_law call"),
    ),
  ),
  court: v.optional(
    v.pipe(v.string(), v.maxLength(512), v.description("Filter by court name")),
  ),
  country: v.optional(
    v.pipe(v.string(), v.maxLength(3), v.description("Filter by country code")),
  ),
  language: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(8),
      v.description("Filter by language code"),
    ),
  ),
  decision_type: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(128),
      v.description("Filter by decision type"),
    ),
  ),
  source_id: v.optional(
    v.pipe(v.string(), v.maxLength(36), v.description("Filter by source ID")),
  ),
  date_from: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(10),
      v.description("Filter decisions from this ISO date (YYYY-MM-DD)"),
    ),
  ),
  date_to: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(10),
      v.description("Filter decisions up to this ISO date (YYYY-MM-DD)"),
    ),
  ),
});

const readContentAcrossMattersArgsSchema = v.strictObject({
  entity_id: uuidInputSchema("Entity ID"),
  cursor: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(MAX_CURSOR_LENGTH),
      v.description(
        "Opaque cursor from a previous call to read the next window of text",
      ),
    ),
  ),
});

const readCaseLawDecisionArgsSchema = v.strictObject({
  decision_id: v.pipe(
    v.string(),
    v.minLength(1),
    v.description("Case-law decision ID"),
  ),
  cursor: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(MAX_CURSOR_LENGTH),
      v.description(
        "Opaque cursor from a previous call to read the next window of decision text and citations",
      ),
    ),
  ),
});

const readContactArgsSchema = v.strictObject({
  contact_id: v.pipe(v.string(), v.minLength(1), v.description("Contact ID")),
});

const practiceJurisdictionInputSchema = v.strictObject({
  country_code: v.pipe(
    v.picklist(COUNTRY_CODES),
    v.description("ISO 3166-1 alpha-2 country code"),
  ),
  is_primary: v.pipe(
    v.boolean(),
    v.description("Whether this is the organization's primary jurisdiction"),
  ),
});

const setPracticeJurisdictionsArgsSchema = v.strictObject({
  jurisdictions: v.pipe(
    v.array(practiceJurisdictionInputSchema),
    v.minLength(1),
    v.maxLength(LIMITS.practiceJurisdictionsPerOrganization),
    v.description(
      "Practice jurisdictions for this organization. country_code is an " +
        "ISO 3166-1 alpha-2 code; exactly one entry should set is_primary " +
        "to true.",
    ),
  ),
});

// MCP tool inputs are snake_case; the persisted jurisdiction shape is
// camelCase.
type PracticeJurisdictionHandlerInput = Parameters<
  typeof normalizePracticeJurisdictions
>[0][number];

const toPracticeJurisdiction = (
  jurisdiction: v.InferOutput<typeof practiceJurisdictionInputSchema>,
): PracticeJurisdictionHandlerInput => ({
  countryCode: jurisdiction.country_code,
  isPrimary: jurisdiction.is_primary,
});

export const STELLA_TOOL_DEFINITIONS = [
  defineValibotMcpTool({
    annotations: {
      title: "List matters",
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "List the matters you can access, or get one matter's overview. Omit " +
      "matter_id to list accessible matters (filter with status, page with " +
      "cursor); list first when the user does not name a matter or you need " +
      "matter IDs for follow-up tools. Pass matter_id to return that matter's " +
      "overview instead: counts, recent entities, linked contacts, and members.",
    inputSchema: listMattersArgsSchema,
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
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Search across matters",
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Search across all accessible matters. Use this when the user explicitly " +
      "asks to search outside a single matter or you do not yet know the right matter.",
    inputSchema: searchAcrossMattersArgsSchema,
    access: "read",
    anonymized: {
      exposure: "anonymize",
      textFields: deriveTextFieldPaths(SEARCH_ACROSS_MATTERS_TEXT_FIELD_SPECS),
    },
    name: "search_across_matters",
    scope: "stella:search",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Search case law",
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Search the shared case-law corpus. Supports free-text search plus " +
      "optional filters such as court, country, language, date range, and " +
      "decision type. Each result includes a route-independent resourceName.",
    inputSchema: searchCaseLawArgsSchema,
    access: "read",
    anonymized: { exposure: "passthrough" },
    // Backed by the public case-law corpus (caseLawPublicReadDb), the same
    // surface the public routes gate behind env.isDev || env.FEATURE_PUBLIC_LAW.
    feature: "FEATURE_PUBLIC_LAW",
    name: "search_case_law",
    scope: "stella:search",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Read content across matters",
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Read a document's content, found anywhere in your accessible matters. " +
      "DOCX files are converted to Markdown with structure preserved " +
      "(headings, tables, lists); other formats return their extracted plain " +
      "text. Use after search_across_matters. Long documents are returned in " +
      "windows; pass the returned nextCursor back as cursor to read more.",
    inputSchema: readContentAcrossMattersArgsSchema,
    access: "read",
    anonymized: {
      exposure: "anonymize",
      textFields: deriveTextFieldPaths(
        READ_CONTENT_ACROSS_MATTERS_TEXT_FIELD_SPECS,
      ),
    },
    name: "read_content_across_matters",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Read case-law decision",
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Read a single case-law decision by its decision ID. Returns metadata, " +
      "plain text, citation links, source URLs, and its route-independent " +
      "resourceName. Long decision text and large citation lists are returned " +
      "in windows; pass the returned nextCursor back as cursor to read more.",
    inputSchema: readCaseLawDecisionArgsSchema,
    access: "read",
    anonymized: { exposure: "passthrough" },
    // Backed by the public case-law corpus (caseLawPublicReadDb), the same
    // surface the public routes gate behind env.isDev || env.FEATURE_PUBLIC_LAW.
    feature: "FEATURE_PUBLIC_LAW",
    name: "read_case_law_decision",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Read contact",
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Read a contact by ID. Use this after matter overview or entity metadata " +
      "surfaces a contact the user wants to inspect more closely.",
    inputSchema: readContactArgsSchema,
    access: "read",
    anonymized: {
      exposure: "anonymize",
      // Placeholder org id: derivation only ever reads `.path`, see
      // `buildContactTextFieldSpecs`'s doc comment above.
      textFields: deriveTextFieldPaths(buildContactTextFieldSpecs("")),
    },
    name: "read_contact",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    description:
      "Set the practice jurisdictions for the user's stella organization. " +
      "Call this when the org's practice jurisdictions are empty (e.g., the " +
      "user signed up via an OAuth client and skipped onboarding). Pass an " +
      "array of {country_code, is_primary}; exactly one entry should be " +
      "primary.",
    inputSchema: setPracticeJurisdictionsArgsSchema,
    // Not idempotent: the handler records a fresh audit event and bumps
    // updatedAt on every call even when the jurisdictions are unchanged, so a
    // repeat with identical args has an observable additional effect (a
    // duplicate audit entry) in this compliance context.
    annotations: {
      title: "Set practice jurisdictions",
      idempotentHint: false,
      openWorldHint: false,
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "set_practice_jurisdictions",
    scope: "stella:onboarding",
  }),
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
  `\`{ country_code, is_primary }\`) to enable jurisdiction-aware tools, or ` +
  `have the user complete onboarding at ${getAppBaseUrl()}.`;

const withOnboardingHintIfApplicable = async <TData>({
  context,
  isEmpty,
  result,
}: {
  context: McpRequestContext;
  isEmpty: boolean;
  result: InternalToolSuccess<TData>;
}): Promise<InternalToolSuccess<TData>> => {
  if (!isEmpty) {
    return result;
  }
  const jurisdictions = await loadPracticeJurisdictions(context);
  if (jurisdictions.length > 0) {
    return result;
  }
  const onboardingHint = buildOnboardingHintText();
  const additionalText = result.mcp?.additionalText;
  return {
    ...result,
    mcp: {
      ...result.mcp,
      additionalText:
        additionalText === undefined
          ? [onboardingHint]
          : [...additionalText, onboardingHint],
    },
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

const handleListMattersTool: TypedMcpToolHandler<
  v.InferInput<typeof LIST_MATTERS_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(listMattersArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const {
    cursor,
    limit: requestedLimit,
    matter_id: matterId,
    status: requestedStatus,
  } = parsed.output;

  // Detail mode: matter_id selects one matter's overview. The list-only
  // filters (status/limit/cursor) do not apply, so reject the mixed request
  // up front rather than silently ignoring them.
  if (matterId !== undefined) {
    if (
      requestedStatus !== undefined ||
      requestedLimit !== undefined ||
      cursor !== undefined
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
    return await readMatterOverview({ context, matterId });
  }

  const status = requestedStatus ?? "active";
  const limit = requestedLimit ?? DEFAULT_LIST_LIMIT;

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
      result: toolDataResult({ matters, nextCursor: page.nextCursor }),
    });
  }

  const payload = {
    matters,
    nextCursor: page.nextCursor,
  } satisfies v.InferInput<typeof LIST_MATTERS_LIST_PROJECTION>;
  const textFields = runTextFieldSpecs(
    LIST_MATTERS_LIST_TEXT_FIELD_SPECS,
    payload,
  );

  return { egress: "structured", payload, textFields };
};

// Detail branch of list_matters: one matter's overview (counts, recent
// entities, contacts, members). Reused verbatim from the former
// get_matter_overview tool, which list_matters absorbed.
const readMatterOverview = async ({
  context,
  matterId,
}: {
  context: McpRequestContext;
  matterId: string;
}): Promise<
  Awaited<
    ReturnType<
      TypedMcpToolHandler<v.InferInput<typeof LIST_MATTERS_PROJECTION>>
    >
  >
> => {
  const workspaceId = ensureWorkspaceAccess({
    context,
    workspaceId: matterId,
  });
  if (!workspaceId) {
    return notFoundResult("Matter not found or not accessible");
  }

  const [workspace, overview, contacts, members] = await Promise.all([
    (
      context.testDependencies?.readWorkspaceHandler ??
      defaultReadWorkspaceHandler
    )({
      organizationId: context.organizationId,
      scopedDb: context.scopedDb,
      workspaceId,
    }),
    (
      context.testDependencies?.readOverviewHandler ??
      defaultReadOverviewHandler
    )({
      scopedDb: context.scopedDb,
      workspaceId,
    }),
    (
      context.testDependencies?.readWorkspaceContactsHandler ??
      defaultReadWorkspaceContactsHandler
    )({
      scopedDb: context.scopedDb,
      workspaceId,
    }),
    (
      context.testDependencies?.readWorkspaceMembersHandler ??
      defaultReadWorkspaceMembersHandler
    )({
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
  } satisfies v.InferInput<typeof LIST_MATTERS_DETAIL_PROJECTION>;

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

const handleSearchAcrossMattersTool: TypedMcpToolHandler<
  v.InferInput<typeof SEARCH_ACROSS_MATTERS_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(searchAcrossMattersArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { cursor, query } = parsed.output;
  const limit = parsed.output.limit ?? DEFAULT_SEARCH_LIMIT;

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

  const result = await (
    context.testDependencies?.getSearchProvider ?? getSearchProvider
  )().search({
    query,
    organizationId: context.organizationId,
    workspaceIds: context.accessibleWorkspaceIds,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  });

  const hits = result.hits.map((hit) => ({
    entityId: brandPersistedEntityId(hit.entityId),
    workspaceId: brandPersistedWorkspaceId(hit.workspaceId),
    workspaceName: hit.workspaceName,
    name: hit.title,
    kind: hit.kind,
    // The provider builds the headline for the web UI (HTML-escaped, matches
    // wrapped in <mark>); MCP callers get it as plain text.
    headline: toPlainTextSnippet(hit.headline),
  }));

  // Hits span multiple matters; each anonymizes under its own workspace scope.
  // `workspaceName` embeds the matter name (party names), so it is redacted
  // alongside the hit name and headline to stay consistent with list_matters.
  const payload = {
    totalCount: result.totalCount,
    nextCursor: result.nextCursor,
    hits,
  } satisfies v.InferInput<typeof SEARCH_ACROSS_MATTERS_PROJECTION>;
  const textFields = runTextFieldSpecs(
    SEARCH_ACROSS_MATTERS_TEXT_FIELD_SPECS,
    payload,
  );

  return { egress: "structured", payload, textFields };
};

/**
 * Calendar validity of a `YYYY-MM-DD` filter, which the shape-only schema
 * cannot express: a pattern accepts 2024-02-30, the round-trip does not.
 * Returns the validation envelope for a bad date, `null` for a usable one.
 */
const isoDateIssue = (
  key: string,
  value: string | undefined,
): InternalToolErrorResult | null => {
  if (value === undefined) {
    return null;
  }
  const parsed = new Date(value);
  if (
    ISO_DATE_PATTERN.test(value) &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  ) {
    return null;
  }
  const message = `Invalid parameter: ${key}. Expected an ISO date in YYYY-MM-DD format`;
  return structuredErrorResult({
    code: "validation_error",
    message,
    issues: [{ path: key, message }],
    hint: `Set '${key}' to a calendar date formatted as YYYY-MM-DD.`,
  });
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
  NonNullable<Awaited<ReturnType<typeof readGatedDecisionWithDocument>>>,
  { caseNumber: string; citationsFrom: unknown[]; citationsTo: unknown[] }
>;

const isReadCaseLawDecisionSuccess = (
  value: NonNullable<Awaited<ReturnType<typeof readGatedDecisionWithDocument>>>,
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
  const ast = parseUsableDocumentAst(decision.documentAst);
  if (ast === null) {
    return null;
  }
  // A block with no text of its own (an unlabelled figure) contributes
  // nothing rather than a blank paragraph.
  return ast.blocks
    .flatMap((block) => (block.plainText === "" ? [] : [block.plainText]))
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

type DocxFieldContent = Extract<FieldContent, { type: "file" }>;

type CurrentDocument = {
  currentVersion: {
    createdAt: Date;
    fields: {
      id: SafeId<"field">;
      propertyId: SafeId<"property">;
      content: FieldContent | null;
    }[];
    id: SafeId<"entityVersion">;
  };
  extractedContent: ExtractedContentSourceProvenance | null;
  kind: string;
  name: string;
  workspaceId: McpRequestContext["accessibleWorkspaceIds"][number];
};

// SAFETY: `content` is a NOT NULL jsonb column, but that only forbids a SQL
// NULL -- a stored JSON `null` literal still reads back as JS `null` here,
// so the predicate must not dereference `.type` before checking for it.
const isDocxFileContent = (
  content: FieldContent | null | undefined,
): content is DocxFieldContent =>
  content?.type === "file" &&
  !content.encrypted &&
  content.mimeType === DOCX_MIME_TYPE;

type LoadCurrentVersionDocxMarkdownProps = {
  context: McpRequestContext;
  document: CurrentDocument;
};

/**
 * `not-docx`: the current version's extraction file (see below) is
 * confirmed NOT a DOCX (or the version has no file at all) -- stable across
 * every read of this entity, so the caller can always use plaintext with no
 * cursor-consistency risk.
 *
 * `unavailable`: the file IS a DOCX but Markdown could not be produced for
 * THIS call (S3 read failed, conversion errored, or the attempt timed out).
 * Unlike `not-docx`, this is not a stable fact about the document -- a retry
 * could succeed -- so the caller must not treat it as equivalent to
 * `not-docx` once a cursor is already in flight (see the handler below).
 */
type DocxMarkdownOutcome =
  | { kind: "not-docx" }
  | { kind: "markdown"; text: string }
  | { kind: "unavailable" };

/**
 * Convert the entity's CURRENT version file to folio's structure-preserving
 * Markdown, but only when it is a DOCX. The caller loads the entity and its
 * current version atomically before invoking this helper, so the conversion
 * never depends on a stale extracted-content projection existing first.
 *
 * File selection follows the persisted extraction source. Scanning fields for
 * the first DOCX instead would let an auxiliary DOCX field outrank the entity's
 * indexed file, returning markdown for a different document than the plaintext
 * fallback and search results describe.
 *
 * The S3 read and conversion are bounded by `docxMarkdownConversionTimeoutMs`
 * (`withTimeout`) so a stalled fetch or hung conversion cannot hang the
 * request; a timeout is reported as `unavailable`, same as any other
 * conversion failure.
 */
const loadCurrentVersionDocxMarkdown = async ({
  context,
  document,
}: LoadCurrentVersionDocxMarkdownProps): Promise<DocxMarkdownOutcome> => {
  const fileField = resolveCurrentFileSourceField({
    currentVersionId: document.currentVersion.id,
    extracted: document.extractedContent,
    fields: document.currentVersion.fields,
  });
  const file = fileField?.content?.type === "file" ? fileField.content : null;
  if (!isDocxFileContent(file)) {
    return { kind: "not-docx" };
  }

  const markdownResult = await Result.tryPromise({
    try: async () =>
      await (context.testDependencies?.withTimeout ?? withTimeout)(
        async (signal) => {
          const buffer = await readS3ArrayBuffer(
            createFileKey({
              organizationId: context.organizationId,
              workspaceId: document.workspaceId,
              fileId: file.id,
              mimeType: DOCX_MIME_TYPE,
            }),
            signal,
          );
          return await docxToMarkdown(buffer);
        },
        {
          label: "read_content_across_matters:docx-to-markdown",
          timeoutMs: LIMITS.docxMarkdownConversionTimeoutMs,
        },
      ),
    catch: (cause) => cause,
  });

  return Result.isError(markdownResult)
    ? { kind: "unavailable" }
    : { kind: "markdown", text: markdownResult.value };
};

const handleReadContentAcrossMattersTool: TypedMcpToolHandler<
  v.InferInput<typeof READ_CONTENT_ACROSS_MATTERS_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(readContentAcrossMattersArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { cursor, entity_id: rawEntityId } = parsed.output;

  const entityId = brandPersistedEntityId(rawEntityId);

  if (context.accessibleWorkspaceIds.length === 0) {
    return notFoundResult("Document not found or not accessible");
  }

  // Resolve the live entity/version before consulting any asynchronous
  // projection. This lets a fresh DOCX take the direct Markdown path and
  // provides the source identity used to reject stale cached plaintext.
  const document = await context.scopedDb((tx) =>
    tx.query.entities.findFirst({
      where: {
        id: { eq: entityId },
        workspaceId: { in: context.accessibleWorkspaceIds },
      },
      columns: { kind: true, name: true, workspaceId: true },
      with: {
        extractedContent: {
          columns: {
            sourceEntityVersionId: true,
            sourceFieldId: true,
            sourceFileId: true,
            sourceSha256Hex: true,
          },
        },
        currentVersion: {
          columns: { createdAt: true, id: true },
          with: {
            fields: {
              columns: { content: true, id: true, propertyId: true },
              orderBy: { id: "asc" },
              limit: LIMITS.propertiesCount,
            },
          },
        },
      },
    }),
  );
  if (!document?.currentVersion) {
    return notFoundResult("Document not found or not accessible");
  }
  const currentDocument = {
    currentVersion: document.currentVersion,
    extractedContent: document.extractedContent,
    kind: document.kind,
    name: document.name,
    workspaceId: document.workspaceId,
  };

  const docxOutcome = await loadCurrentVersionDocxMarkdown({
    context,
    document: currentDocument,
  });

  if (docxOutcome.kind === "unavailable" && cursor !== undefined) {
    return structuredErrorResult({
      code: "internal_error",
      message:
        "Could not continue reading this document's Markdown conversion.",
      hint: "Retry the request with the same cursor.",
      retryable: true,
    });
  }

  const projection =
    docxOutcome.kind === "markdown"
      ? null
      : await context.scopedDb(
          async (tx) =>
            await Promise.all([
              tx.query.extractedContent.findFirst({
                where: {
                  entityId: { eq: entityId },
                  organizationId: { eq: context.organizationId },
                  workspaceId: { eq: currentDocument.workspaceId },
                },
                columns: {
                  ciphertext: true,
                  extractedAt: true,
                  iv: true,
                  sourceEntityVersionId: true,
                  sourceFieldId: true,
                  sourceFileId: true,
                  sourceSha256Hex: true,
                },
              }),
              // Provenance fence: include tombstones so a rollback cannot make
              // a withdrawn version's legacy extraction readable again.
              tx.query.entityVersions.findFirst({
                where: {
                  entityId: { eq: entityId },
                  workspaceId: { eq: currentDocument.workspaceId },
                },
                columns: { id: true },
                orderBy: { versionNumber: "desc", id: "desc" },
              }),
            ]),
        );

  const currentExtracted = selectCurrentExtractedContent({
    extracted: projection?.[0],
    allowLegacy: projection?.[1]?.id === currentDocument.currentVersion.id,
    currentVersionCreatedAt: currentDocument.currentVersion.createdAt,
    currentVersionId: currentDocument.currentVersion.id,
    fields: currentDocument.currentVersion.fields,
  });
  if (docxOutcome.kind !== "markdown" && !currentExtracted) {
    return structuredErrorResult({
      code: "conflict",
      message: "Current document content is not ready",
      hint: "Call read_document to inspect contentState and searchIndexState, then follow the returned action or retry when processing completes.",
      retryable: true,
    });
  }

  const plaintext = currentExtracted
    ? await decryptContent(
        context.organizationId,
        currentExtracted.ciphertext,
        currentExtracted.iv,
      )
    : "";

  // Prefer the live DOCX-to-Markdown conversion (headings, tables, lists
  // preserved) whenever the current version holds a DOCX file; every other
  // format (PDF, images, non-document entities) uses the plain text already
  // extracted at ingestion.
  //
  // `cursor` (the char offset windowed below) is only ever valid against the
  // ONE text representation it was issued against. On a first read
  // (`cursor === undefined`) nothing has been issued yet, so a conversion
  // failure can safely fall back to plaintext. On a paginated read, the
  // caller's cursor already encodes an offset into whatever the first read
  // served; if the live conversion becomes `unavailable` mid-stream, silently
  // switching to plaintext (or vice versa) would slice a different text than
  // the cursor was computed against, producing skipped or duplicated
  // content. Surface a retryable error instead of guessing.
  let text: string;
  if (docxOutcome.kind === "markdown") {
    text = docxOutcome.text;
  } else if (docxOutcome.kind === "not-docx") {
    text = plaintext;
  } else if (cursor === undefined) {
    text = plaintext;
  } else {
    // The cursor-specific unavailable branch returned above.
    return panic("DOCX conversion unavailable without a readable fallback");
  }

  // Carry the FULL text and window it in the egress pipeline, so an
  // anonymized read redacts the whole document before slicing (slicing raw text
  // first could split an entity name across the window boundary and leak its
  // prefix). Default mode leaves name/text as-is and windows the same way.
  const initialNextCursor = (): string | null => null;
  const payload = {
    charCount: text.length,
    entityId,
    kind: currentDocument.kind,
    name: currentDocument.name,
    text,
    truncated: false,
    nextCursor: initialNextCursor(),
    workspaceId: brandPersistedWorkspaceId(currentDocument.workspaceId),
  };
  // The egress window's `apply` below mutates this object in place, so the tie
  // cannot ride on the literal: a `satisfies` clause would contextually pin
  // `truncated` to `false`, which the mutation must be able to overwrite. Tie
  // the literal's own inferred type instead.
  type ReadContentPayload = AssertNoExtraFields<
    typeof payload,
    v.InferInput<typeof READ_CONTENT_ACROSS_MATTERS_PROJECTION>
  >;

  return {
    egress: "structured",
    payload: payload satisfies ReadContentPayload,
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

const handleSearchCaseLawTool: TypedMcpToolHandler<
  v.InferInput<typeof SEARCH_CASE_LAW_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(searchCaseLawArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const {
    country,
    court,
    cursor,
    date_from: dateFrom,
    date_to: dateTo,
    decision_type: decisionType,
    language,
    query,
    source_id: sourceId,
  } = parsed.output;
  const limit = parsed.output.limit ?? DEFAULT_SEARCH_LIMIT;

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
  const dateFromIssue = isoDateIssue("date_from", dateFrom);
  if (dateFromIssue) {
    return dateFromIssue;
  }
  const dateToIssue = isoDateIssue("date_to", dateTo);
  if (dateToIssue) {
    return dateToIssue;
  }

  const result = await (
    context.testDependencies?.searchDecisionsHandler ??
    defaultSearchDecisionsHandler
  )(
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

  const payload = toolDataResult({
    facets: result.facets,
    nextCursor: result.nextCursor,
    results: result.hits.map((hit) => {
      const resource = resourceRef({
        type: RESOURCE_TYPE.CASE_LAW_DECISION,
        id: brandPersistedCaseLawDecisionId(hit.decisionId),
      });
      return {
        appUrl: buildCaseLawDecisionAppUrl({
          caseNumber: hit.caseNumber,
          country: hit.country,
          court: hit.court,
          language: hit.language,
          languageAlternates: hit.languageAlternates,
          slug: hit.slug,
        }),
        caseNumber: hit.caseNumber,
        citationCount: hit.citationCount,
        country: hit.country,
        court: hit.court,
        decisionDate: hit.decisionDate,
        decisionId: hit.decisionId,
        resourceName: serializeAuthorizedCorpusMcpResourceName(resource),
        decisionType: hit.decisionType,
        ecli: hit.ecli,
        language: hit.language,
        snippet: toPlainTextSnippet(hit.headline),
        sourceUrl: hit.sourceUrl,
      };
    }),
    totalCount: result.totalCount,
  } satisfies v.InferInput<typeof SEARCH_CASE_LAW_PROJECTION>);

  return await withOnboardingHintIfApplicable({
    context,
    isEmpty: result.hits.length === 0,
    result: payload,
  });
};

type DecisionCursorState = {
  citations: string | null | undefined;
  text: number;
};

// read_case_law_decision pages the decision text and both citation lists with
// a single compound cursor encoding [textOffset, citationsCursor].
const decodeDecisionCursor = (
  cursor: string | undefined,
): DecisionCursorState | null => {
  if (cursor === undefined) {
    return { citations: undefined, text: 0 };
  }
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 2) {
    return null;
  }
  const [text, citations] = parts;
  if (
    typeof text !== "number" ||
    !Number.isInteger(text) ||
    text < 0 ||
    (citations !== null && typeof citations !== "string")
  ) {
    return null;
  }
  return { citations, text };
};

const handleReadCaseLawDecisionTool: TypedMcpToolHandler<
  v.InferInput<typeof READ_CASE_LAW_DECISION_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(readCaseLawDecisionArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { cursor, decision_id: decisionId } = parsed.output;

  const offsets = decodeDecisionCursor(cursor);
  if (offsets === null) {
    return structuredErrorResult({
      code: "validation_error",
      message: "Invalid cursor",
      issues: [{ path: "cursor", message: "Invalid cursor" }],
      hint: "Pass the 'cursor' verbatim as returned by a previous call, or omit it for the first page.",
    });
  }

  // The same gate the public route applies, in the same shape: a
  // restricted decision does not exist for any caller, and the read that
  // answers shares the transaction that approved it.
  const result = await (
    context.testDependencies?.readGatedDecisionWithDocument ??
    defaultReadGatedDecisionWithDocument
  )({
    caseLawDb: caseLawPublicReadDb,
    locator: { kind: "id", id: brandPersistedCaseLawDecisionId(decisionId) },
    citationsCursor: offsets.citations,
    // An agent holding a token is a reader we can attribute, so its
    // interest counts as demand.
    caller: "attributed",
  });
  if (result === null) {
    return notFoundResult("Decision not found");
  }
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
  const resource = resourceRef({
    type: RESOURCE_TYPE.CASE_LAW_DECISION,
    id: brandPersistedCaseLawDecisionId(result.id),
  });

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
  const hasMore =
    textBounds.nextOffset !== null || result.citationsNextCursor !== null;
  const nextCursor = hasMore
    ? encodePaginationCursor([textBounds.end, result.citationsNextCursor])
    : null;

  return toolDataResult({
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
      citationsFrom: result.citationsFrom,
      citationsTo: result.citationsTo,
      country: result.country,
      court: result.court,
      decisionDate: toIsoDateString(result.decisionDate),
      decisionId: result.id,
      resourceName: serializeAuthorizedCorpusMcpResourceName(resource),
      decisionType: result.decisionType,
      documentUrl: result.documentUrl,
      ecli: result.ecli,
      language: result.language,
      metadata: result.metadata,
      source: result.source,
      sourceUrl: result.sourceUrl,
      text:
        plainText === null || textBounds.start >= textBounds.end
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
  } satisfies v.InferInput<typeof READ_CASE_LAW_DECISION_PROJECTION>);
};

const handleReadContactTool: TypedMcpToolHandler<
  v.InferInput<typeof READ_CONTACT_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(readContactArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }

  const contactId = brandPersistedContactId(parsed.output.contact_id);

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
  } satisfies v.InferInput<typeof READ_CONTACT_PROJECTION>;

  const textFields = runTextFieldSpecs(
    buildContactTextFieldSpecs(context.organizationId),
    payload,
  );

  return { egress: "structured", payload, textFields };
};

const handleSetPracticeJurisdictionsTool: TypedMcpToolHandler<
  v.InferInput<typeof SET_PRACTICE_JURISDICTIONS_PROJECTION>
> = async ({ args, context }) => {
  const hasPermission = hasEffectiveAuthority(context, {
    organizationSettings: ["update"],
  });
  if (!hasPermission) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(setPracticeJurisdictionsArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }

  const primaryCount = parsed.output.jurisdictions.filter(
    (jurisdiction) => jurisdiction.is_primary,
  ).length;
  if (primaryCount > 1) {
    return errorResult("Only one jurisdiction can be primary");
  }

  const practiceJurisdictions = normalizePracticeJurisdictions(
    parsed.output.jurisdictions.map(toPracticeJurisdiction),
  );

  await context.scopedDb(async (tx) => {
    await upsertPracticeJurisdictions({
      organizationId: context.organizationId,
      practiceJurisdictions,
      recordAuditEvent: context.recordAuditEvent,
      tx,
    });
  });

  identifyOrganizationJurisdictions(
    context.organizationId,
    practiceJurisdictions,
  );

  return toolDataResult({ practiceJurisdictions } satisfies v.InferInput<
    typeof SET_PRACTICE_JURISDICTIONS_PROJECTION
  >);
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
