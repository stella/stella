import { panic, Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { AGENT_INPUT_NORMALIZATION_KIND } from "@stll/agent-input";
import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";
import { DECISION_READ_RESOLUTION } from "@stll/api-contract/case-law-decision-resolution";
import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import {
  PUBLIC_CASE_LAW_COUNTRIES,
  publicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import {
  DECISION_TEXT_FIELD_KEYS,
  DECISION_TEXT_SOURCE,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import {
  type DecisionIdentityResolution,
  parseDecisionQuery,
  resolveDecisionIdentity,
} from "@stll/api-contract/decision-query-intent";
import { publicCountryUnavailable } from "@stll/api-contract/public-country-capability";
import {
  SEARCH_PAGE_END,
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET,
  DEFAULT_SEARCH_SORT,
  SEARCH_SORTS,
  searchPageEnd,
  SEARCH_TOTAL_NOT_COUNTED,
} from "@stll/api-contract/search";
import { decisionReporterGrammarForJurisdiction } from "@stll/api-contract/us-reporter-citation";
import { mapWithConcurrency } from "@stll/concurrency";
import { COUNTRY_CODES } from "@stll/country-codes";
import { parseCaseLawDecisionAst } from "@stll/legal-ast/case-law-reader";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { workspaces } from "@/api/db/schema";
import type {
  ContactEmail,
  ContactPhone,
  FieldContent,
} from "@/api/db/schema-validators";
import { envBase } from "@/api/env-base";
import type { readGatedDecisionCitationDigest } from "@/api/handlers/case-law/decisions/citation-digest";
import {
  DECISION_DOCUMENT_STATE,
  decisionDocumentState,
  documentHydrationFor,
  readsSharedPublicLawCorpus,
  STORED_ONLY_DOCUMENT_HYDRATION,
  type DecisionDocumentHydration,
  type readGatedDecisionWithDocument,
} from "@/api/handlers/case-law/decisions/get-deferred-document";
import {
  decisionIdentityLocatorOf,
  type DecisionIdentityRow,
} from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { interpretDecisionQuery } from "@/api/handlers/case-law/decisions/search-interpretation";
import { dateOfBirthFromColumns } from "@/api/handlers/contacts/person-details";
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
import type { CaseLawSearchGuidanceMode } from "@/api/lib/case-law/search-guidance-mode";
import {
  type AgentCaseLawSearchWarning,
  manyRequiredTermsWarning,
  withFacetValues,
} from "@/api/lib/case-law/search-warnings";
import { projectCaseLawCourt } from "@/api/lib/chat/case-law-court-projection";
import {
  LIST_MATTERS_DETAIL_PROJECTION,
  LIST_MATTERS_LIST_PROJECTION,
  LIST_MATTERS_PROJECTION,
  LOOKUP_CASE_LAW_PROJECTION,
  CASE_LAW_COVERAGE_PROJECTION,
  READ_CASE_LAW_CITATIONS_PROJECTION,
  READ_CASE_LAW_DECISION_PROJECTION,
  READ_CONTACT_PROJECTION,
  READ_CONTENT_ACROSS_MATTERS_PROJECTION,
  SEARCH_ACROSS_MATTERS_PROJECTION,
  SEARCH_CASE_LAW_PROJECTION,
  SET_PRACTICE_JURISDICTIONS_PROJECTION,
} from "@/api/lib/chat/projections";
import { decryptContent } from "@/api/lib/content-encryption";
import { loadPracticeJurisdictions } from "@/api/lib/db/practice-jurisdictions";
import {
  resolveCurrentFileSourceField,
  selectCurrentExtractedContent,
  type ExtractedContentSourceProvenance,
} from "@/api/lib/document-content-provenance";
import { scannedDocxToMarkdown } from "@/api/lib/file-scan/document-parsers";
import { readStoredFile } from "@/api/lib/file-scan/stored-file";
import { createFileKey } from "@/api/lib/files/utils";
import { decisionDocketGrammarForCountry } from "@/api/lib/legal-search/adapter-manifest";
import { tokenizeCorpusFreeText } from "@/api/lib/legal-search/corpus-query";
import { CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH } from "@/api/lib/legal-search/corpus-search-cursor";
import { corpusTokens } from "@/api/lib/legal-search/corpus-tokens";
import { isSearchIndexUnavailable } from "@/api/lib/legal-search/search-index-unavailable";
import { LIMITS } from "@/api/lib/limits";
import { getAppBaseUrl } from "@/api/lib/mcp-connectors/app-urls";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { projectionPayload } from "@/api/lib/projection-totality";
import {
  getTenantActionSizePolicy,
  normalizeTenantPageLimit as normalizePage,
} from "@/api/lib/rate-limit/action-size-limits";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedCaseLawSourceId,
  brandPersistedContactId,
  brandPersistedEntityId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { decodeCursor } from "@/api/lib/search/cursor";
import { getSearchReader } from "@/api/lib/search/provider";
import {
  ACTION_COST_CALL_KIND,
  actionRequestObserver,
} from "@/api/lib/usage/action-costs/context";
import { withTimeout } from "@/api/lib/with-timeout";
import { resolveCourtFilter } from "@/api/mcp/case-law-court-filter";
import { decisionBlockDeepLink } from "@/api/mcp/case-law-decision-link";
import {
  decisionOutline,
  locateDecisionBlocks,
  type LocatedDecisionBlock,
} from "@/api/mcp/case-law-decision-outline";
import {
  citationSummaryOutput,
  compactDecisionMetadata,
  decisionParagraphs,
  decisionTextAllowances,
  decisionTextVersion,
  pageOfOffset,
  paragraphsMatching,
  textPageSpan,
  textPageStarts,
} from "@/api/mcp/case-law-decision-read";
import {
  CASE_LAW_SEARCH_GUIDANCE_RAISES_MANY_REQUIRED_TERMS,
  MANY_REQUIRED_TERMS_THRESHOLD,
  searchCaseLawTexts,
} from "@/api/mcp/case-law-search-guidance";
import type { McpRequestContext } from "@/api/mcp/context";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import {
  defaultLookupDecisionsByIdentity,
  defaultReadCaseLawCoverageHandler,
  defaultReadGatedDecisionCitationDigest,
  defaultReadGatedDecisionCitations,
  defaultReadGatedDecisionWithDocument,
  defaultSearchDecisionsHandler,
  isReadCaseLawDecisionSuccess,
  isSearchCaseLawSuccess,
  type ReadCaseLawDecisionSuccess,
  type SearchCaseLawSuccess,
} from "@/api/mcp/public-law-handlers";
import { READ_CONTACT_COLUMNS } from "@/api/mcp/read-contact-columns";
import { serializeAuthorizedCorpusMcpResourceName } from "@/api/mcp/resource-serialization";
import {
  defineTextFieldSpec,
  deriveTextFieldPaths,
  runTextFieldSpecs,
} from "@/api/mcp/text-field-spec";
import type {
  InternalToolErrorResult,
  McpTextFieldSpec,
  McpToolDefinition,
  McpToolHandler,
  TypedMcpToolHandler,
} from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import {
  buildCaseLawDecisionAppUrl,
  legalCitationLinkFields,
  countryInputSchema,
  countryNormalization,
  cursorInput,
  DEFAULT_LIST_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  ensureWorkspaceAccess,
  errorResult,
  FILTER_NORMALIZATION,
  handlerResultMessage,
  internalFailureResult,
  invalidCursorResult,
  ISO_DATE_SCHEMA,
  MAX_LIST_LIMIT,
  MAX_SEARCH_LIMIT,
  MCP_CONTENT_MAX_CHARS,
  notFoundResult,
  nullAsAbsent,
  searchIndexUnavailableResult,
  structuredEgressPlan,
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

import { CASE_LAW_RESULTS_RESOURCE_URI } from "./apps/resource-uri";
import { boundCaseLawSearchHeadnotes } from "./case-law-search-headnotes";

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
  | "case_law_coverage"
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

const CASE_LAW_COVERAGE_TOOL = "case_law_coverage";
const caseLawCoverageArgsSchema = nullAsAbsent(
  v.strictObject({
    country: v.optional(
      v.pipe(
        countryInputSchema(
          "Corpus country; omit for all jurisdictions, including those in preparation.",
        ),
        v.minLength(LIMITS.caseLawCoverageCountryMinLength),
      ),
    ),
  }),
);

/** Named because the country ask names the call to change; a census test binds
 *  this to the tool's own `name` so a rename cannot leave a stale hint. */
const SEARCH_CASE_LAW_TOOL = "search_case_law";

/** What the engine answers for a cursor it cannot decode. */
const INVALID_CURSOR_MESSAGE = "Invalid cursor";
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
export const CASE_LAW_SEARCH_CURSOR_MAX_LENGTH = Math.ceil(
  (((CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH + 3) *
    LIMITS.caseLawSearchQueriesMax +
    2) *
    4) /
    3,
);

/** Read once at module load: tools/list is fixed for a running server. */
const SEARCH_CASE_LAW_TEXTS = searchCaseLawTexts(
  envBase.MCP_CASE_LAW_SEARCH_GUIDANCE,
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
      v.description(SEARCH_CASE_LAW_TEXTS.queries),
    ),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(MAX_SEARCH_LIMIT),
        v.description(SEARCH_CASE_LAW_TEXTS.limit),
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
    courts: v.optional(
      v.pipe(
        v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
        v.minLength(1),
        v.maxLength(16),
        v.description(SEARCH_CASE_LAW_TEXTS.courts),
      ),
    ),
    category: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(128),
        v.description(
          'Exact publisher category from metadata.category, for example "A" or "B"; this does not imply Sbírka publication. Applied to live rows within the bounded candidate scan; corpus-index facets and total are unavailable.',
        ),
      ),
    ),
    has_legal_sentence: v.optional(
      v.pipe(
        v.boolean(),
        v.description(
          "True requires a non-empty stored legal sentence (právní věta); false selects decisions without one. Applied to live rows within the bounded candidate scan; corpus-index facets and total are unavailable.",
        ),
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
        `The references to resolve, at most ${LIMITS.caseLawLookupIdentifiersMax} per call: a docket number as the court writes it, with the sheet number when the court publishes one (it picks a single decision when the file holds several), or an ECLI. Each is answered on its own.`,
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

const DECISION_READ_INCLUDE = [
  "details",
  "metadata",
  "textFields",
  "source",
  "citations",
  "outline",
] as const;

/** The most decision text one windowed read_case_law_decision call answers with. */
export const READ_DECISION_BATCH_MAX_TEXT_CHARS = 40_000;

/**
 * The most text a `full` read answers with, for one decision or a whole
 * batch: the window a reasoning or citation task reads at once.
 */
export const READ_DECISION_FULL_MAX_TEXT_CHARS = 200_000;

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
    max_chars: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(MCP_CONTENT_MAX_CHARS),
        v.description(
          `Requested page size per decision, 1–${MCP_CONTENT_MAX_CHARS} characters. A batch stays within ${READ_DECISION_BATCH_MAX_TEXT_CHARS} characters: each decision gets an even share, and unused characters finish other decisions in input order when one fits whole; a decision still cut keeps the even share. Omitted, the batch shares ${MCP_CONTENT_MAX_CHARS} characters the same way.`,
        ),
      ),
    ),
    page: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(LIMITS.caseLawDecisionFirstPage),
        v.description(
          "Which page of the text to return, from 1 (the default): page N is the Nth window of the page size. Applies to every decision of a batch. Keep max_chars the same while paging.",
        ),
      ),
    ),
    full: v.optional(
      v.pipe(
        v.boolean(),
        v.description(
          `true returns the whole text in one page, up to ${READ_DECISION_FULL_MAX_TEXT_CHARS} characters (shared by a batch; unused shares finish other decisions in input order when one fits whole); a longer text continues on page 2. Takes no max_chars.`,
        ),
      ),
    ),
    text_version: v.optional(
      v.pipe(
        v.string(),
        v.maxLength(LIMITS.caseLawDecisionTextVersionMaxLength),
        v.description(
          "The textVersion a previous page returned. If the text has changed since, the answer is the requested page of the current text, marked versionChanged. Single decision id only.",
        ),
      ),
    ),
    query: v.optional(
      v.pipe(
        v.string(),
        v.maxLength(LIMITS.caseLawIdentifierMaxLength),
        v.description(
          "Words to find: returns only the paragraphs containing all of them (any inflection), each with its neighbours, 1-based position, publisher label (or null), verbatim enclosing headingPath and deep link, instead of a page. Takes no page or full.",
        ),
      ),
    ),
    include: v.optional(
      v.pipe(
        v.array(v.picklist(DECISION_READ_INCLUDE)),
        v.description(
          "Optional fields: details (court, date, ECLI, url, source_url), metadata (publisher fields not stated elsewhere), textFields (published abstract, headnote, legalSentence, summary), source (publisher name), citations (summary), outline (single decision only). Omit for all on page 1 and none on later pages or with query. [] returns text and identity only.",
        ),
      ),
    ),
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
    consumesServices: false,
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
    readClass: "tenant",
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
    consumesServices: false,
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
    readClass: "tenant",
    anonymized: {
      exposure: "anonymize",
      textFields: deriveTextFieldPaths(SEARCH_ACROSS_MATTERS_TEXT_FIELD_SPECS),
    },
    name: "search_across_matters",
    scope: "stella:search",
  }),
  defineValibotMcpTool({
    consumesServices: true,
    annotations: {
      title: "Search case law",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    description: `${SEARCH_CASE_LAW_TEXTS.description} Use \`url\` for the reader and \`source_url\` for the publisher.`,
    inputSchema: searchCaseLawArgsSchema,
    inputNormalization: {
      country: countryNormalization({
        spelling: "alpha-3",
        admitted: PUBLIC_CASE_LAW_COUNTRIES,
        tool: SEARCH_CASE_LAW_TOOL,
      }),
      court: FILTER_NORMALIZATION,
      courts: { kind: "string-list" },
      category: FILTER_NORMALIZATION,
      language: FILTER_NORMALIZATION,
      decision_type: FILTER_NORMALIZATION,
    },
    access: "read",
    readClass: "public",
    anonymized: { exposure: "passthrough" },
    // Backed by the public case-law corpus (caseLawPublicReadDb), the same
    // surface the public routes gate behind the same feature flag.
    feature: "FEATURE_PUBLIC_LAW",
    _meta: {
      ui: {
        resourceUri: CASE_LAW_RESULTS_RESOURCE_URI,
        visibility: ["model", "app"],
      },
    },
    name: SEARCH_CASE_LAW_TOOL,
    scope: "stella:search",
  }),
  defineValibotMcpTool({
    consumesServices: false,
    annotations: {
      title: "Read case-law coverage",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Report case-law availability, decision counts, year ranges and court breakdowns per jurisdiction. Use before concluding that a decision is missing from the corpus; in-preparation counts describe held decisions that public search cannot yet find.",
    inputSchema: caseLawCoverageArgsSchema,
    inputNormalization: {
      country: countryNormalization({
        spelling: "alpha-3",
        admitted: CASE_LAW_JURISDICTIONS,
        tool: CASE_LAW_COVERAGE_TOOL,
      }),
    },
    access: "read",
    readClass: "public",
    anonymized: { exposure: "passthrough" },
    feature: "FEATURE_PUBLIC_LAW",
    name: CASE_LAW_COVERAGE_TOOL,
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    consumesServices: true,
    annotations: {
      title: "Look up case law by identifier",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Resolve case references to decisions: docket numbers as the courts " +
      "write them and ECLIs. Matches identity columns, not ranked text or citations. Each " +
      "`identifiers[]` entry is answered on its own, in input order, under " +
      "`status`: `found` carries that decision's id, resourceName, appUrl, " +
      "caseNumber (citable, not always a docket), court, date and " +
      "ECLI; `incomplete_identifier` names the missing docket components; " +
      "`ambiguous` carries several real candidates: a docket is unique per " +
      "court, so none is picked; `not_found` says what to " +
      "call instead; `lookup_failed`: retry that " +
      "entry. Use this when the user names a case; use search_case_law when " +
      "they describe one. Pass a `found` decisionId to " +
      "read_case_law_decision for the text and typed identifiers. " +
      "Use `url` for the reader and `source_url` for the publisher.",
    inputSchema: lookupCaseLawArgsSchema,
    inputNormalization: {
      country: countryNormalization({
        spelling: "alpha-3",
        admitted: PUBLIC_CASE_LAW_COUNTRIES,
        tool: LOOKUP_CASE_LAW_TOOL,
      }),
    },
    access: "read",
    readClass: "public",
    anonymized: { exposure: "passthrough" },
    // Backed by the public case-law corpus (caseLawPublicReadDb), the same
    // surface the public routes gate behind the same feature flag.
    feature: "FEATURE_PUBLIC_LAW",
    _meta: {
      ui: {
        resourceUri: CASE_LAW_RESULTS_RESOURCE_URI,
        visibility: ["model", "app"],
      },
    },
    name: LOOKUP_CASE_LAW_TOOL,
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    consumesServices: false,
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
    readClass: "tenant",
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
    consumesServices: true,
    annotations: {
      title: "Read case-law decision",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Read `decision_ids[]` in order. `page` selects a `max_chars` window; " +
      "entries give page/pageCount and textSource (ast or fulltext). Pass " +
      "textVersion as text_version; versionChanged flags changed text. " +
      `\`full: true\` returns whole text up to ${READ_DECISION_FULL_MAX_TEXT_CHARS} chars. ` +
      "`query` returns matches and neighbours with position, publisher label, " +
      "verbatim headingPath and deep links. Page 1 adds details (`url` reader, " +
      "`source_url` publisher), metadata, textFields and citation summaries " +
      "(citedBy count, polarity, top 5 citers; cites with held decisionIds). " +
      "All citations: read_case_law_citations ({ decision_id: '<uuid>', " +
      "direction: 'cited_by' }). One id gets an outline with pages and links. " +
      "`include` picks fields; [] returns text and identity only.",
    inputSchema: readCaseLawDecisionArgsSchema,
    inputNormalization: {
      max_chars: {
        kind: AGENT_INPUT_NORMALIZATION_KIND.number,
        range: "clamp",
      },
      page: { kind: AGENT_INPUT_NORMALIZATION_KIND.number, range: "clamp" },
      include: { kind: "string-list" },
    },
    access: "read",
    readClass: "public",
    anonymized: { exposure: "passthrough" },
    // Backed by the public case-law corpus (caseLawPublicReadDb), the same
    // surface the public routes gate behind the same feature flag.
    feature: "FEATURE_PUBLIC_LAW",
    name: "read_case_law_decision",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    consumesServices: true,
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
      "Read how citing decisions stood to one, or what it cited. One page, " +
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
      "'latest_of_several' (it may not be). Pass nextCursor back as cursor. " +
      "Use `url` for the reader and `source_url` for the publisher.",
    inputSchema: readCaseLawCitationsArgsSchema,
    access: "read",
    readClass: "public",
    anonymized: { exposure: "passthrough" },
    // Backed by the public case-law corpus (caseLawPublicReadDb), the same
    // surface the public routes gate behind the same feature flag.
    feature: "FEATURE_PUBLIC_LAW",
    name: "read_case_law_citations",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    consumesServices: false,
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
    readClass: "tenant",
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
    consumesServices: false,
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
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
      readOnlyHint: false,
    },
    access: "write",
    accountAccess: "standard",
    permissions: {
      type: "all",
      permissions: { organizationSettings: ["update"] },
    },
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

const buildOnboardingNextStep = () =>
  `This organization has no practice jurisdictions yet. Call ` +
  `${SET_PRACTICE_JURISDICTIONS_TOOL} with \`jurisdictions: [{ country_code, ` +
  `is_primary }]\` to enable jurisdiction-aware tools, or have the user ` +
  `complete onboarding at ${getAppBaseUrl()}.`;

/**
 * The onboarding step an empty result carries as its `nextStep` while the
 * organization has no practice jurisdictions. It is a field of the tool's own
 * output contract, so the model sees it whichever result representation the
 * host shows. Callers ask only for an empty result.
 */
const onboardingNextStep = async (
  context: McpRequestContext,
): Promise<{ nextStep?: string }> => {
  const jurisdictions = await loadPracticeJurisdictions(context);
  return jurisdictions.length > 0
    ? {}
    : { nextStep: buildOnboardingNextStep() };
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
  const limit = normalizePage(requestedLimit ?? DEFAULT_LIST_LIMIT);

  let boundaryId: string | undefined;
  if (cursor !== undefined) {
    const decoded = decodeMatterPageCursor(cursor);
    if (decoded === null) {
      return invalidCursorResult({ cursor, tool: "list_matters" });
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
  // result directly (with the onboarding next step, if any). A non-empty page
  // runs through the egress pipeline, which anonymizes each matter's name under
  // its own workspace scope in anonymized mode. The matter id is its workspace
  // id.
  if (matters.length === 0) {
    return toolDataResult(
      projectionPayload(LIST_MATTERS_LIST_PROJECTION, {
        matters,
        nextCursor: page.nextCursor,
        ...(await onboardingNextStep(context)),
      }),
    );
  }

  const payload = projectionPayload(LIST_MATTERS_LIST_PROJECTION, {
    matters,
    nextCursor: page.nextCursor,
  });
  const textFields = runTextFieldSpecs(
    LIST_MATTERS_LIST_TEXT_FIELD_SPECS,
    payload,
  );

  return structuredEgressPlan({ payload, textFields });
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

  if (contacts.isErr()) {
    return internalFailureResult(contacts.error);
  }

  const matter = {
    id: workspace.id,
    name: workspace.name,
    reference: workspace.reference,
    status: workspace.status,
    clientName: workspace.client?.displayName ?? null,
  };
  const contactCards = contacts.value.contacts.flatMap((workspaceContact) => {
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
  const payload = projectionPayload(LIST_MATTERS_DETAIL_PROJECTION, {
    matter,
    overview: overviewWithoutAvatarUrls,
    contacts: contactCards,
    contactsOverflow: contacts.value.overflow,
    members: memberCards,
  });

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

  return structuredEgressPlan({ payload, textFields });
};

const handleSearchAcrossMattersTool: TypedMcpToolHandler<
  v.InferInput<typeof SEARCH_ACROSS_MATTERS_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(searchAcrossMattersArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { cursor, query } = parsed.output;
  const limit = normalizePage(parsed.output.limit ?? DEFAULT_SEARCH_LIMIT);

  // Reject an undecodable provider cursor instead of forwarding it: the
  // provider treats a malformed cursor as no cursor and silently returns the
  // first page, which would duplicate hits or loop a paginating client.
  if (cursor !== undefined && decodeCursor(cursor) === null) {
    return invalidCursorResult({ cursor, tool: "search_across_matters" });
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
  const payload = projectionPayload(SEARCH_ACROSS_MATTERS_PROJECTION, {
    totalCount: result.totalCount,
    nextCursor: result.nextCursor,
    hits,
  });
  const textFields = runTextFieldSpecs(
    SEARCH_ACROSS_MATTERS_TEXT_FIELD_SPECS,
    payload,
  );

  return structuredEgressPlan({ payload, textFields });
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
  return structuredEgressPlan({
    payload: projectionPayload(READ_CONTENT_ACROSS_MATTERS_PROJECTION, payload),
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
  });
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
    // One query pages on the engine's own cursor, which the engine decodes.
    // Several page on this envelope, and a string that is not one was never
    // issued for them: it is an unreadable cursor, not a cursor for a
    // different number of queries.
    return queryCount === 1
      ? { type: "cursors", cursors: [cursor] }
      : { type: "invalid" };
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

/**
 * The values each filter the request set could have taken, from a page's own
 * facets: each facet counts its dimension under the other filters, so these
 * are the values that would have matched. Named on an empty page so the next
 * call picks one rather than guessing another.
 */
const facetValuesForFilters = ({
  facets,
  filters,
}: {
  facets: SearchCaseLawSuccess["facets"];
  filters: {
    /** The court spellings the search narrowed by, from either court filter. */
    court: readonly string[] | undefined;
    decisionType: string | undefined;
    language: string | undefined;
  };
}): { filter: string; values: string[] }[] => {
  if (facets === null) {
    return [];
  }
  return [
    ...(filters.court === undefined
      ? []
      : [
          {
            filter: "court",
            values: facets.court.flatMap((tier) =>
              tier.courts.map((bucket) => bucket.value),
            ),
          },
        ]),
    ...(filters.decisionType === undefined
      ? []
      : [
          {
            filter: "decision_type",
            values: facets.decisionType.map((bucket) => bucket.value),
          },
        ]),
    ...(filters.language === undefined
      ? []
      : [
          {
            filter: "language",
            values: facets.language.map((bucket) => bucket.value),
          },
        ]),
  ];
};

/** One query's page, or the mark of a query whose page had already ended. */
type CaseLawQueryOutcome =
  | { exhausted: true }
  | { exhausted: false; page: SearchCaseLawSuccess };

type CaseLawSearchAnswer =
  | { type: "page"; page: SearchCaseLawSuccess }
  | { type: "failed"; result: InternalToolErrorResult };

/** One query's handler answer read as its page or the tool's refusal. */
const readCaseLawSearchAnswer = (
  answer: Parameters<typeof isSearchCaseLawSuccess>[0],
  cursor: string | undefined,
): CaseLawSearchAnswer => {
  if (isSearchIndexUnavailable(answer)) {
    return { type: "failed", result: searchIndexUnavailableResult(answer) };
  }
  const resultMessage = handlerResultMessage(answer);
  if (resultMessage === INVALID_CURSOR_MESSAGE) {
    return {
      type: "failed",
      result: invalidCursorResult({
        cursor: cursor ?? "",
        tool: SEARCH_CASE_LAW_TOOL,
      }),
    };
  }
  if (resultMessage) {
    return { type: "failed", result: errorResult(resultMessage) };
  }
  if (!isSearchCaseLawSuccess(answer)) {
    return { type: "failed", result: errorResult("Case-law search failed") };
  }
  return { type: "page", page: answer };
};

const caseLawSearchRequestFilters = ({
  category,
  has_legal_sentence: hasLegalSentence,
  language,
  decision_type: decisionType,
  source_id: sourceId,
  date_from: dateFrom,
  date_to: dateTo,
  sort,
  strict,
}: v.InferOutput<typeof searchCaseLawArgsSchema>) => ({
  ...(category === undefined ? {} : { category }),
  ...(hasLegalSentence === undefined ? {} : { hasLegalSentence }),
  ...(language === undefined ? {} : { language }),
  ...(decisionType === undefined ? {} : { decisionType }),
  ...(sourceId === undefined
    ? {}
    : { sourceId: brandPersistedCaseLawSourceId(sourceId) }),
  ...(dateFrom === undefined ? {} : { dateFrom }),
  ...(dateTo === undefined ? {} : { dateTo }),
  ...(sort === undefined ? {} : { sort }),
  ...(strict === undefined ? {} : { strict }),
});

const validateSearchQueryPage = (limit: number, queryCount: number) => {
  if (getTenantActionSizePolicy() !== undefined && limit < queryCount) {
    return structuredErrorResult({
      code: "validation_error",
      message: "The configured page limit cannot include every search query",
      issues: [
        {
          path: "queries",
          message: "Each query needs at least one result slot.",
        },
      ],
      hint: `Send at most ${String(limit)} queries per search_case_law call, keeping the same queries when continuing a cursor.`,
    });
  }
  return undefined;
};

const mismatchedSearchCursorResult = (encoded: number, queryCount: number) =>
  structuredErrorResult({
    code: "validation_error",
    message: "Cursor was issued for a different set of queries",
    issues: [
      {
        path: "cursor",
        message: `This cursor continues ${String(encoded)} queries; the call carries ${String(queryCount)}.`,
      },
    ],
    hint: `Send the same ${String(encoded)} queries this cursor was issued for, in the same order, or omit 'cursor' to start a new search.`,
  });

const mcpCorpusQueryVariant = ({ testDependencies }: McpRequestContext) =>
  testDependencies?.corpusIndexQueryVariant ??
  envBase.CORPUS_INDEX_QUERY_VARIANT;

const mcpCaseLawSearchGuidance = ({ testDependencies }: McpRequestContext) =>
  testDependencies?.caseLawSearchGuidance ??
  envBase.MCP_CASE_LAW_SEARCH_GUIDANCE;

type ManyRequiredTermsOptions = {
  guidance: CaseLawSearchGuidanceMode;
  /** The phrasing's cursor this call: `undefined` is its first page. */
  subCursor: string | null | undefined;
  /**
   * The page the phrasing returned. What follows it is read from everything
   * the search answered (`searchPageEnd`): only `complete` proves the
   * phrasing was exhausted. Its `queryUsed` is a fixed point of the
   * tokenizer.
   */
  page: Pick<
    SearchCaseLawSuccess,
    "hits" | "nextCursor" | "pageReach" | "paginationOutcome" | "queryUsed"
  >;
  /** The result slots the phrasing was given. */
  slots: number;
};

/**
 * `many_required_terms` for a long phrasing exhausted on its first page,
 * read from the page already returned. A continuation is not asked about: it
 * is short at the end of every result set. A short first page that still
 * carries a cursor (a ranked row gone before hydration) has unread results,
 * and one whose scan stopped on a budget may have them too, so neither is
 * exhausted. A quoted phrase requires each of its words.
 */
const manyRequiredTermsWarnings = ({
  guidance,
  subCursor,
  page,
  slots,
}: ManyRequiredTermsOptions): AgentCaseLawSearchWarning[] => {
  const end = searchPageEnd({
    nextCursor: page.nextCursor,
    paginationOutcome: page.paginationOutcome,
    reach: page.pageReach,
  });
  if (
    !CASE_LAW_SEARCH_GUIDANCE_RAISES_MANY_REQUIRED_TERMS[guidance] ||
    subCursor !== undefined ||
    end !== SEARCH_PAGE_END.COMPLETE ||
    page.hits.length >= slots
  ) {
    return [];
  }
  const tokens = tokenizeCorpusFreeText(page.queryUsed);
  const wordCount = tokens.reduce(
    (count, { value }) => count + value.split(" ").length,
    0,
  );
  return wordCount < MANY_REQUIRED_TERMS_THRESHOLD
    ? []
    : [
        manyRequiredTermsWarning({
          terms: tokens.map((token) =>
            token.type === "phrase" ? `"${token.value}"` : token.value,
          ),
          wordCount,
          slots,
        }),
      ];
};

const caseLawSearchResult = ({
  hit,
  matchedQueries,
}: ReturnType<typeof mergeCaseLawSearchHits>[number]) => {
  const resource = resourceRef({
    type: RESOURCE_TYPE.CASE_LAW_DECISION,
    id: brandPersistedCaseLawDecisionId(hit.decisionId),
  });
  return {
    matchedQueries,
    ...legalCitationLinkFields({
      appUrl: buildCaseLawDecisionAppUrl({
        caseNumber: hit.caseNumber,
        country: hit.country,
        court: hit.court,
        decisionId: hit.decisionId,
        language: hit.language,
        languageAlternates: hit.languageAlternates,
        slug: hit.slug,
      }),
      sourceUrl: hit.sourceUrl,
    }),
    caseNumber: hit.caseNumber,
    citationAuthority: hit.citationAuthority,
    citationCount: hit.citationCount,
    country: hit.country,
    ...projectCaseLawCourt(hit),
    decisionDate: hit.decisionDate,
    decisionId: hit.decisionId,
    resourceName: serializeAuthorizedCorpusMcpResourceName(resource),
    decisionType: hit.decisionType,
    ecli: hit.ecli,
    language: hit.language,
    matchingPassages: hit.matchingPassages,
    ...(hit.textWithheldReason === null
      ? {
          snippet: toPlainTextSnippet(hit.headline),
          keywords: hit.keywords,
          headnote:
            hit.headnote.type === TEXT_FIELD_TYPE.PRESENT ? hit.headnote : null,
        }
      : {
          excerpt: {
            type: "withheld" as const,
            reason: hit.textWithheldReason,
          },
          // Headnote and classifications are the source's own text: the
          // licence that withholds the excerpt withholds them too.
          keywords: null,
          headnote: null,
        }),
    sourceUrl: hit.sourceUrl,
  };
};

const handleSearchCaseLawTool: TypedMcpToolHandler<
  v.InferInput<typeof SEARCH_CASE_LAW_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(searchCaseLawArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const observer = actionRequestObserver(
    context.organizationId,
    ACTION_COST_CALL_KIND.corpusRequest,
  );
  const {
    country,
    court,
    courts,
    cursor,
    decision_type: decisionType,
    language,
    queries,
  } = parsed.output;
  const limit = normalizePage(parsed.output.limit ?? DEFAULT_SEARCH_LIMIT);
  const pageError = validateSearchQueryPage(limit, queries.length);
  if (pageError !== undefined) {
    return pageError;
  }
  const unavailable = publicCountryUnavailable(country);
  if (unavailable !== null) {
    return toolDataResult(unavailable);
  }
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
    return invalidCursorResult({
      cursor: cursor ?? "",
      tool: SEARCH_CASE_LAW_TOOL,
    });
  }
  if (resolved.type === "count_mismatch") {
    return mismatchedSearchCursorResult(resolved.encoded, queries.length);
  }

  // A court filter is read onto a stored court before any query runs, so
  // every phrasing and every continuation of this call narrows the same way.
  const {
    court: courtFilter,
    courts: courtListFilter,
    warnings: filterWarnings,
  } = await resolveCourtFilter({
    context,
    country: publicCountry,
    court,
    courts,
  });

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
  // Exhausted phrasings echo their required words from the request without
  // running the search again.
  const grammar = decisionDocketGrammarForCountry(publicCountry);
  const reporters = decisionReporterGrammarForJurisdiction(publicCountry);
  const requests = queries.map((query, index) => {
    // Three states, not two: a string continues this phrasing, `undefined` is
    // its first page, and `null` means it ended on an earlier one. Only a
    // string is a cursor the search can be given.
    const subCursor = resolved.cursors[index];
    const body = {
      query,
      sentenceAlignedExcerpt: true,
      headnotePresentation: "expanded" as const,
      limit: perQueryLimit,
      ...(typeof subCursor === "string" ? { cursor: subCursor } : {}),
      ...(courtFilter === undefined ? {} : { court: courtFilter }),
      ...(courtListFilter === undefined ? {} : { courts: courtListFilter }),
      ...caseLawSearchRequestFilters(parsed.output),
      country: publicCountry,
    };
    return {
      body,
      query,
      subCursor,
      interpretation: interpretDecisionQuery({
        body,
        configuredVariant: mcpCorpusQueryVariant(context),
        intent: parseDecisionQuery(query, { grammar, reporters }),
      }),
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
        result: await search({
          body,
          caseLawDb: caseLawPublicReadDb,
          observer,
        }),
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
    const answer = readCaseLawSearchAnswer(outcome.result, cursor);
    if (answer.type === "failed") {
      return answer.result;
    }
    pages.push({ exhausted: false, page: answer.page });
  }

  const merged = mergeCaseLawSearchHits(
    pages.map((outcome) => (outcome.exhausted ? [] : outcome.page.hits)),
  );

  // Facets describe the first phrasing, without double-counting overlapping
  // results. Only a single phrasing can provide a total for the result set.
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

  // One entry per query, in input order. Required words and warnings belong
  // to each phrasing independently of the first phrasing's facets.
  const guidance = mcpCaseLawSearchGuidance(context);
  const searches = requests.map(
    ({ interpretation, query, subCursor }, index) => {
      const outcome = pages.at(index);
      if (outcome === undefined || outcome.exhausted) {
        // Exhausted phrasings echo the prior interpretation without new warnings.
        return {
          query,
          queryUsed: interpretation.queryUsed,
          paginationOutcome: SEARCH_PAGINATION_COMPLETE,
          warnings: filterWarnings,
        };
      }
      const values = facetValuesForFilters({
        facets: outcome.page.facets,
        filters: {
          court:
            courtListFilter ??
            (courtFilter === undefined ? undefined : [courtFilter]),
          decisionType,
          language,
        },
      });
      return {
        query,
        queryUsed: outcome.page.queryUsed,
        paginationOutcome: outcome.page.paginationOutcome,
        warnings: [
          ...filterWarnings,
          ...outcome.page.warnings.map((warning) =>
            withFacetValues(warning, values),
          ),
          ...manyRequiredTermsWarnings({
            guidance,
            subCursor,
            page: outcome.page,
            slots: perQueryLimit,
          }),
        ],
      };
    },
  );

  const payload = boundCaseLawSearchHeadnotes({
    headnotes: "included",
    facets: first.exhausted ? null : first.page.facets,
    searches,
    nextCursor: single === undefined ? mergedCursor : single.nextCursor,
    paginationOutcome: pages.some(
      (outcome) =>
        !outcome.exhausted &&
        outcome.page.paginationOutcome.type === "truncated",
    )
      ? SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET
      : SEARCH_PAGINATION_COMPLETE,
    results: merged.map(caseLawSearchResult),
    total: single?.total ?? SEARCH_TOTAL_NOT_COUNTED,
    ...(merged.length === 0 ? await onboardingNextStep(context) : {}),
  });
  return toolDataResult(projectionPayload(SEARCH_CASE_LAW_PROJECTION, payload));
};

type GatedDecisionRead = Awaited<
  ReturnType<typeof readGatedDecisionWithDocument>
>;

type CitationDigestRead = Awaited<
  ReturnType<typeof readGatedDecisionCitationDigest>
>;

type DecisionItemResult = v.InferInput<
  typeof READ_CASE_LAW_DECISION_PROJECTION
>["items"][number];

type DecisionReadInclude = (typeof DECISION_READ_INCLUDE)[number];

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
}: Pick<ReadCaseLawDecisionSuccess, "caseNumberType" | "identifiers">) =>
  caseNumberType === DECISION_IDENTIFIER_TYPES.CASE_NUMBER
    ? {}
    : { caseNumberType, identifiers: [...identifiers] };

/** Where the text window of each entry starts. */
type DecisionTextPosition =
  | { type: "page"; page: number }
  /** A `query` call: matching paragraphs replace the window. */
  | { type: "query"; query: string };

type DecisionItemOptions = {
  decisionId: string;
  /** See `decisionDocumentState`: the deployment's half of the answer. */
  readsSharedCorpus: boolean;
  /** Whether this call could fetch a pending document at all. */
  documentHydration: DecisionDocumentHydration["type"];
  /** This entry's page size, which is also its text budget. */
  windowChars: number;
  outline: "include" | "omit";
  read: GatedDecisionRead;
  digest: CitationDigestRead | undefined;
  position: DecisionTextPosition;
  includedFields: ReadonlySet<DecisionReadInclude>;
  /** The text version the caller last saw, when it passed one. */
  seenTextVersion: string | undefined;
};

/** What a caller does about a document this call left pending. */
const pendingDocumentMessage = (
  documentHydration: DecisionDocumentHydration["type"],
): string => {
  switch (documentHydration) {
    case "on-demand": {
      return `The publisher document for this decision is not stored yet. Read this decision id on its own to fetch it; this call's fetch budget is ${String(LIMITS.caseLawDecisionBatchHydrationsMax)} documents.`;
    }
    case "stored-only": {
      return "The publisher document for this decision is not stored yet. The ingestion queue fetches it; read this decision again later.";
    }
    default: {
      documentHydration satisfies never;
      return panic("Unhandled document hydration");
    }
  }
};

/**
 * The optional fields an entry carries: what `include` names, or by default
 * everything on page 1 and nothing on a later page or a `query` call, whose
 * caller came for a passage and already holds the rest.
 */
const decisionIncludedFields = ({
  include,
  position,
}: {
  include: readonly DecisionReadInclude[] | undefined;
  position: DecisionTextPosition;
}): ReadonlySet<DecisionReadInclude> => {
  if (include !== undefined) {
    return new Set(include);
  }
  return new Set(
    position.type === "page" &&
      position.page === LIMITS.caseLawDecisionFirstPage
      ? DECISION_READ_INCLUDE
      : [],
  );
};

const caseLawDecisionAppUrlOf = (decision: {
  caseNumber: string;
  country: string;
  court: string;
  id: string;
  language: string;
  languageAlternates: Parameters<
    typeof buildCaseLawDecisionAppUrl
  >[0]["languageAlternates"];
  slug: string | null;
}) =>
  buildCaseLawDecisionAppUrl({
    caseNumber: decision.caseNumber,
    country: decision.country,
    court: decision.court,
    decisionId: decision.id,
    language: decision.language,
    languageAlternates: decision.languageAlternates,
    slug: decision.slug,
  });

type FoundDecision = Extract<
  DecisionItemResult,
  { status: typeof DECISION_READ_STATUS.found }
>["decision"];

type DecisionTextPartOptions = {
  appUrl: string | null;
  language: string;
  located: readonly LocatedDecisionBlock[] | null;
  /** Notes for the entry's message; a page past the end adds one. */
  messages: string[];
  position: DecisionTextPosition;
  seenTextVersion: string | undefined;
  starts: readonly number[];
  text: string;
  windowChars: number;
};

/** The text an entry answers with: its page, or the paragraphs a query matched. */
const decisionTextPart = ({
  appUrl,
  language,
  located,
  messages,
  position,
  seenTextVersion,
  starts,
  text,
  windowChars,
}: DecisionTextPartOptions): Partial<FoundDecision> => {
  const version = decisionTextVersion(text);
  const versioning = {
    textVersion: version,
    ...(seenTextVersion !== undefined && seenTextVersion !== version
      ? { versionChanged: true as const }
      : {}),
  };
  if (position.type === "query") {
    const found = paragraphsMatching({
      budget: windowChars,
      language,
      paragraphs: decisionParagraphs({ located, text }),
      query: position.query,
    });
    return {
      charCount: text.length,
      ...versioning,
      matches: {
        hitCount: found.hitCount,
        paragraphs: found.paragraphs.map((paragraph) => ({
          position: paragraph.position,
          label: paragraph.label,
          headingPath: paragraph.headingPath,
          text: paragraph.text,
          ...(paragraph.hit ? { hit: true as const } : {}),
          ...decisionBlockDeepLink({ appUrl, ...paragraph }),
        })),
        ...(found.truncated ? { truncated: true as const } : {}),
      },
    };
  }
  const { page } = position;
  const span = textPageSpan({ page, starts, text });
  if (span === null) {
    messages.push(
      `Page ${String(page)} is past the end: this decision's text has ${String(starts.length)} ${starts.length === 1 ? "page" : "pages"} of ${String(windowChars)} characters.`,
    );
  }
  return {
    ...(span === null ? {} : { text: text.slice(span.start, span.end) }),
    page,
    pageCount: starts.length,
    charCount: text.length,
    ...versioning,
  };
};

/** Publisher-authored summaries the publisher published, by field. */
const publishedTextFields = (read: ReadCaseLawDecisionSuccess) =>
  Object.fromEntries(
    DECISION_TEXT_FIELD_KEYS.flatMap((key) => {
      const field = read.textFields[key];
      return field.type === TEXT_FIELD_TYPE.PRESENT
        ? [[key, field.text] as const]
        : [];
    }),
  );

/** The optional fields `include` asked for, each only where it says something. */
const decisionStaticFields = ({
  appUrl,
  digest,
  includedFields,
  read,
}: {
  appUrl: string | null;
  digest: CitationDigestRead | undefined;
  includedFields: ReadonlySet<DecisionReadInclude>;
  read: ReadCaseLawDecisionSuccess;
}): Partial<FoundDecision> => {
  const decisionDate = toIsoDateString(read.decisionDate);
  const metadata = compactDecisionMetadata({
    metadata: read.metadata,
    restated: [
      read.caseNumber,
      read.court,
      read.courtAbbreviation,
      read.country,
      read.ecli,
      read.decisionType,
      decisionDate,
      read.language,
      read.source.name,
      read.sourceUrl,
      read.documentUrl,
      read.sourceAttributionUrl,
    ],
  });
  const textFields = publishedTextFields(read);
  // The shared link contract over one publisher page: the decision's own,
  // else the source's public home, which is what the attribution resolves
  // to. The legacy `appUrl` beside it would only repeat `url`.
  const links = legalCitationLinkFields({
    appUrl,
    sourceUrl: read.sourceAttributionUrl ?? read.documentUrl,
  });
  // The publisher's name says something only where it is not the court's.
  const sourceName =
    read.source.name.trim().toLowerCase() === read.court.trim().toLowerCase()
      ? null
      : read.source.name;
  return {
    ...(includedFields.has("details")
      ? {
          url: links.url,
          ...(links.source_url === undefined
            ? {}
            : { source_url: links.source_url }),
          court: read.court,
          ...(read.courtAbbreviation === null
            ? {}
            : { courtAbbreviation: read.courtAbbreviation }),
          country: read.country,
          language: read.language,
          ...(decisionDate === null ? {} : { decisionDate }),
          ...(read.decisionType === null
            ? {}
            : { decisionType: read.decisionType }),
          ...(read.ecli === null ? {} : { ecli: read.ecli }),
        }
      : {}),
    ...(read.source.allowsDerivedAi &&
    includedFields.has("metadata") &&
    Object.keys(metadata).length > 0
      ? { metadata }
      : {}),
    ...(read.source.allowsDerivedAi &&
    includedFields.has("textFields") &&
    Object.keys(textFields).length > 0
      ? { textFields }
      : {}),
    ...(includedFields.has("source") && sourceName !== null
      ? { source: sourceName }
      : {}),
    ...(includedFields.has("citations") &&
    digest !== undefined &&
    digest !== null
      ? {
          citations: citationSummaryOutput(digest, (cited) =>
            caseLawDecisionAppUrlOf(cited),
          ),
        }
      : {}),
  };
};

/** Why an entry has no text, when it has none; see the projection. */
const decisionTextAbsence = (
  read: ReadCaseLawDecisionSuccess,
  readsSharedCorpus: boolean,
) => {
  if (!read.source.allowsDerivedAi) {
    return {
      textWithheldReason:
        "The source licence does not permit AI use of the full text.",
    };
  }
  // The licence and the missing document are different answers, and a
  // caller that conflated them would retry one that will never change.
  return decisionDocumentState(read, readsSharedCorpus) ===
    DECISION_DOCUMENT_STATE.unavailable
    ? {
        textUnavailableReason:
          "The publisher's document for this decision is not available from this corpus, so the metadata and citations here are all it carries.",
      }
    : {};
};

const decisionItemResult = ({
  decisionId,
  windowChars,
  outline,
  read,
  digest,
  readsSharedCorpus,
  documentHydration,
  position,
  includedFields,
  seenTextVersion,
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
      message: pendingDocumentMessage(documentHydration),
      status: DECISION_READ_STATUS.pending,
    };
  }

  // allowsRedistribution gates whether the decision is publicly
  // readable; allowsDerivedAi additionally gates feeding full text to a
  // model, which is exactly this tool's context.
  const aiTextAllowed = read.source.allowsDerivedAi;
  const parsedBlocks = aiTextAllowed
    ? (parseCaseLawDecisionAst(read.documentAst)?.blocks ?? null)
    : null;
  const astText =
    parsedBlocks === null
      ? null
      : toPlainCorpusText({ blocks: parsedBlocks, fulltext: null });
  const blocks = astText !== null && astText.length > 0 ? parsedBlocks : null;
  // The reader renders AST blocks: use that same text for passage anchors
  // and every verbatim outline heading. Empty AST text falls back to fulltext.
  const readableText = blocks === null ? read.fulltext : astText;
  const plainText = aiTextAllowed ? readableText : null;
  const text = plainText === null || plainText.length === 0 ? null : plainText;
  const appUrl = caseLawDecisionAppUrlOf(read);

  const messages: string[] =
    read.resolution.type === DECISION_READ_RESOLUTION.ABSORBED_SUPPLEMENT
      ? [
          `This id named written reasons that are now part of decision ${read.id}, returned here. Cite ${read.id} from now on.`,
        ]
      : [];

  // Pages exist only for a text the caller may read. The starts are computed
  // once and serve the page and the outline alike.
  const starts = text === null ? null : textPageStarts(text, windowChars);
  const textPart =
    text === null || starts === null
      ? {}
      : decisionTextPart({
          appUrl,
          language: read.language,
          located: blocks === null ? null : locateDecisionBlocks(blocks, text),
          messages,
          position,
          seenTextVersion,
          starts,
          text,
          windowChars,
        });

  const navigation =
    outline === "include" &&
    text !== null &&
    starts !== null &&
    includedFields.has("outline")
      ? decisionOutline({ blocks, text })
      : null;

  return {
    decisionId,
    ...(messages.length === 0 ? {} : { message: messages.join(" ") }),
    status: DECISION_READ_STATUS.found,
    decision: {
      decisionId: read.id,
      caseNumber: read.caseNumber,
      ...nonDocketReference(read),
      ...decisionStaticFields({ appUrl, digest, includedFields, read }),
      ...textPart,
      ...(text === null
        ? {}
        : {
            textSource:
              blocks === null
                ? DECISION_TEXT_SOURCE.FULLTEXT
                : DECISION_TEXT_SOURCE.AST,
          }),
      ...(navigation !== null && starts !== null
        ? {
            outline: navigation.entries.map((entry) => ({
              title: entry.title,
              page: pageOfOffset(starts, entry.start),
              ...decisionBlockDeepLink({ appUrl, ...entry }),
            })),
            ...(navigation.numberedEntriesTruncated
              ? { outlineNumberedEntriesTruncated: true as const }
              : {}),
          }
        : {}),
      ...decisionTextAbsence(read, readsSharedCorpus),
    },
  };
};

/**
 * The fixed text budget for a call. An explicit max_chars contributes that
 * much per entry until the batch ceiling; without one the entries share the
 * default content budget. The allocator gives each entry an even first pass,
 * then gives unused shares to entries they complete, without growing this cap.
 */
const decisionTextCap = ({
  count,
  full,
  maxChars,
}: {
  count: number;
  full: boolean;
  maxChars: number | undefined;
}): number => {
  if (full) {
    return READ_DECISION_FULL_MAX_TEXT_CHARS;
  }
  return Math.min(
    maxChars === undefined ? MCP_CONTENT_MAX_CHARS : maxChars * count,
    READ_DECISION_BATCH_MAX_TEXT_CHARS,
  );
};

const readableDecisionTextLength = (
  read: GatedDecisionRead,
  readsSharedCorpus: boolean,
): number => {
  if (
    read === null ||
    !isReadCaseLawDecisionSuccess(read) ||
    isDecisionDocumentPending(read, readsSharedCorpus) ||
    !read.source.allowsDerivedAi
  ) {
    return 0;
  }
  const blocks = parseCaseLawDecisionAst(read.documentAst)?.blocks ?? null;
  const astText =
    blocks === null ? null : toPlainCorpusText({ blocks, fulltext: null });
  const text = astText !== null && astText.length > 0 ? astText : read.fulltext;
  return text?.length ?? 0;
};

/** A typed refusal of one input combination, naming the field to change. */
const decisionReadArgumentError = (
  path: string,
  message: string,
  hint: string,
) =>
  structuredErrorResult({
    code: "validation_error",
    message,
    issues: [{ path, message }],
    hint,
  });

type DecisionReadArgs = v.InferOutput<typeof readCaseLawDecisionArgsSchema>;

/** The input combinations the schema admits and the read refuses, if any. */
const decisionReadArgumentRefusal = ({
  decision_ids: decisionIds,
  full,
  max_chars: maxChars,
  page,
  query,
  text_version: seenTextVersion,
}: DecisionReadArgs) => {
  if (full === true && maxChars !== undefined) {
    return decisionReadArgumentError(
      "max_chars",
      "full reads the whole text, so it takes no max_chars.",
      "Drop max_chars to read the whole decision, or drop full to read a window.",
    );
  }
  // A version names one decision's text, and a batch holds several.
  if (seenTextVersion !== undefined && decisionIds.length > 1) {
    return decisionReadArgumentError(
      "text_version",
      `A text version names one decision's text; the call carries ${String(decisionIds.length)} decision ids.`,
      "Pass text_version with the one decision id it came from.",
    );
  }
  if (query === undefined) {
    return null;
  }
  if (page !== undefined || full === true) {
    return decisionReadArgumentError(
      "query",
      "query returns matching paragraphs instead of a text window, so it takes no page or full.",
      "Drop query to read pages, or drop page and full to find paragraphs.",
    );
  }
  if (corpusTokens(query).length === 0) {
    return decisionReadArgumentError(
      "query",
      "query holds no word to match.",
      "Pass the words a matching paragraph must contain.",
    );
  }
  return null;
};

/** Where each entry's text starts: a query replaces the page. */
const decisionTextPositionOf = ({
  page,
  query,
}: DecisionReadArgs): DecisionTextPosition =>
  query === undefined
    ? { type: "page", page: page ?? LIMITS.caseLawDecisionFirstPage }
    : { type: "query", query };

const handleReadCaseLawDecisionTool: TypedMcpToolHandler<
  v.InferInput<typeof READ_CASE_LAW_DECISION_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(readCaseLawDecisionArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const {
    decision_ids: decisionIds,
    full = false,
    include,
    max_chars: maxChars,
    text_version: seenTextVersion,
  } = parsed.output;

  const refusal = decisionReadArgumentRefusal(parsed.output);
  if (refusal !== null) {
    return refusal;
  }
  const position = decisionTextPositionOf(parsed.output);
  const includedFields = decisionIncludedFields({ include, position });

  // The same gate the public route applies, in the same shape: a
  // restricted decision does not exist for any caller, and the read that
  // answers shares the transaction that approved it. Documents are NOT
  // hydrated here: a batch decides below how many publisher fetches it is
  // worth. The raw citation pages are skipped (a null cursor reads both as
  // finished): the answer summarizes citations from their own read.
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
      citationsCursor: null,
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
          await readDecision(decisionId, STORED_ONLY_DOCUMENT_HYDRATION),
        ] as const,
    }),
  );

  // An error the read itself reports is about the call, not about one entry,
  // so it answers for the call.
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
  // reported as such. A caller without a third-party outbound permit (a chat
  // script) fetches none.
  const onDemand = documentHydrationFor(context.thirdPartyOutboundPermit);
  const fetchedIds =
    onDemand.type === "stored-only"
      ? []
      : uniqueIds
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
      operation: async (decisionId) => await readDecision(decisionId, onDemand),
    })
  ).entries()) {
    const decisionId =
      fetchedIds[index] ?? panic("Lost a hydrated case-law decision id");
    reads.set(decisionId, hydrated);
  }

  // The citation summary, for the entries that answer `found` and asked for
  // it. Its own gated read: the same gate, so a decision the read could not
  // see has no summary either.
  const readDigest =
    context.testDependencies?.readGatedDecisionCitationDigest ??
    defaultReadGatedDecisionCitationDigest;
  const digestIds = includedFields.has("citations")
    ? uniqueIds.filter((decisionId) => {
        const value = readOf(decisionId);
        return (
          value !== null &&
          isReadCaseLawDecisionSuccess(value) &&
          !isDecisionDocumentPending(value, readsSharedCorpus)
        );
      })
    : [];
  const digests = new Map(
    await mapWithConcurrency({
      items: digestIds,
      limit: LIMITS.caseLawCitationPassageConcurrency,
      operation: async (decisionId) =>
        [
          decisionId,
          await readDigest({
            caseLawDb: caseLawPublicReadDb,
            decisionId: brandPersistedCaseLawDecisionId(decisionId),
          }),
        ] as const,
    }),
  );

  const textCap = decisionTextCap({
    count: decisionIds.length,
    full,
    maxChars,
  });
  const windowChars = decisionTextAllowances(
    decisionIds.map((decisionId) =>
      readableDecisionTextLength(readOf(decisionId), readsSharedCorpus),
    ),
    textCap,
  );

  return toolDataResult(
    projectionPayload(READ_CASE_LAW_DECISION_PROJECTION, {
      items: decisionIds.map((decisionId, index) =>
        decisionItemResult({
          decisionId,
          windowChars: Math.max(1, windowChars[index] ?? 0),
          outline: decisionIds.length === 1 ? "include" : "omit",
          read: readOf(decisionId),
          digest: digests.get(decisionId),
          readsSharedCorpus,
          documentHydration: onDemand.type,
          position,
          includedFields,
          seenTextVersion,
        }),
      ),
    }),
  );
};

// --- lookup_case_law -------------------------------------------------------

type DecisionLookupItem = Extract<
  v.InferInput<typeof LOOKUP_CASE_LAW_PROJECTION>,
  { items: unknown[] }
>["items"][number];

const SEARCH_INSTEAD_HINT =
  "Search the decision's text with search_case_law instead, or pass the docket exactly as the court wrote it.";

const decisionIdentityOf = (row: DecisionIdentityRow) => ({
  ...legalCitationLinkFields({
    appUrl: buildCaseLawDecisionAppUrl({
      caseNumber: row.caseNumber,
      country: row.country,
      court: row.court,
      decisionId: row.id,
      language: row.language,
      languageAlternates: row.languageAlternates,
      slug: row.slug,
    }),
    sourceUrl: null,
  }),
  caseNumber: row.caseNumber,
  // As in search: the kind is named only where the reference is not a docket.
  ...(row.caseNumberType === DECISION_IDENTIFIER_TYPES.CASE_NUMBER
    ? {}
    : { caseNumberType: row.caseNumberType }),
  ...projectCaseLawCourt(row),
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
  | {
      type: "resolved";
      resolution: DecisionIdentityResolution<DecisionIdentityRow>;
    };

/** Why a lookup lists candidates instead of naming one, in the agent's terms. */
const ambiguityReasonText = (
  reason: Extract<
    DecisionIdentityResolution<DecisionIdentityRow>,
    { status: "ambiguous" }
  >["reason"],
  { count, single }: { count: string; single: boolean },
): string => {
  switch (reason) {
    case "several":
      return `${count} carry this identifier: decisions of one file, or the same number at different courts or in different languages.`;
    case "selector_unmatched":
      return `No decision here is known to carry the sheet or part this reference names; ${count} of its file ${single ? "is" : "are"} listed instead.`;
    default: {
      reason satisfies never;
      return panic(`Unhandled ambiguity: ${String(reason)}`);
    }
  }
};

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
        "This is not a docket number or ECLI in a grammar the corpus's courts use.",
      status: DECISION_LOOKUP_STATUS.notFound,
    };
  }

  const { resolution } = outcome;
  switch (resolution.status) {
    case "none":
      return {
        identifier,
        hint: SEARCH_INSTEAD_HINT,
        message: "No decision in this corpus carries this identifier.",
        status: DECISION_LOOKUP_STATUS.notFound,
      };
    case "unique":
      return {
        identifier,
        ...decisionIdentityOf(resolution.decision),
        status: DECISION_LOOKUP_STATUS.found,
      };
    case "incomplete_identifier":
      return {
        identifier,
        missing: [...resolution.missing],
        message: `Add the ${resolution.missing.join(", ")} to identify one decision in this case file.`,
        status: DECISION_LOOKUP_STATUS.incompleteIdentifier,
      };
    case "ambiguous": {
      // The cap lands here, on what survived the exact-identity filter: the
      // identity read is bounded wider than the listed maximum precisely
      // because that filter drops rows whose key merely collided.
      const { candidates } = resolution;
      const listed = candidates.slice(0, LIMITS.caseLawLookupCandidatesMax);
      const count =
        candidates.length > LIMITS.caseLawLookupCandidatesMax
          ? `More than ${String(LIMITS.caseLawLookupCandidatesMax)} decisions`
          : `${String(candidates.length)} ${candidates.length === 1 ? "decision" : "decisions"}`;
      const why = ambiguityReasonText(resolution.reason, {
        count,
        single: candidates.length === 1,
      });
      return {
        identifier,
        candidates: listed.map(decisionIdentityOf),
        message: `${why} Pick one by its court, date and ECLI and pass its decisionId to read_case_law_decision.`,
        status: DECISION_LOOKUP_STATUS.ambiguous,
      };
    }
    default: {
      resolution satisfies never;
      return panic(`Unhandled identity resolution: ${String(resolution)}`);
    }
  }
};

const handleLookupCaseLawTool: TypedMcpToolHandler<
  v.InferInput<typeof LOOKUP_CASE_LAW_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(lookupCaseLawArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { country, identifiers } = parsed.output;
  const unavailable = publicCountryUnavailable(country);
  if (unavailable !== null) {
    return toolDataResult(unavailable);
  }
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
        // The docket reads the whole case file; a sheet or part the
        // reference printed is kept, and narrows it to one decision only
        // where a decision is known to carry it.
        const intent = parseDecisionQuery(identifier, {
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
              locator: decisionIdentityLocatorOf(intent),
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
        // of its own identifiers, and only one when nothing else does.
        return [
          identifier,
          {
            type: "resolved",
            resolution: resolveDecisionIdentity(intent, read.value, {
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

  return toolDataResult(
    projectionPayload(LOOKUP_CASE_LAW_PROJECTION, {
      items: identifiers.map((identifier) =>
        lookupItemResult({
          identifier,
          outcome: outcomeOf(identifier),
        }),
      ),
    }),
  );
};

const handleReadCaseLawCitationsTool: TypedMcpToolHandler<
  v.InferInput<typeof READ_CASE_LAW_CITATIONS_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(readCaseLawCitationsArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { cursor, decision_id: decisionId, direction } = parsed.output;
  const limit = normalizePage(
    parsed.output.limit ?? LIMITS.caseLawAgentCitationPageSizeDefault,
  );

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
    return invalidCursorResult({
      cursor: cursor ?? "",
      tool: "read_case_law_citations",
    });
  }

  return toolDataResult(
    projectionPayload(READ_CASE_LAW_CITATIONS_PROJECTION, {
      decisionId,
      direction,
      nextCursor: read.page.nextCursor,
      citations: read.page.items.map((item) => ({
        citationId: item.id,
        citationText: item.citationText,
        textWithheldReason: item.textWithheldReason,
        polarity: item.treatment,
        decision:
          item.decision === null
            ? null
            : {
                ...legalCitationLinkFields({
                  appUrl: buildCaseLawDecisionAppUrl({
                    caseNumber: item.decision.caseNumber,
                    country: item.decision.country,
                    court: item.decision.court,
                    decisionId: item.decision.id,
                    language: item.decision.language,
                    languageAlternates: item.decision.languageAlternates,
                    slug: item.decision.slug,
                  }),
                  sourceUrl: null,
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
    }),
  );
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
      columns: READ_CONTACT_COLUMNS,
    }),
  );

  if (!contact) {
    return notFoundResult("Contact not found");
  }

  // Contacts are organization-scoped (no owning workspace), so the org id is
  // the anonymization scope. The placeholder card is intentional and consistent
  // with how chat anonymizes contact fields.
  const payload = projectionPayload(READ_CONTACT_PROJECTION, {
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
    dateOfBirth: dateOfBirthFromColumns(contact),
    nationalityCodes: contact.nationalityCodes,
  });

  const textFields = runTextFieldSpecs(
    buildContactTextFieldSpecs(context.organizationId),
    payload,
  );

  return structuredEgressPlan({
    payload,
    textFields,
    redactInAnonymized: () => {
      payload.dateOfBirth = null;
      payload.nationalityCodes = [];
    },
  });
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

  return toolDataResult(
    projectionPayload(SET_PRACTICE_JURISDICTIONS_PROJECTION, {
      practiceJurisdictions,
    }),
  );
};

const handleCaseLawCoverageTool: TypedMcpToolHandler<
  v.InferInput<typeof CASE_LAW_COVERAGE_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(caseLawCoverageArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { country } = parsed.output;
  const readCoverage =
    context.testDependencies?.readCaseLawCoverageHandler ??
    defaultReadCaseLawCoverageHandler;
  const coverage = await readCoverage(caseLawPublicReadDb);
  if ("message" in coverage) {
    return structuredErrorResult({
      code: "upstream_unavailable",
      message: coverage.message,
      hint: "Retry case_law_coverage later.",
      retryable: true,
    });
  }
  const countries =
    country === undefined
      ? coverage.countries
      : coverage.countries.filter((entry) => entry.country === country);
  if (country !== undefined && countries.length === 0) {
    return notFoundResult(
      "Case-law country not found",
      `Pass one of the coverage country codes: ${coverage.countries.map((entry) => entry.country).join(", ")}, or omit country for all jurisdictions.`,
    );
  }
  return toolDataResult({
    asOf: coverage.generatedAt,
    countries: countries.map((entry) => {
      switch (entry.availability) {
        case "in-preparation":
          return {
            country: entry.country,
            availability: entry.availability,
            decisions: entry.stored.decisions,
            decisionYearFrom: null,
            decisionYearTo: null,
            courts: null,
          };
        case "searchable":
          return {
            country: entry.country,
            availability: entry.availability,
            decisions: entry.searchable,
            decisionYearFrom: entry.decisionYearFrom,
            decisionYearTo: entry.decisionYearTo,
            courts:
              entry.courts === null
                ? null
                : entry.courts.map((row) => {
                    switch (row.type) {
                      case "court":
                        return {
                          type: row.type,
                          court: row.court,
                          decisions: row.decisions,
                        };
                      case "tier":
                        return {
                          type: row.type,
                          tier: row.tier,
                          courts: row.courts,
                          decisions: row.decisions,
                        };
                      case "unlisted":
                        return { type: row.type, decisions: row.decisions };
                      default: {
                        row satisfies never;
                        return panic("Unknown case-law coverage court row");
                      }
                    }
                  }),
          };
        default: {
          entry satisfies never;
          return panic("Unknown case-law coverage availability");
        }
      }
    }),
  } satisfies v.InferInput<typeof CASE_LAW_COVERAGE_PROJECTION>);
};

export const STELLA_TOOL_HANDLERS = {
  case_law_coverage: handleCaseLawCoverageTool,
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
    case_law_coverage: defineChatProjectionMcpToolOutput(
      CASE_LAW_COVERAGE_PROJECTION,
    ),
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
