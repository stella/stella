import { panic } from "better-result";
import { defineRelations, isNotNull, isNull, sql } from "drizzle-orm";
import * as p from "drizzle-orm/pg-core";
import { customType } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import type { ConditionNode } from "@stll/conditions";
import type { CountryCode } from "@stll/country-codes";
import type { PersistedDecisionAnalysis } from "@stll/legal-ast/analysis";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { organization, user } from "@/api/db/auth-schema";
import { jsonb } from "@/api/db/columns";
import {
  agentSkillPolicies,
  agentSkillResourcePolicies,
  chatMessageSearchDocumentPolicies,
  chatMessagePolicies,
  chatThreadCompactionPolicies,
  chatThreadPolicies,
  chatThreadSearchDocumentPolicies,
  fileChatThreadPolicies,
  globalCaseLawPolicies,
  mcpConnectorPolicies,
  mcpOAuthStatePolicies,
  mcpOAuthClientPolicies,
  mcpUserConnectionPolicies,
  organizationCheck,
  orgPolicies,
  stella,
  templateChatThreadPolicies,
  userPolicies,
  workspaceIdCheck,
  workspaceViewTemplatePolicies,
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
import type { CorpusSourceDescriptor } from "@/api/handlers/case-law/corpus-source";
import type { EmptyAst } from "@/api/handlers/case-law/ingestion/adapter";
import type { DecisionSection } from "@/api/handlers/case-law/types";
import type {
  ChatCompactionSummary,
  ChatMessageRole,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import type { ClauseMetadata } from "@/api/handlers/clauses/metadata";
import type { ClauseBody } from "@/api/handlers/clauses/types";
import type { TemplateManifest } from "@/api/handlers/docx/types";
import type {
  PlaybookDefinitionStatus,
  PlaybookPositions,
  PlaybookScope,
} from "@/api/handlers/playbooks/positions";
import type { TemplateRecipeDefinition } from "@/api/handlers/template-recipes/definition";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import type { CentsAmount } from "@/api/lib/money";
import { unsafeCents } from "@/api/lib/money";
import type { ViewLayout, ViewTemplateProperty } from "@/api/lib/views-schema";

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

export type DocxFolioJustificationBlock = {
  kind: "docx-folio";
  fileFieldId: SafeId<"field">;
  statements: {
    text: string;
    /** Each cite carries the block's literal text captured at
     *  extraction time so the cell-click peek can render the quoted
     *  source without re-parsing the DOCX or fetching anything else.
     *  `blockId` lets a folio editor (Phase 2b) scroll to the same
     *  paragraph the chat editor would. */
    citations: {
      blockId: string;
      text: string;
    }[];
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

export type AgendaItemKind =
  | "deadline"
  | "event"
  | "hearing"
  | "meeting"
  | "task";

export type AgendaItemSource =
  | "api"
  | "calendar"
  | "email"
  | "import"
  | "infosoud"
  | "manual";

export type AgendaAvailability =
  | "busy"
  | "free"
  | "out_of_office"
  | "tentative"
  | "unknown"
  | "working_elsewhere";

export type AgendaSensitivity = "confidential" | "normal" | "private";

export type AgendaParticipant = {
  email: string | null;
  name: string | null;
};

export type AgendaAttendee = AgendaParticipant & {
  optional?: boolean;
  responseStatus?: string | null;
  type?: "optional" | "required" | "resource" | null;
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

export const ENTITY_KINDS = [
  "document",
  "folder",
  "task",
  "message",
  "link",
] as const satisfies readonly EntityKind[];

export const TASK_ASSIGNEE_ROLES = ["assignee", "reviewer"] as const;

export const TIME_ENTRY_STATUSES = [
  "draft",
  "approved",
  "billed",
  "written_off",
] as const;
export type TimeEntryStatus = (typeof TIME_ENTRY_STATUSES)[number];
/** Named constants for time entry and expense statuses
 *  (both tables share TIME_ENTRY_STATUSES). */
export const BILLING_STATUS = {
  DRAFT: "draft",
  APPROVED: "approved",
  BILLED: "billed",
  WRITTEN_OFF: "written_off",
} as const satisfies Record<string, TimeEntryStatus>;

export const EXPENSE_CATEGORIES = [
  "filing_fee",
  "expert_witness",
  "travel",
  "printing",
  "courier",
  "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const TIME_ENTRY_SOURCES = ["manual", "timer"] as const;
export type TimeEntrySource = (typeof TIME_ENTRY_SOURCES)[number];
export const TIME_ENTRY_SOURCE = {
  MANUAL: "manual",
  TIMER: "timer",
} as const satisfies Record<string, TimeEntrySource>;

// -- Contacts --

export {
  defineRelations,
  isNotNull,
  isNull,
  jsonb,
  organization,
  p,
  panic,
  sql,
  unsafeCents,
  user,
};

export {
  agentSkillPolicies,
  agentSkillResourcePolicies,
  chatMessagePolicies,
  chatMessageSearchDocumentPolicies,
  chatThreadCompactionPolicies,
  chatThreadPolicies,
  chatThreadSearchDocumentPolicies,
  fileChatThreadPolicies,
  globalCaseLawPolicies,
  mcpConnectorPolicies,
  mcpOAuthClientPolicies,
  mcpOAuthStatePolicies,
  mcpUserConnectionPolicies,
  organizationCheck,
  orgPolicies,
  stella,
  templateChatThreadPolicies,
  userPolicies,
  workspaceIdCheck,
  workspaceViewTemplatePolicies,
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
