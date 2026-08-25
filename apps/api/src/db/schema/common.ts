import { panic } from "better-result";
import { defineRelations, isNotNull, isNull, sql } from "drizzle-orm";
import * as p from "drizzle-orm/pg-core";
import { customType } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import {
  BILLING_STATUS,
  EXPENSE_CATEGORIES,
  TIME_ENTRY_SOURCE,
  TIME_ENTRY_SOURCES,
  TIME_ENTRY_STATUSES,
  type ExpenseCategory,
  type TimeEntrySource,
  type TimeEntryStatus,
} from "@stll/api-contract";
import type { ConditionNode } from "@stll/conditions";
import type { CountryCode } from "@stll/country-codes";
import type { PersistedDecisionAnalysis } from "@stll/legal-ast/analysis";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { member, organization, user } from "@/api/db/auth-schema";
import { jsonb, timestamptz } from "@/api/db/columns";
import {
  agentSkillPolicies,
  agentSkillResourcePolicies,
  aiMemoryPolicies,
  chatMessageSearchDocumentPolicies,
  chatMessagePolicies,
  chatTurnPolicies,
  chatThreadCompactionPolicies,
  chatThreadPreviewPassagePolicies,
  chatThreadPolicies,
  chatThreadSearchDocumentPolicies,
  caseLawIngestionOnlyPolicies,
  fileChatThreadPolicies,
  globalCaseLawPolicies,
  publicCaseLawReaderPolicies,
  publicLawReaderPolicies,
  mcpConnectorPolicies,
  mcpOAuthStatePolicies,
  mcpOAuthClientPolicies,
  mcpUserConnectionPolicies,
  organizationCheck,
  authoredNotePolicies,
  orgPolicies,
  orgReadOnlyPolicies,
  savedSearchPolicies,
  sharepointConnectionPolicies,
  sharepointOAuthStatePolicies,
  stella,
  templateChatThreadPolicies,
  userPolicies,
  workspaceIdCheck,
  workspaceCheck,
  workspaceViewTemplatePolicies,
  wsOrganizationPolicies,
  wsOrganizationReadOnlyPolicies,
  wsOrganizationScopedRequestPolicies,
  wsPolicies,
} from "@/api/db/rls";
import type {
  BankAccount,
  BillingAddress,
  BoundingBoxes,
  CellMetadata,
  ContactAddress,
  ContactEmail,
  ContactPersistedMetadata,
  ContactPhone,
  EntityKind,
  FieldContent,
  PropertyContent,
  PropertyTool,
} from "@/api/db/schema-validators";
import type {
  ChatCompactionSummary,
  ChatMessageRole,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import type { ClauseMetadata } from "@/api/handlers/clauses/metadata";
import type { TemplateRecipeDefinition } from "@/api/handlers/template-recipes/definition";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import type { ClauseBody } from "@/api/lib/clauses/types";
import type { DocumentSource } from "@/api/lib/document-source";
import type { TemplateManifest } from "@/api/lib/docx/types";
import type { AgendaAttendeeType } from "@/api/lib/entity-constants";
import type { CorpusSourceDescriptor } from "@/api/lib/legal-search/corpus-source";
import type {
  DecisionSection,
  EmptyAst,
} from "@/api/lib/legal-search/document-types";
import type { CentsAmount } from "@/api/lib/money";
import { unsafeCents } from "@/api/lib/money";
import type { ViewLayout, ViewTemplateProperty } from "@/api/lib/views-schema";
import type {
  PlaybookDefinitionStatus,
  PlaybookPositions,
  PlaybookScope,
} from "@/api/lib/workflow/playbook-positions";

/** Metadata stored on link entities created by the web clipper. */
export type LinkMetadata = {
  url: string;
  snippet?: string;
  citation?: string;
  jurisdiction?: string;
  sourceType?: string;
};

export type PdfBatesJustificationBlock = {
  kind: "pdf-bates";
  fileFieldId: SafeId<"field">;
  statements: {
    text: string;
    citations: {
      bates: string;
      pageNumber: number;
    }[];
  }[];
};

/** A single DOCX citation, discriminated by whether its quote was
 *  grounded against an allow-listed source block at extraction time.
 *
 *  - `verified`: the quote matched a real block. It carries the block's
 *    literal text (rendered as the quote without re-parsing the DOCX)
 *    and the `blockId` a folio editor scrolls to.
 *  - `unverified`: the model produced a quote that matched no source
 *    block. There is no navigable block, so only the model's raw text
 *    is kept and the client renders it as a non-navigable hint. */
export type DocxFolioJustificationCitation =
  | { citationStatus: "verified"; blockId: string; text: string }
  | { citationStatus: "unverified"; text: string };

export type DocxFolioJustificationBlock = {
  kind: "docx-folio";
  fileFieldId: SafeId<"field">;
  statements: {
    text: string;
    citations: DocxFolioJustificationCitation[];
  }[];
};

// What a tier-match verdict cited to decide it, resolved from the grader's
// ranked answer into stable references (never a raw array index) so a review
// facet or provenance card can render "matches fallback X" / "violates red line
// Y" without re-indexing the resolved tiers:
//   - `fallback`: the accepted alternative the value matched (its optional
//     label + resolved text).
//   - `redLine`: the not-acceptable rule the value violated (its stable id +
//     text) for a deviation.
export type VerdictMatchedRef =
  | { kind: "fallback"; label?: string; text: string }
  | { kind: "redLine"; ruleId: string; text: string };

// A playbook verdict's rationale. Unlike the document-citation blocks above it
// carries no file/bates/folio reference: a tier-match verdict is graded by
// comparing the already-extracted ASK value against the resolved tiered
// standard, so the provenance is the model's explanation plus, when present, the
// resolved `matchedRef` that decided the tier.
export type VerdictRationaleJustificationBlock = {
  kind: "playbook-verdict";
  rationale: string;
  matchedRef?: VerdictMatchedRef;
};

export type JustificationBlock =
  | PdfBatesJustificationBlock
  | DocxFolioJustificationBlock
  | VerdictRationaleJustificationBlock;

export type JustificationContent = {
  version: 1;
  blocks: JustificationBlock[];
};

/** Re-exported so the schema layer keeps one import surface; the agenda member
 *  tuples are declared in `@/api/lib/entity-constants` and every other consumer
 *  derives from them. */
export {
  AGENDA_AVAILABILITIES,
  AGENDA_ITEM_KINDS,
  AGENDA_ITEM_SOURCES,
  AGENDA_SENSITIVITIES,
} from "@/api/lib/entity-constants";
export type {
  AgendaAvailability,
  AgendaItemKind,
  AgendaItemSource,
  AgendaSensitivity,
} from "@/api/lib/entity-constants";

export type AgendaParticipant = {
  email: string | null;
  name: string | null;
};

export type AgendaAttendee = AgendaParticipant & {
  optional?: boolean;
  responseStatus?: string | null;
  type?: AgendaAttendeeType | null;
};

export type AgendaRecurrence = {
  pattern: string | null;
  range: string | null;
  raw?: unknown;
};

export type AgendaExternalData = Record<string, unknown>;

export type SchedulerIntervalSchedule = {
  type: "interval";
  everyMs: number;
};

export type SchedulerDailySchedule = {
  type: "daily";
  hour: number;
  minute: number;
  timeZone: string;
};

export type SchedulerSchedule =
  | SchedulerDailySchedule
  | SchedulerIntervalSchedule;

export type SchedulerPayload = Record<string, unknown>;

export type PracticeJurisdiction = {
  countryCode: CountryCode;
  isPrimary: boolean;
};

export const ACCOUNT_DELETION_REQUEST_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;
export type AccountDeletionRequestStatus =
  (typeof ACCOUNT_DELETION_REQUEST_STATUSES)[number];

export const ENTITY_DELETION_CLEANUP_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;
export type EntityDeletionCleanupStatus =
  (typeof ENTITY_DELETION_CLEANUP_STATUSES)[number];

export const TEMPLATE_DELETION_CLEANUP_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;
export type TemplateDeletionCleanupStatus =
  (typeof TEMPLATE_DELETION_CLEANUP_STATUSES)[number];

/**
 * Search projections driven by the transactional repair queue. This one list
 * types the queue column, generates the table's CHECK constraint, and keys
 * the drain's repair dispatch, so a fourth projection cannot be added to one
 * of the three and forgotten in the others.
 */
export const SEARCH_PROJECTION_KINDS = [
  "contact",
  "entity",
  "workspace",
] as const;
export type SearchProjectionKind = (typeof SEARCH_PROJECTION_KINDS)[number];

export const DESTRUCTIVE_EFFECT_CHUNK_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;
export type DestructiveEffectChunkStatus =
  (typeof DESTRUCTIVE_EFFECT_CHUNK_STATUSES)[number];

export type AccountDeletionStorageCleanup = {
  s3Keys: string[];
};

export const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

export const bytea = customType<{ data: Buffer }>({
  dataType: () => "bytea",
  fromDriver: (value) => {
    if (Buffer.isBuffer(value)) {
      return value;
    }
    if (typeof value === "string") {
      const hex = value.startsWith("\\x") ? value.slice(2) : value;
      return Buffer.from(hex, "hex");
    }
    return panic(`Unexpected bytea driver value: ${typeof value}`);
  },
});

export const safeWorkspaceId = (name: string) =>
  p.uuid(name).$type<SafeId<"workspace">>();

export const safeOrganizationId = (name: string) =>
  p.varchar(name, { length: 128 }).$type<SafeId<"organization">>();

export const safeUuid = <T extends SafeIdType>(name: string) =>
  p.uuid(name).$type<SafeId<T>>();

export const centsColumn = (name: string) =>
  p.integer(name).$type<CentsAmount>();

export const pUuid = <T extends SafeIdType>() =>
  p
    .uuid()
    .$defaultFn(createSafeId<T>)
    .$type<SafeId<T>>();

/**
 * Property computation lifecycle. Two states only — there is no
 * "uninitialized" limbo that the workflow planner could silently
 * skip:
 *  - "stale" : value needs (re)computation; queued for the next
 *              workflow run. AI properties land here at creation
 *              and any time their inputs change.
 *  - "fresh" : value is current. Manual properties land here at
 *              creation; AI properties move here after a workflow
 *              run completes.
 *
 * Callers must pick a status explicitly when inserting (the schema
 * column has no default), so a future fourth state cannot be
 * introduced and silently default new rows into a planner-skipped
 * limbo.
 */
export const PROPERTY_STATUSES = ["stale", "fresh"] as const;
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];

/**
 * Structural role a property plays beyond its content/tool shape.
 * `document-type-classifier` marks the single AI single-select column a
 * workspace's document-type routing keys off, so playbook gating and the
 * grouped table bind to it by identity instead of a magic column name
 * ("Document Type"): it survives renames and localized labels, and a partial
 * unique index makes a second classifier per workspace structurally impossible.
 * Null for ordinary properties.
 */
export const PROPERTY_ROLES = ["document-type-classifier"] as const;
export type PropertyRole = (typeof PROPERTY_ROLES)[number];

/** Re-exported so the schema layer keeps one import surface; the array is
 *  declared in `@stll/api-contract` and every other consumer derives from
 *  it. */
export { ENTITY_KINDS } from "@stll/api-contract";

export { LIST_ITEM_TYPES } from "@stll/api-contract/entity-options";
export type { ListItemType } from "@stll/api-contract/entity-options";

export const TASK_ASSIGNEE_ROLES = ["assignee", "reviewer"] as const;

export {
  BILLING_STATUS,
  EXPENSE_CATEGORIES,
  TIME_ENTRY_SOURCE,
  TIME_ENTRY_SOURCES,
  TIME_ENTRY_STATUSES,
};
export type { ExpenseCategory, TimeEntrySource, TimeEntryStatus };

/**
 * Provenance of a chat thread's title. A three-state discriminator (not a
 * boolean) so background AI title generation can never clobber a title the
 * user chose:
 *   - "default": the placeholder title a freshly created thread starts with;
 *     the only source the background generator is allowed to replace.
 *   - "user": the user renamed the thread; a rename stamps this, and it is
 *     never overwritten by AI titling.
 *   - "ai": the background generator wrote the title; it stamps this after
 *     replacing a "default" title and never regenerates over its own result.
 */
export const CHAT_TITLE_SOURCES = ["default", "user", "ai"] as const;
export type ChatTitleSource = (typeof CHAT_TITLE_SOURCES)[number];
export const CHAT_TITLE_SOURCE = {
  DEFAULT: "default",
  USER: "user",
  AI: "ai",
} as const satisfies Record<string, ChatTitleSource>;

/**
 * Whether a compaction checkpoint's summary may be mined for AI memory, and
 * when it may not, why.
 *
 * Compaction summaries are cumulative: a checkpoint folds the previous
 * checkpoint's summary into its own, so by the time a summary is read the text
 * it came from is no longer identifiable. Deriving extractability at read time
 * from the current deployment flag therefore lets a later re-enable mine
 * content recorded while memory was off, or content a user excluded, through a
 * summary that carries no record of where it came from.
 *
 * The decision belongs to the messages that were summarized, so it is recorded
 * on the segment that summarized them and inherited by every later segment:
 *   - "eligible": every message this summary covers was memory-eligible, and
 *     extraction was enabled for every segment folded into it.
 *   - "message-opted-out": the summary covers at least one message persisted
 *     with `memory_extraction_eligible = false`.
 *   - "consent-inactive": at least one segment was summarized while the
 *     deployment had memory extraction disabled.
 *   - "unknown": provenance predates this column. Not extractable, because the
 *     alternative is asserting a consent decision that was never recorded.
 *
 * Only "eligible" is extractable, and the value is monotone: a chain reports
 * the first reason it stopped being eligible and never recovers, because the
 * content that caused it survives in every later summary.
 */
export const CHAT_COMPACTION_MEMORY_ELIGIBILITIES = [
  "eligible",
  "message-opted-out",
  "consent-inactive",
  "unknown",
] as const;
export type ChatCompactionMemoryEligibility =
  (typeof CHAT_COMPACTION_MEMORY_ELIGIBILITIES)[number];
export const CHAT_COMPACTION_MEMORY_ELIGIBILITY = {
  ELIGIBLE: "eligible",
  MESSAGE_OPTED_OUT: "message-opted-out",
  CONSENT_INACTIVE: "consent-inactive",
  UNKNOWN: "unknown",
} as const satisfies Record<string, ChatCompactionMemoryEligibility>;

/**
 * Checkpoints whose summary the memory extractor may read. Total over the
 * union so a new eligibility value cannot land without a consent decision.
 */
export const CHAT_COMPACTION_MEMORY_EXTRACTABLE = {
  eligible: true,
  "message-opted-out": false,
  "consent-inactive": false,
  unknown: false,
} as const satisfies Record<ChatCompactionMemoryEligibility, boolean>;

// -- Contacts --

export {
  defineRelations,
  isNotNull,
  isNull,
  jsonb,
  member,
  organization,
  p,
  panic,
  sql,
  timestamptz,
  unsafeCents,
  user,
};

export {
  agentSkillPolicies,
  agentSkillResourcePolicies,
  aiMemoryPolicies,
  chatMessagePolicies,
  chatTurnPolicies,
  chatMessageSearchDocumentPolicies,
  chatThreadCompactionPolicies,
  chatThreadPreviewPassagePolicies,
  chatThreadPolicies,
  chatThreadSearchDocumentPolicies,
  caseLawIngestionOnlyPolicies,
  fileChatThreadPolicies,
  globalCaseLawPolicies,
  publicCaseLawReaderPolicies,
  publicLawReaderPolicies,
  mcpConnectorPolicies,
  mcpOAuthClientPolicies,
  mcpOAuthStatePolicies,
  mcpUserConnectionPolicies,
  organizationCheck,
  authoredNotePolicies,
  orgPolicies,
  orgReadOnlyPolicies,
  savedSearchPolicies,
  sharepointConnectionPolicies,
  sharepointOAuthStatePolicies,
  stella,
  templateChatThreadPolicies,
  userPolicies,
  workspaceIdCheck,
  workspaceCheck,
  workspaceViewTemplatePolicies,
  wsOrganizationPolicies,
  wsOrganizationReadOnlyPolicies,
  wsOrganizationScopedRequestPolicies,
  wsPolicies,
};

export type {
  AnyPgColumn,
  BankAccount,
  BillingAddress,
  BoundingBoxes,
  CellMetadata,
  ChatCompactionSummary,
  ChatMessageRole,
  ClauseBody,
  ClauseMetadata,
  ConditionNode,
  ContactAddress,
  ContactEmail,
  ContactPersistedMetadata,
  ContactPhone,
  CorpusSourceDescriptor,
  CentsAmount,
  DecisionSection,
  DocumentAst,
  DocumentSource,
  EmptyAst,
  EntityKind,
  FieldContent,
  PersistedChatMessageContent,
  PersistedDecisionAnalysis,
  PlaybookDefinitionStatus,
  PlaybookPositions,
  PlaybookScope,
  PropertyContent,
  PropertyTool,
  SafeId,
  SafeIdType,
  TemplateManifest,
  TemplateRecipeDefinition,
  ViewLayout,
  ViewTemplateProperty,
};
