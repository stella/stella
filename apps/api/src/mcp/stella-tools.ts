import { panic, Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";
import { DECISION_READ_RESOLUTION } from "@stll/api-contract/case-law-decision-resolution";
import {
  PUBLIC_CASE_LAW_COUNTRIES,
  publicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import {
  exactDecisionMatches,
  parseDecisionQuery,
} from "@stll/api-contract/decision-query-intent";
import {
  DEFAULT_SEARCH_SORT,
  SEARCH_SORTS,
  SEARCH_TOTAL_TYPE,
} from "@stll/api-contract/search";
import { decisionReporterGrammarForJurisdiction } from "@stll/api-contract/us-reporter-citation";
import { mapWithConcurrency } from "@stll/concurrency";
import { COUNTRY_CODES } from "@stll/country-codes";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { workspaces } from "@/api/db/schema";
import type {
  ContactEmail,
  ContactPhone,
  FieldContent,
} from "@/api/db/schema-validators";
import { splitCaseReference } from "@/api/handlers/case-law/case-number";
import {
  DECISION_DOCUMENT_HYDRATION,
  DECISION_DOCUMENT_STATE,
  decisionDocumentState,
  readsSharedPublicLawCorpus,
  type DecisionDocumentHydration,
  type readGatedDecisionWithDocument,
} from "@/api/handlers/case-law/decisions/get-deferred-document";
import type { DecisionIdentityRow } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { interpretDecisionQuery } from "@/api/handlers/case-law/decisions/search-interpretation";
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
import { captureError } from "@/api/lib/analytics/capture";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  CITATION_READ_DIRECTIONS,
  CITATION_TREATMENTS,
} from "@/api/lib/case-law/citation-vocabulary";
import { DECISION_LOOKUP_STATUS } from "@/api/lib/case-law/decision-lookup-vocabulary";
import { DECISION_READ_STATUS } from "@/api/lib/case-law/decision-read-vocabulary";
import {
  type AssertNoExtraFields,
  type LIST_MATTERS_DETAIL_PROJECTION,
  type LIST_MATTERS_LIST_PROJECTION,
  LIST_MATTERS_PROJECTION,
  LOOKUP_CASE_LAW_PROJECTION,
  READ_CASE_LAW_CITATIONS_PROJECTION,
  READ_CASE_LAW_DECISION_PROJECTION,
  READ_CONTACT_PROJECTION,
  READ_CONTENT_ACROSS_MATTERS_PROJECTION,
  SEARCH_ACROSS_MATTERS_PROJECTION,
  SEARCH_CASE_LAW_PROJECTION,
  SET_PRACTICE_JURISDICTIONS_PROJECTION,
} from "@/api/lib/chat/projections";
import { decryptContent } from "@/api/lib/content-encryption";
import {
  resolveCurrentFileSourceField,
  selectCurrentExtractedContent,
  type ExtractedContentSourceProvenance,
} from "@/api/lib/document-content-provenance";
import { scannedDocxToMarkdown } from "@/api/lib/file-scan/document-parsers";
import { readStoredFile } from "@/api/lib/file-scan/stored-file";
import { createFileKey } from "@/api/lib/files/utils";
import { decisionDocketGrammarForCountry } from "@/api/lib/legal-search/adapter-manifest";
import { CORPUS_SEARCH_CURSOR_MAX_LENGTH } from "@/api/lib/legal-search/corpus-search-cursor";
import { LIMITS } from "@/api/lib/limits";
import { getAppBaseUrl } from "@/api/lib/mcp-connectors/app-urls";
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
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { decodeCursor } from "@/api/lib/search/cursor";
import { getSearchReader } from "@/api/lib/search/provider";
import { withTimeout } from "@/api/lib/with-timeout";
import type { McpRequestContext } from "@/api/mcp/context";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import { loadPracticeJurisdictions } from "@/api/mcp/practice-jurisdictions";
import {
  defaultLookupDecisionsByIdentity,
  defaultReadGatedDecisionCitations,
  defaultReadGatedDecisionWithDocument,
  defaultSearchDecisionsHandler,
  isReadCaseLawDecisionSuccess,
  isSearchCaseLawSuccess,
  type SearchCaseLawSuccess,
} from "@/api/mcp/public-law-handlers";
import { serializeAuthorizedCorpusMcpResourceName } from "@/api/mcp/resource-serialization";
import {
  defineTextFieldSpec,
  deriveTextFieldPaths,
  runTextFieldSpecs,
} from "@/api/mcp/text-field-spec";
import type {
  InternalToolSuccess,
  McpTextFieldSpec,
  McpToolDefinition,
  McpToolHandler,
  TypedMcpToolHandler,
} from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import {
  buildCaseLawDecisionAppUrl,
  countryInputSchema,
  countryNormalization,
  cursorInput,
  DEFAULT_LIST_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  ensureWorkspaceAccess,
  errorResult,
  handlerResultMessage,
  ISO_DATE_SCHEMA,
  MCP_CONTENT_MAX_CHARS,
  MAX_LIST_LIMIT,
  MAX_SEARCH_LIMIT,
  notFoundResult,
  nullAsAbsent,
  resolveWindowBounds,
  structuredErrorResult,
  toolDataResult,
  toPlainCorpusText,
  toPlainTextSnippet,
  uuidInputSchema,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import {
  defineChatProjectionMcpToolOutput,
  defineValibotMcpTool,
} from "@/api/mcp/valibot-tool-definition";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

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

type StellaToolName =
  | "list_matters"
  | "lookup_case_law"
  | "read_case_law_citations"
  | "read_case_law_decision"
  | "read_contact"
  | "read_content_across_matters"
  | "search_case_law"
  | "search_across_matters"
  | "set_practice_jurisdictions";

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

const listMattersArgsSchema = nullAsAbsent(
  v.strictObject({
    matter_id: v.optional(
      uuidInputSchema(
        "Matter ID to return a single matter's overview; omit to list matters",
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
    cursor: cursorInput({
      description:
        "Opaque cursor from a previous list_matters call to fetch the next page",
    }),
  }),
);

const searchAcrossMattersArgsSchema = nullAsAbsent(
  v.strictObject({
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
    cursor: cursorInput({
      description:
        "Opaque cursor from a previous search_across_matters call to fetch the next page",
    }),
  }),
);

/**
 * The corpus countries `search_case_law` answers for. Rendered into both the
 * input description and the rejection hint, so a model reading either knows
 * the spelling: asked for German case law, a model wrote `DEU` where the
 * orientation eval expected `DE`, and the corpus admits neither.
 */
const ADMITTED_CASE_LAW_COUNTRIES = PUBLIC_CASE_LAW_COUNTRIES.join(", ");

/** Named because the country ask names the call to change; a census test binds
 *  this to the tool's own `name` so a rename cannot leave a stale hint. */
const SEARCH_CASE_LAW_TOOL = "search_case_law";
const LOOKUP_CASE_LAW_TOOL = "lookup_case_law";
const SET_PRACTICE_JURISDICTIONS_TOOL = "set_practice_jurisdictions";

/**
 * A merged cursor carries one sub-cursor per query, JSON-wrapped and
 * base64url-encoded. The sub-cursor bound comes from the engine cursor's own
 * codec rather than a number written here: under query expansion an engine
 * cursor carries a 64-character dictionary identity, and a cap guessed below
 * what the engine emits rejects a page boundary this tool itself handed out.
 * The envelope adds three JSON characters per entry, two for the brackets,
 * and four base64 characters per three bytes.
 */
const CASE_LAW_SEARCH_CURSOR_MAX_LENGTH = Math.ceil(
  (((CORPUS_SEARCH_CURSOR_MAX_LENGTH + 3) * LIMITS.caseLawSearchQueriesMax +
    2) *
    4) /
    3,
);

const searchCaseLawArgsSchema = nullAsAbsent(
  v.strictObject({
    queries: v.pipe(
      v.array(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(LIMITS.searchQueryMaxLength),
        ),
      ),
      v.minLength(1),
      v.maxLength(LIMITS.caseLawSearchQueriesMax),
      v.description(
        `Several phrasings of ONE question, at most ${LIMITS.caseLawSearchQueriesMax}. Their pages are merged and deduplicated within the page, so a reformulation costs no extra round trip; one phrasing is a valid call.`,
      ),
    ),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(MAX_SEARCH_LIMIT),
        v.description(
          "Merged-page size, split evenly across the queries (at least one hit each)",
        ),
      ),
    ),
    cursor: cursorInput({
      description:
        "Opaque cursor from a previous search_case_law call. It continues the same queries, in the same order. It carries each query's own position and not what earlier pages emitted, so a decision several queries return can appear on more than one page: key results by decisionId.",
      maxLength: CASE_LAW_SEARCH_CURSOR_MAX_LENGTH,
    }),
    court: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(512),
        v.description("Filter by court name"),
      ),
    ),
    country: countryInputSchema(
      `Required corpus country. Admitted: ${ADMITTED_CASE_LAW_COUNTRIES}.`,
    ),
    language: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(8),
        v.description("Filter by language code"),
      ),
    ),
    decision_type: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(128),
        v.description("Filter by decision type"),
      ),
    ),
    source_id: v.optional(uuidInputSchema("Filter by source ID")),
    date_from: v.optional(
      v.pipe(
        ISO_DATE_SCHEMA,
        v.maxLength(10),
        v.description("Filter decisions from this ISO date (YYYY-MM-DD)"),
      ),
    ),
    date_to: v.optional(
      v.pipe(
        ISO_DATE_SCHEMA,
        v.maxLength(10),
        v.description("Filter decisions up to this ISO date (YYYY-MM-DD)"),
      ),
    ),
    sort: v.optional(
      v.pipe(
        v.picklist(SEARCH_SORTS),
        v.description(
          `Result order; defaults to '${DEFAULT_SEARCH_SORT}'. 'relevance' blends text match with citation authority and court rank; 'newest' orders by decision date and returns only dated decisions. A query naming a decision outright (docket number, ECLI) is answered by identity lookup, which ignores this option.`,
        ),
      ),
    ),
    strict: v.optional(
      v.pipe(
        v.boolean(),
        v.description(
          "Require every word of each query, function words included. Off by default: a query phrased as a question carries words no judgment is written with, and `searches[].queryUsed` reports what was required. Pass true when every word matters.",
        ),
      ),
    ),
  }),
);

const lookupCaseLawArgsSchema = nullAsAbsent(
  v.strictObject({
    identifiers: v.pipe(
      v.array(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(LIMITS.caseLawIdentifierMaxLength),
        ),
      ),
      v.minLength(1),
      v.maxLength(LIMITS.caseLawLookupIdentifiersMax),
      v.description(
        `The references to resolve, at most ${LIMITS.caseLawLookupIdentifiersMax} per call: a docket number as the court writes it (the sheet number after it is ignored), an ECLI, or a reporter citation (volume, reporter, first page; a pin is ignored). Each is answered on its own.`,
      ),
    ),
    country: countryInputSchema(
      `Required corpus country. Admitted: ${ADMITTED_CASE_LAW_COUNTRIES}.`,
    ),
  }),
);

const readContentAcrossMattersArgsSchema = nullAsAbsent(
  v.strictObject({
    entity_id: uuidInputSchema("Entity ID"),
    cursor: cursorInput({
      description:
        "Opaque cursor from a previous call to read the next window of text",
    }),
  }),
);

const readCaseLawDecisionArgsSchema = nullAsAbsent(
  v.strictObject({
    decision_ids: v.pipe(
      v.array(uuidInputSchema("Case-law decision ID")),
      v.minLength(1),
      v.maxLength(LIMITS.caseLawDecisionBatchMax),
      v.description(
        `The decisions to read, at most ${LIMITS.caseLawDecisionBatchMax} per call. Each id is answered on its own, so one unknown id does not sink the rest.`,
      ),
    ),
    cursor: cursorInput({
      description:
        "Opaque cursor from a previous call to read the next window of one decision's text and citations. Accepted only alongside a single decision id.",
    }),
  }),
);

const readCaseLawCitationsArgsSchema = nullAsAbsent(
  v.strictObject({
    decision_id: uuidInputSchema("Case-law decision ID"),
    direction: v.pipe(
      v.picklist(CITATION_READ_DIRECTIONS),
      v.description(
        "Which side of the citation graph to read: 'cites' for the decisions this decision cites, 'cited_by' for the decisions that cite it. Citing is not agreeing: both sides carry negative treatments.",
      ),
    ),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(LIMITS.caseLawDecisionCitationPageSize),
        v.description(
          `Citations per page; defaults to ${LIMITS.caseLawAgentCitationPageSizeDefault}, at most ${LIMITS.caseLawDecisionCitationPageSize}.`,
        ),
      ),
    ),
    cursor: cursorInput({
      description:
        "Opaque cursor from a previous read_case_law_citations call to read the next page",
    }),
  }),
);

const readContactArgsSchema = nullAsAbsent(
  v.strictObject({
    contact_id: uuidInputSchema("Contact ID"),
  }),
);

const practiceJurisdictionInputSchema = v.strictObject({
  // The picklist stays: alpha-2 is what the row holds, and membership is worth
  // enforcing structurally. The country kind is bound to the same property so a
  // name or an alpha-3 code is read into that alpha-2 before it is checked.
  country_code: v.pipe(
    v.picklist(COUNTRY_CODES),
    v.description("Country of this practice jurisdiction"),
  ),
  is_primary: v.pipe(
    v.boolean(),
    v.description("Whether this is the organization's primary jurisdiction"),
  ),
});

const setPracticeJurisdictionsArgsSchema = nullAsAbsent(
  v.strictObject({
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
  }),
);

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
      destructiveHint: false,
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
      destructiveHint: false,
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
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Search case law within one country. `queries` carries several " +
      "phrasings of one question and merges their results; matchedQueries " +
      "names the phrasings that returned each hit. `limit` is the merged " +
      "page, split evenly across them. Filters: court, language, dates, " +
      "decision type, source_id (a `facets.source` bucket's `value`). " +
      `\`sort\` defaults to '${DEFAULT_SEARCH_SORT}'. Facets and total ` +
      "describe ONE query's whole set: first page of a single-query call " +
      "only, null otherwise. Function words are not required terms; " +
      "`searches[]` gives each phrasing's `queryUsed` and warnings, and " +
      "`strict` requires every word. Each hit carries citationAuthority " +
      "(the score the ranking blends in), matchingPassages (at least 1) and " +
      "a route-independent resourceName. read_case_law_citations gives the " +
      "polarity of the citing decisions.",
    inputSchema: searchCaseLawArgsSchema,
    inputNormalization: {
      country: countryNormalization({
        spelling: "alpha-3",
        admitted: PUBLIC_CASE_LAW_COUNTRIES,
        tool: SEARCH_CASE_LAW_TOOL,
      }),
    },
    access: "read",
    anonymized: { exposure: "passthrough" },
    // Backed by the public case-law corpus (caseLawPublicReadDb), the same
    // surface the public routes gate behind env.isDev || env.FEATURE_PUBLIC_LAW.
    feature: "FEATURE_PUBLIC_LAW",
    name: SEARCH_CASE_LAW_TOOL,
    scope: "stella:search",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Look up case law by identifier",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Resolve case references to decisions: docket numbers, ECLIs and " +
      "reporter citations. Answered from the identity columns, never by ranking text, so a hit is the " +
      "decision named, not one citing it. Every `identifiers[]` entry is " +
      "answered on its own, in input order, under `status`: `found` carries " +
      "that decision's id, resourceName, appUrl, reference, court, " +
      "date and ECLI; `ambiguous` carries the candidates: a docket is unique to a " +
      "court, not to the corpus, and picking one would cite the wrong " +
      "court; `not_found` says what to call instead; `lookup_failed` means " +
      "the read did not complete, so retry that entry. Use this when the " +
      "user names a case; use search_case_law when they describe one. Pass " +
      "a `found` decisionId to read_case_law_decision for the text.",
    inputSchema: lookupCaseLawArgsSchema,
    inputNormalization: {
      country: countryNormalization({
        spelling: "alpha-3",
        admitted: PUBLIC_CASE_LAW_COUNTRIES,
        tool: LOOKUP_CASE_LAW_TOOL,
      }),
    },
    access: "read",
    anonymized: { exposure: "passthrough" },
    // Backed by the public case-law corpus (caseLawPublicReadDb), the same
    // surface the public routes gate behind env.isDev || env.FEATURE_PUBLIC_LAW.
    feature: "FEATURE_PUBLIC_LAW",
    name: LOOKUP_CASE_LAW_TOOL,
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Read content across matters",
      destructiveHint: false,
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
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Read case-law decisions by id. Every `decision_ids[]` " +
      "entry is answered on its own, in input order, under `status`: `found` " +
      "carries the decision (metadata, text fields, plain text, source " +
      "URLs, resourceName, citation ids), while `not_found` (no such public " +
      "decision) and `pending` (its publisher document is not stored yet) " +
      "carry a message. Prefer one batched call over one per decision; the " +
      "call's text budget is shared, so read one id alone for a whole " +
      "decision's text. It does NOT say how the citing courts treated a " +
      "decision: its citation entries carry no treatment and no surrounding " +
      "text. For that call read_case_law_citations ({ decision_id: " +
      "'<uuid>', direction: 'cited_by' }). Long text and citation lists " +
      "come back in windows; pass an entry's nextCursor back as cursor with " +
      "that one id.",
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
      title: "Read case-law citations",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    // Against a per-tool character ceiling, so each clause earns its place:
    // what the tool answers, what a direction does not imply, the closed
    // polarity vocabulary and the two readings a model would otherwise guess
    // at, the passage's bounds, and the next call spelled out.
    description:
      "How the decisions citing one stood to it, or what it cited. One page, " +
      "each citation with a polarity and an excerpt of its paragraph. " +
      "`cited_by` returns the decisions that cite this one, `cites` the ones " +
      "it cites; neither means agreement. " +
      `\`polarity\` is one of ${CITATION_TREATMENTS.join(", ")}: a stance, ` +
      "not a doctrinal act, so it never says followed, distinguished or " +
      "overruled. 'unclassified' means none was read, 'mixed' that mentions " +
      "disagreed. `passage.text` is at most " +
      `${LIMITS.caseLawCitationPassageChars} characters centred on the citation, cut when ` +
      "`passage.truncated`; `passage.mention` is 'sole', " +
      "'classified_section' (the mention the polarity came from), or " +
      "'latest_of_several' (it may not be). Example: { decision_id: " +
      "'<uuid>', direction: " +
      "'cited_by', limit: 20 }. Pass nextCursor back as cursor.",
    inputSchema: readCaseLawCitationsArgsSchema,
    access: "read",
    anonymized: { exposure: "passthrough" },
    // Backed by the public case-law corpus (caseLawPublicReadDb), the same
    // surface the public routes gate behind env.isDev || env.FEATURE_PUBLIC_LAW.
    feature: "FEATURE_PUBLIC_LAW",
    name: "read_case_law_citations",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Read contact",
      destructiveHint: false,
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
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
      readOnlyHint: false,
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: SET_PRACTICE_JURISDICTIONS_TOOL,
    inputNormalization: {
      "jurisdictions[].country_code": countryNormalization({
        spelling: "alpha-2",
        tool: SET_PRACTICE_JURISDICTIONS_TOOL,
      }),
    },
    scope: "stella:onboarding",
  }),
] as const satisfies readonly McpToolDefinition[];

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
    context.testDependencies?.getSearchReader ?? getSearchReader
  )(context.scopedDb).search({
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
          const stored = await readStoredFile({
            key: createFileKey({
              organizationId: context.organizationId,
              workspaceId: document.workspaceId,
              fileId: file.id,
              mimeType: DOCX_MIME_TYPE,
            }),
            mimeType: DOCX_MIME_TYPE,
            signal,
          });
          return await scannedDocxToMarkdown(stored);
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

type CaseLawSearchHit = SearchCaseLawSuccess["hits"][number];

/**
 * One decision in the merged page: the hit as the best-ranking query returned
 * it, that rank, and which queries returned it at all.
 */
type MergedCaseLawHit = {
  hit: CaseLawSearchHit;
  matchedQueries: number[];
  rank: number;
};

/**
 * Merge one page per query into one page of distinct decisions.
 *
 * A hit carries no score on the wire, so its rank position within its own
 * query's page is the only comparable signal: a decision keeps the hit from
 * the query that ranked it highest, and ties go to the decision more
 * phrasings agree on, then to its id so the order is total.
 *
 * Within the page, and deliberately not across pages. Suppressing a repeat on
 * a later page means carrying every emitted id in the cursor: at the page
 * sizes this tool serves that is kilobytes of opaque string a model has to
 * copy back verbatim, and bounding it means a page count past which paging
 * simply stops. Repeating a decision costs a slot; refusing to page costs the
 * results. The input descriptions say which guarantee this is, and
 * `decisionId` is the key a caller dedupes on.
 */
const mergeCaseLawSearchHits = (
  pagesByQuery: readonly (readonly CaseLawSearchHit[])[],
): readonly MergedCaseLawHit[] => {
  const merged = new Map<string, MergedCaseLawHit>();
  for (const [queryIndex, hits] of pagesByQuery.entries()) {
    for (const [rank, hit] of hits.entries()) {
      const seen = merged.get(hit.decisionId);
      if (seen === undefined) {
        merged.set(hit.decisionId, { hit, matchedQueries: [queryIndex], rank });
        continue;
      }
      // Queries are walked in index order, so this stays ascending.
      seen.matchedQueries.push(queryIndex);
      if (rank < seen.rank) {
        seen.hit = hit;
        seen.rank = rank;
      }
    }
  }
  // The id tiebreak is a code-unit comparison, not a collation: a decision id
  // is an opaque key, and all the order has to be is total and stable.
  return [...merged.values()].toSorted(
    (left, right) =>
      left.rank - right.rank ||
      right.matchedQueries.length - left.matchedQueries.length ||
      (left.hit.decisionId < right.hit.decisionId ? -1 : 1),
  );
};

/**
 * The per-query cursors a call resumes from. `null` is a query whose page
 * ended, which is not re-run; `undefined` is a query on its first page.
 */
type CaseLawSearchCursors =
  | { type: "cursors"; cursors: readonly (string | null | undefined)[] }
  | { type: "invalid" }
  | { type: "count_mismatch"; encoded: number };

/**
 * A single query pages on the engine's own cursor, passed through verbatim;
 * several queries page on one envelope carrying a sub-cursor each. The two
 * grammars are disjoint (an engine cursor never decodes to a JSON array), so
 * one decode tells them apart and a cursor issued for a different number of
 * queries is rejected rather than silently continuing the wrong one.
 */
const resolveCaseLawSearchCursors = ({
  cursor,
  queryCount,
}: {
  cursor: string | undefined;
  queryCount: number;
}): CaseLawSearchCursors => {
  // An empty string is a model spelling an absent optional, not a page
  // boundary: decoding it would answer "invalid cursor" for a first page.
  if (cursor === undefined || cursor.length === 0) {
    return {
      type: "cursors",
      cursors: Array.from({ length: queryCount }, () => undefined),
    };
  }
  const parts = decodePaginationCursor(cursor);
  if (parts === null) {
    return queryCount === 1
      ? { type: "cursors", cursors: [cursor] }
      : { type: "count_mismatch", encoded: 1 };
  }
  if (
    !parts.every(
      (part): part is string | null =>
        part === null || typeof part === "string",
    )
  ) {
    return { type: "invalid" };
  }
  return parts.length === queryCount
    ? { type: "cursors", cursors: parts }
    : { type: "count_mismatch", encoded: parts.length };
};

/** One query's page, or the mark of a query whose page had already ended. */
type CaseLawQueryOutcome =
  | { exhausted: true }
  | { exhausted: false; page: SearchCaseLawSuccess };

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
    queries,
    sort,
    source_id: sourceId,
    strict,
  } = parsed.output;
  const limit = parsed.output.limit ?? DEFAULT_SEARCH_LIMIT;
  const publicCountry = publicCaseLawCountry(country);
  if (publicCountry === null) {
    return notFoundResult(
      "Case-law country not found",
      `Pass one of the admitted country codes: ${ADMITTED_CASE_LAW_COUNTRIES}.`,
    );
  }

  const resolved = resolveCaseLawSearchCursors({
    cursor,
    queryCount: queries.length,
  });
  if (resolved.type === "invalid") {
    return structuredErrorResult({
      code: "validation_error",
      message: "Invalid cursor",
      issues: [{ path: "cursor", message: "Invalid cursor" }],
      hint: "Pass the 'cursor' verbatim as returned by a previous search_case_law call, or omit it for the first page.",
    });
  }
  if (resolved.type === "count_mismatch") {
    return structuredErrorResult({
      code: "validation_error",
      message: "Cursor was issued for a different set of queries",
      issues: [
        {
          path: "cursor",
          message: `This cursor continues ${String(resolved.encoded)} queries; the call carries ${String(queries.length)}.`,
        },
      ],
      hint: `Send the same ${String(resolved.encoded)} queries this cursor was issued for, in the same order, or omit 'cursor' to start a new search.`,
    });
  }

  // `limit` bounds the MERGED page, so each query is asked for its share of
  // it and every hit a query returns is emitted. Slicing the merge instead
  // would drop decisions no continuation could reach: a sub-cursor sits at
  // its query's page end, so anything cut from that page is gone. One hit per
  // query is the floor, which is the one case a merged page can exceed
  // `limit`.
  const perQueryLimit = Math.max(1, Math.floor(limit / queries.length));

  const search =
    context.testDependencies?.searchDecisionsHandler ??
    defaultSearchDecisionsHandler;
  // One request per phrasing, assembled once. A phrasing whose cursor says it
  // is exhausted runs nothing, and still has to report which of its words the
  // search required, so the request it would have made is what answers that
  // rather than a second reading of the filters.
  const grammar = decisionDocketGrammarForCountry(publicCountry);
  const reporters = decisionReporterGrammarForJurisdiction(publicCountry);
  const requests = queries.map((query, index) => {
    // Three states, not two: a string continues this phrasing, `undefined` is
    // its first page, and `null` means it ended on an earlier one. Only a
    // string is a cursor the search can be given.
    const subCursor = resolved.cursors[index];
    const body = {
      query,
      limit: perQueryLimit,
      ...(typeof subCursor === "string" ? { cursor: subCursor } : {}),
      ...(court === undefined ? {} : { court }),
      country: publicCountry,
      ...(language === undefined ? {} : { language }),
      ...(decisionType === undefined ? {} : { decisionType }),
      ...(sourceId === undefined
        ? {}
        : { sourceId: brandPersistedCaseLawSourceId(sourceId) }),
      ...(dateFrom === undefined ? {} : { dateFrom }),
      ...(dateTo === undefined ? {} : { dateTo }),
      ...(sort === undefined ? {} : { sort }),
      ...(strict === undefined ? {} : { strict }),
    };
    return {
      body,
      query,
      subCursor,
      interpretation: interpretDecisionQuery(
        body,
        parseDecisionQuery(query, { grammar, reporters }),
      ),
    };
  });
  const outcomes = await mapWithConcurrency({
    items: requests,
    limit: LIMITS.caseLawSearchQueriesMax,
    operation: async ({ body, subCursor }) => {
      if (subCursor === null) {
        return { exhausted: true } as const;
      }
      return {
        exhausted: false as const,
        result: await search(body, caseLawPublicReadDb),
      };
    },
  });

  // A query that failed sinks the call: a merged page silently missing one
  // phrasing reads as "that phrasing found nothing", which is a different
  // answer.
  const pages: CaseLawQueryOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.exhausted) {
      pages.push({ exhausted: true });
      continue;
    }
    const resultMessage = handlerResultMessage(outcome.result);
    if (resultMessage) {
      return errorResult(resultMessage);
    }
    if (!isSearchCaseLawSuccess(outcome.result)) {
      return errorResult("Case-law search failed");
    }
    pages.push({ exhausted: false, page: outcome.result });
  }

  const merged = mergeCaseLawSearchHits(
    pages.map((outcome) => (outcome.exhausted ? [] : outcome.page.hits)),
  );

  // Facets and a total count describe ONE query's result set. A merged page
  // spans several, and no count the engine can give describes their union.
  const first = pages.at(0) ?? panic("Case-law search ran no query");
  const single =
    queries.length === 1 && !first.exhausted ? first.page : undefined;
  const subCursors = pages.map((outcome) =>
    outcome.exhausted ? null : outcome.page.nextCursor,
  );
  // Every query exhausted means the merged page is the last one; otherwise the
  // envelope carries each query's own continuation.
  const mergedCursor = subCursors.every((subCursor) => subCursor === null)
    ? null
    : encodePaginationCursor(subCursors);

  // One entry per query, in the order the call sent them. Facets and a total
  // describe one query's result set, so a merged page carries none; which
  // words a phrasing required is a property of that phrasing alone, so every
  // phrasing reports its own.
  const searches = requests.map(({ interpretation, query }, index) => {
    const outcome = pages.at(index);
    if (outcome === undefined || outcome.exhausted) {
      // A phrasing its cursor declared exhausted ran nothing this call, so it
      // carries no warning about a page. What it required is still what it
      // required on the page that exhausted it, which is why `queryUsed`
      // comes from the interpretation rather than from the phrasing as sent.
      return { query, queryUsed: interpretation.queryUsed, warnings: [] };
    }
    return {
      query,
      queryUsed: outcome.page.queryUsed,
      warnings: outcome.page.warnings,
    };
  });

  const payload = toolDataResult({
    facets: single === undefined ? null : single.facets,
    searches,
    nextCursor: single === undefined ? mergedCursor : single.nextCursor,
    results: merged.map(({ hit, matchedQueries }) => {
      const resource = resourceRef({
        type: RESOURCE_TYPE.CASE_LAW_DECISION,
        id: brandPersistedCaseLawDecisionId(hit.decisionId),
      });
      return {
        matchedQueries,
        appUrl: buildCaseLawDecisionAppUrl({
          caseNumber: hit.caseNumber,
          country: hit.country,
          court: hit.court,
          decisionId: hit.decisionId,
          language: hit.language,
          languageAlternates: hit.languageAlternates,
          slug: hit.slug,
        }),
        caseNumber: hit.caseNumber,
        citationAuthority: hit.citationAuthority,
        citationCount: hit.citationCount,
        country: hit.country,
        court: hit.court,
        courtAbbreviation: hit.courtAbbreviation,
        decisionDate: hit.decisionDate,
        decisionId: hit.decisionId,
        resourceName: serializeAuthorizedCorpusMcpResourceName(resource),
        decisionType: hit.decisionType,
        ecli: hit.ecli,
        language: hit.language,
        matchingPassages: hit.matchingPassages,
        snippet: toPlainTextSnippet(hit.headline),
        sourceUrl: hit.sourceUrl,
      };
    }),
    total:
      single === undefined
        ? { type: SEARCH_TOTAL_TYPE.NOT_COUNTED }
        : single.total,
  } satisfies v.InferInput<typeof SEARCH_CASE_LAW_PROJECTION>);

  return await withOnboardingHintIfApplicable({
    context,
    isEmpty: merged.length === 0,
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

type GatedDecisionRead = Awaited<
  ReturnType<typeof readGatedDecisionWithDocument>
>;

type DecisionItemResult = v.InferInput<
  typeof READ_CASE_LAW_DECISION_PROJECTION
>["items"][number];

/**
 * Whether a later fetch can still land this decision's document. A
 * stored-only read reports a pending document instead of crawling for it, so
 * the batch decides how many crawls one call is worth; a document no fetch
 * could ever land is not one of those decisions, and `decisionDocumentState`
 * is what tells the two apart.
 */
const isDecisionDocumentPending = (
  read: GatedDecisionRead,
  readsSharedCorpus: boolean,
): boolean =>
  read !== null &&
  isReadCaseLawDecisionSuccess(read) &&
  decisionDocumentState(read, readsSharedCorpus) ===
    DECISION_DOCUMENT_STATE.pending;

const decisionNotFoundItem = (decisionId: string): DecisionItemResult => ({
  decisionId,
  message:
    "No decision the public may read has this id. Find one with search_case_law and pass its decisionId.",
  status: DECISION_READ_STATUS.notFound,
});

/**
 * The primary reference's kind and every typed identifier, only where the
 * primary is not a docket: there `caseNumber` would otherwise read as one,
 * and the docket, if any, is among the identifiers.
 */
const nonDocketReference = ({
  caseNumberType,
  identifiers,
}: Pick<GatedDecisionRead, "caseNumberType" | "identifiers">) =>
  caseNumberType === DECISION_IDENTIFIER_TYPES.CASE_NUMBER
    ? {}
    : { caseNumberType, identifiers };

type DecisionItemOptions = {
  decisionId: string;
  /** See `decisionDocumentState`: the deployment's half of the answer. */
  readsSharedCorpus: boolean;
  /** The window this entry's share of the call's text budget allows. */
  maxTextChars: number;
  read: GatedDecisionRead;
  textOffset: number;
};

const decisionItemResult = ({
  decisionId,
  maxTextChars,
  read,
  readsSharedCorpus,
  textOffset,
}: DecisionItemOptions): DecisionItemResult => {
  if (read === null || !isReadCaseLawDecisionSuccess(read)) {
    return decisionNotFoundItem(decisionId);
  }
  // Still pending after everything this call was willing to do, AND a later
  // fetch could still land it: either the budget did not reach this entry, or
  // the fetch it got ran out of time. Both leave the document queued, and the
  // caller's next move is the same, so neither is a `found` with nothing in
  // it. A document no fetch can land is the other answer entirely, and falls
  // through to `found` below so its metadata and citations stay readable.
  if (isDecisionDocumentPending(read, readsSharedCorpus)) {
    return {
      decisionId,
      message: `The publisher document for this decision is not stored yet. Read this decision id on its own to fetch it; this call's fetch budget is ${String(LIMITS.caseLawDecisionBatchHydrationsMax)} documents.`,
      status: DECISION_READ_STATUS.pending,
    };
  }

  // allowsRedistribution gates whether the decision is publicly
  // readable; allowsDerivedAi additionally gates feeding full text to a
  // model, which is exactly this tool's context.
  const aiTextAllowed = read.source.allowsDerivedAi;
  const resource = resourceRef({
    type: RESOURCE_TYPE.CASE_LAW_DECISION,
    id: brandPersistedCaseLawDecisionId(read.id),
  });

  const plainText = aiTextAllowed
    ? toPlainCorpusText({
        blocks: parseUsableDocumentAst(read.documentAst)?.blocks ?? null,
        fulltext: read.fulltext,
      })
    : null;
  const textLength = plainText === null ? 0 : plainText.length;

  const textBounds = resolveWindowBounds(textLength, textOffset, maxTextChars);
  const hasMore =
    textBounds.nextOffset !== null || read.citationsNextCursor !== null;

  return {
    decisionId,
    ...(read.resolution.type === DECISION_READ_RESOLUTION.ABSORBED_SUPPLEMENT
      ? {
          message: `This id named written reasons that are now part of decision ${read.id}, returned here. Cite ${read.id} from now on.`,
        }
      : {}),
    nextCursor: hasMore
      ? encodePaginationCursor([textBounds.end, read.citationsNextCursor])
      : null,
    status: DECISION_READ_STATUS.found,
    decision: {
      appUrl: buildCaseLawDecisionAppUrl({
        caseNumber: read.caseNumber,
        country: read.country,
        court: read.court,
        decisionId: read.id,
        language: read.language,
        languageAlternates: read.languageAlternates,
        slug: read.slug,
      }),
      caseNumber: read.caseNumber,
      ...nonDocketReference(read),
      citationsFrom: read.citationsFrom,
      citationsTo: read.citationsTo,
      country: read.country,
      court: read.court,
      courtAbbreviation: read.courtAbbreviation,
      decisionDate: toIsoDateString(read.decisionDate),
      decisionId: read.id,
      resourceName: serializeAuthorizedCorpusMcpResourceName(resource),
      decisionType: read.decisionType,
      documentUrl: read.documentUrl,
      ecli: read.ecli,
      language: read.language,
      metadata: read.metadata,
      textFields: read.textFields,
      source: read.source,
      sourceUrl: read.sourceUrl,
      sourceAttributionUrl: read.sourceAttributionUrl,
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
      // The licence and the missing document are different answers, and a
      // caller that conflated them would retry one that will never change.
      ...(aiTextAllowed &&
      decisionDocumentState(read, readsSharedCorpus) ===
        DECISION_DOCUMENT_STATE.unavailable
        ? {
            textUnavailableReason:
              "The publisher's document for this decision is not available from this corpus, so the metadata and citations here are all it carries.",
          }
        : {}),
    },
  };
};

const handleReadCaseLawDecisionTool: TypedMcpToolHandler<
  v.InferInput<typeof READ_CASE_LAW_DECISION_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(readCaseLawDecisionArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { cursor, decision_ids: decisionIds } = parsed.output;

  // A window cursor belongs to ONE decision's text and citation lists, so it
  // cannot say which entry of a batch it continues.
  if (cursor !== undefined && decisionIds.length > 1) {
    return structuredErrorResult({
      code: "validation_error",
      message: "A cursor continues one decision",
      issues: [
        {
          path: "cursor",
          message: `A cursor continues one decision's text; the call carries ${String(decisionIds.length)} decision ids.`,
        },
      ],
      hint: "Pass one decision id with a cursor to continue its text.",
    });
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

  // The same gate the public route applies, in the same shape: a
  // restricted decision does not exist for any caller, and the read that
  // answers shares the transaction that approved it. Documents are NOT
  // hydrated here: a batch decides below how many publisher fetches it is
  // worth.
  const read =
    context.testDependencies?.readGatedDecisionWithDocument ??
    defaultReadGatedDecisionWithDocument;
  const readDecision = async (
    decisionId: string,
    documentHydration: DecisionDocumentHydration,
  ): Promise<GatedDecisionRead> =>
    await read({
      caseLawDb: caseLawPublicReadDb,
      locator: { kind: "id", id: brandPersistedCaseLawDecisionId(decisionId) },
      citationsCursor: offsets.citations,
      // An agent holding a token is a reader we can attribute, so its
      // interest counts as demand.
      caller: "attributed",
      documentHydration,
    });

  // The deployment's half of every document-state answer, resolved once for
  // the call rather than per entry.
  const readsSharedCorpus = (
    context.testDependencies?.readsSharedPublicLawCorpus ??
    readsSharedPublicLawCorpus
  )();

  // One read per distinct id: a batch naming the same decision twice reads it
  // once and answers both of its positions.
  const uniqueIds = [...new Set(decisionIds)];
  const reads = new Map(
    await mapWithConcurrency({
      items: uniqueIds,
      limit: LIMITS.caseLawCitationPassageConcurrency,
      operation: async (decisionId) =>
        [
          decisionId,
          await readDecision(
            decisionId,
            DECISION_DOCUMENT_HYDRATION.storedOnly,
          ),
        ] as const,
    }),
  );

  // An error the read itself reports (a rejected cursor) is about the call,
  // not about one entry, so it answers for the call.
  const failure = uniqueIds
    .flatMap((decisionId) => {
      const value = reads.get(decisionId);
      const message =
        value === null || value === undefined
          ? null
          : handlerResultMessage(value);
      return message === null ? [] : [message];
    })
    .at(0);
  if (failure !== undefined) {
    return errorResult(failure);
  }

  const readOf = (decisionId: string): GatedDecisionRead => {
    if (!reads.has(decisionId)) {
      return panic(`No gated read ran for decision ${decisionId}`);
    }
    return reads.get(decisionId) ?? null;
  };

  // The pending entries this call fetches, in input order. Anything past the
  // budget, and anything whose fetch does not finish, stays pending and is
  // reported as such.
  const fetchedIds = uniqueIds
    .filter((decisionId) =>
      isDecisionDocumentPending(readOf(decisionId), readsSharedCorpus),
    )
    .slice(0, LIMITS.caseLawDecisionBatchHydrationsMax);
  // The re-read runs the gate again rather than hydrating the row it already
  // holds: a publisher fetch must not run inside the read transaction, and
  // the content that answers has to come from a state the gate approved.
  for (const [index, hydrated] of (
    await mapWithConcurrency({
      items: fetchedIds,
      limit: LIMITS.caseLawDecisionBatchHydrationsMax,
      operation: async (decisionId) =>
        await readDecision(decisionId, DECISION_DOCUMENT_HYDRATION.onDemand),
    })
  ).entries()) {
    const decisionId =
      fetchedIds[index] ?? panic("Lost a hydrated case-law decision id");
    reads.set(decisionId, hydrated);
  }

  // The call's text budget is shared across the entries, so a batch cannot
  // answer with twenty full windows of decision text. A single id keeps the
  // whole window, which is what a caller reading one decision asked for.
  const maxTextChars = Math.max(
    1,
    Math.floor(MCP_CONTENT_MAX_CHARS / decisionIds.length),
  );

  return toolDataResult({
    items: decisionIds.map((decisionId) =>
      decisionItemResult({
        decisionId,
        maxTextChars,
        read: readOf(decisionId),
        readsSharedCorpus,
        textOffset: offsets.text,
      }),
    ),
  } satisfies v.InferInput<typeof READ_CASE_LAW_DECISION_PROJECTION>);
};

// --- lookup_case_law -------------------------------------------------------

type DecisionLookupItem = v.InferInput<
  typeof LOOKUP_CASE_LAW_PROJECTION
>["items"][number];

const SEARCH_INSTEAD_HINT =
  "Search the decision's text with search_case_law instead, or pass the docket exactly as the court wrote it.";

const decisionIdentityOf = (row: DecisionIdentityRow) => ({
  appUrl: buildCaseLawDecisionAppUrl({
    caseNumber: row.caseNumber,
    country: row.country,
    court: row.court,
    decisionId: row.id,
    language: row.language,
    languageAlternates: row.languageAlternates,
    slug: row.slug,
  }),
  caseNumber: row.caseNumber,
  court: row.court,
  decisionDate: row.decisionDate,
  decisionId: row.id,
  ecli: row.ecli,
  resourceName: serializeAuthorizedCorpusMcpResourceName(
    resourceRef({
      type: RESOURCE_TYPE.CASE_LAW_DECISION,
      id: brandPersistedCaseLawDecisionId(row.id),
    }),
  ),
});

/**
 * What one identifier resolved to. A grammar declining the spelling is a
 * different answer from the corpus not holding it: both send the caller to a
 * text search, but only one of them is worth re-spelling first.
 */
type DecisionLookupOutcome =
  | { type: "not_an_identifier" }
  | { type: "failed"; message: string }
  | { type: "matches"; matches: readonly DecisionIdentityRow[] };

const lookupItemResult = ({
  identifier,
  outcome,
}: {
  identifier: string;
  outcome: DecisionLookupOutcome;
}): DecisionLookupItem => {
  if (outcome.type === "failed") {
    return {
      identifier,
      message: `Resolving this reference failed: ${outcome.message}. Retry this reference; the entries beside it are unaffected.`,
      status: DECISION_LOOKUP_STATUS.lookupFailed,
    };
  }
  if (outcome.type === "not_an_identifier") {
    return {
      identifier,
      hint: SEARCH_INSTEAD_HINT,
      message:
        "This is not a docket number, ECLI or reporter citation in a grammar the corpus reads.",
      status: DECISION_LOOKUP_STATUS.notFound,
    };
  }

  const [only, ...rest] = outcome.matches;
  if (only === undefined) {
    return {
      identifier,
      hint: SEARCH_INSTEAD_HINT,
      message: "No decision in this corpus carries this identifier.",
      status: DECISION_LOOKUP_STATUS.notFound,
    };
  }
  if (rest.length === 0) {
    return {
      identifier,
      ...decisionIdentityOf(only),
      status: DECISION_LOOKUP_STATUS.found,
    };
  }

  // The cap lands here, on what survived the exact-identity filter: the
  // identity read is bounded wider than the listed maximum precisely because
  // that filter drops rows whose key merely collided.
  const listed = outcome.matches.slice(0, LIMITS.caseLawLookupCandidatesMax);
  const count =
    outcome.matches.length > LIMITS.caseLawLookupCandidatesMax
      ? `More than ${String(LIMITS.caseLawLookupCandidatesMax)} decisions`
      : `${String(outcome.matches.length)} decisions`;
  return {
    identifier,
    candidates: listed.map(decisionIdentityOf),
    message: `${count} carry this identifier, at different courts or in different languages. Pick one by its court and date and pass its decisionId to read_case_law_decision.`,
    status: DECISION_LOOKUP_STATUS.ambiguous,
  };
};

const handleLookupCaseLawTool: TypedMcpToolHandler<
  v.InferInput<typeof LOOKUP_CASE_LAW_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(lookupCaseLawArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { country, identifiers } = parsed.output;
  const publicCountry = publicCaseLawCountry(country);
  if (publicCountry === null) {
    return notFoundResult(
      "Case-law country not found",
      `Pass one of the admitted country codes: ${ADMITTED_CASE_LAW_COUNTRIES}.`,
    );
  }

  // The jurisdiction's own docket grammar, read the way `searchDecisionsHandler`
  // reads it: `11 C 153/2025` is a docket in Czechia and not in Poland, and a
  // lookup that classified an identifier differently from the search beside it
  // would decline a reference that search resolves.
  const grammar = decisionDocketGrammarForCountry(publicCountry);
  const reporters = decisionReporterGrammarForJurisdiction(publicCountry);
  const lookup =
    context.testDependencies?.lookupDecisionsByIdentity ??
    defaultLookupDecisionsByIdentity;

  // One resolution per distinct identifier; a list naming the same decision
  // twice resolves it once and answers both of its positions.
  const uniqueIdentifiers = [...new Set(identifiers)];
  const outcomes = new Map(
    await mapWithConcurrency({
      items: uniqueIdentifiers,
      limit: LIMITS.caseLawLookupConcurrency,
      operation: async (
        identifier,
      ): Promise<readonly [string, DecisionLookupOutcome]> => {
        // The sheet number names a page of the court file, not the decision,
        // so it is dropped before the grammars see the reference.
        const { caseNumber } = splitCaseReference(identifier);
        const intent = parseDecisionQuery(caseNumber, {
          grammar,
          reporters,
        });
        if (intent.type !== "identifier") {
          return [identifier, { type: "not_an_identifier" }];
        }
        // The identity columns, not the text index: a ranked page of the
        // decisions that MENTION a docket can leave out the decision that IS
        // it, and which provider a deployment runs decides whether the search
        // handler has an identity branch at all.
        const read = await Result.tryPromise({
          try: async () =>
            await lookup({
              caseLawDb: caseLawPublicReadDb,
              country: publicCountry,
              locator: { kind: intent.kind, value: intent.value },
            }),
          catch: (cause) => cause,
        });
        if (Result.isError(read)) {
          captureError(read.error);
          return [
            identifier,
            { type: "failed", message: "the corpus read did not complete" },
          ];
        }
        // A second guard, cheap and independent of the statement above: an
        // entry only reports a decision that answers to the reference by one
        // of its own identifiers.
        return [
          identifier,
          {
            type: "matches",
            matches: exactDecisionMatches(intent, read.value, {
              grammar,
              reporters,
            }),
          },
        ];
      },
    }),
  );

  const outcomeOf = (identifier: string): DecisionLookupOutcome =>
    outcomes.get(identifier) ??
    panic(`No lookup ran for identifier ${identifier}`);

  return toolDataResult({
    items: identifiers.map((identifier) =>
      lookupItemResult({
        identifier,
        outcome: outcomeOf(identifier),
      }),
    ),
  } satisfies v.InferInput<typeof LOOKUP_CASE_LAW_PROJECTION>);
};

const handleReadCaseLawCitationsTool: TypedMcpToolHandler<
  v.InferInput<typeof READ_CASE_LAW_CITATIONS_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(readCaseLawCitationsArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { cursor, decision_id: decisionId, direction } = parsed.output;
  const limit =
    parsed.output.limit ?? LIMITS.caseLawAgentCitationPageSizeDefault;

  // The same publication gate the decision read applies, and for the same
  // reason: a decision's citation texts are as much its content as its
  // full text.
  const read = await (
    context.testDependencies?.readGatedDecisionCitations ??
    defaultReadGatedDecisionCitations
  )({
    caseLawDb: caseLawPublicReadDb,
    cursor,
    decisionId: brandPersistedCaseLawDecisionId(decisionId),
    direction,
    limit,
  });
  if (read === null) {
    return notFoundResult(
      "Decision not found",
      "Find a decision with search_case_law and pass its decisionId as decision_id.",
    );
  }
  if (read.type === "invalid_cursor") {
    return structuredErrorResult({
      code: "validation_error",
      message: "Invalid cursor",
      issues: [{ path: "cursor", message: "Invalid cursor" }],
      hint: "Pass the 'cursor' verbatim as returned by a previous read_case_law_citations call, or omit it for the first page.",
    });
  }

  return toolDataResult({
    decisionId,
    direction,
    nextCursor: read.page.nextCursor,
    citations: read.page.items.map((item) => ({
      citationId: item.id,
      citationText: item.citationText,
      polarity: item.treatment,
      decision:
        item.decision === null
          ? null
          : {
              appUrl: buildCaseLawDecisionAppUrl({
                caseNumber: item.decision.caseNumber,
                country: item.decision.country,
                court: item.decision.court,
                decisionId: item.decision.id,
                language: item.decision.language,
                languageAlternates: item.decision.languageAlternates,
                slug: item.decision.slug,
              }),
              caseNumber: item.decision.caseNumber,
              ...(item.decision.caseNumberType ===
              DECISION_IDENTIFIER_TYPES.CASE_NUMBER
                ? {}
                : { caseNumberType: item.decision.caseNumberType }),
              citationAuthority: item.decision.citationAuthority,
              court: item.decision.court,
              decisionDate: item.decision.decisionDate,
              decisionId: item.decision.id,
              decisionType: item.decision.decisionType,
              resourceName: serializeAuthorizedCorpusMcpResourceName(
                resourceRef({
                  type: RESOURCE_TYPE.CASE_LAW_DECISION,
                  id: brandPersistedCaseLawDecisionId(item.decision.id),
                }),
              ),
            },
      passage: item.passage,
    })),
  } satisfies v.InferInput<typeof READ_CASE_LAW_CITATIONS_PROJECTION>);
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
  lookup_case_law: handleLookupCaseLawTool,
  read_case_law_citations: handleReadCaseLawCitationsTool,
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
  {
    list_matters: defineChatProjectionMcpToolOutput(LIST_MATTERS_PROJECTION),
    lookup_case_law: defineChatProjectionMcpToolOutput(
      LOOKUP_CASE_LAW_PROJECTION,
    ),
    read_case_law_citations: defineChatProjectionMcpToolOutput(
      READ_CASE_LAW_CITATIONS_PROJECTION,
    ),
    read_case_law_decision: defineChatProjectionMcpToolOutput(
      READ_CASE_LAW_DECISION_PROJECTION,
    ),
    read_contact: defineChatProjectionMcpToolOutput(READ_CONTACT_PROJECTION),
    read_content_across_matters: defineChatProjectionMcpToolOutput(
      READ_CONTENT_ACROSS_MATTERS_PROJECTION,
    ),
    search_across_matters: defineChatProjectionMcpToolOutput(
      SEARCH_ACROSS_MATTERS_PROJECTION,
    ),
    search_case_law: defineChatProjectionMcpToolOutput(
      SEARCH_CASE_LAW_PROJECTION,
    ),
    set_practice_jurisdictions: defineChatProjectionMcpToolOutput(
      SET_PRACTICE_JURISDICTIONS_PROJECTION,
    ),
  },
);
