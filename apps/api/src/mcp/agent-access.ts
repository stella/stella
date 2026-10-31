import { panic } from "better-result";

import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";

import type { McpRequestContext } from "@/api/mcp/context";
import type { CAPABILITY_DISPATCH } from "@/api/mcp/generated/capability-dispatch";
import type { McpWriteToolName } from "@/api/mcp/matter-requirement";
import { TOOL_CONFIRMATION } from "@/api/mcp/tool-confirmation";
import type { McpToolAccess } from "@/api/mcp/tool-types";

/**
 * Who may run a capability or tool when an agent calls it.
 *
 * - `open`: any agent call runs.
 * - `caller-confirms`: the calling client asks its person and relays the
 *   answer as `confirm: true`.
 * - `person-approves`: a person approves the call inside stella. The in-app
 *   chat asks through its approval step; MCP and CLI calls are refused.
 * - `person-only`: never runs from an agent. Agents still see the operation,
 *   with where a person performs it.
 *
 * Every catalog capability and every write tool has one, in the two total maps
 * below. Neither map is exported: `decideAgentCall` and `describeAgentAccess`
 * are the only readers, both through `effectiveAgentAccess`.
 */
export const AGENT_ACCESS_KIND = {
  open: "open",
  callerConfirms: "caller-confirms",
  personApproves: "person-approves",
  personOnly: "person-only",
} as const;

/** Where a person performs a `person-only` operation, as agents are told. */
const PERSON_ONLY_LOCATIONS = {
  "matter-menu":
    "the matter's menu in the matters list, or its details panel, in the stella web app",
} as const;

type PersonOnlyLocation = keyof typeof PERSON_ONLY_LOCATIONS;

/**
 * Why a write runs on any agent call. Reads are `open` as `reads-only`; the
 * agent-access census refuses a write classified that way, so every open write
 * names one of these.
 *
 * - `edits-content`: creates or changes content the people who share it see
 *   and can change again.
 * - `runs-processing`: starts, follows or stops a generation, analysis or run
 *   whose output people review as content.
 * - `caller-state`: changes only the caller's own threads, notifications or
 *   defaults.
 * - `returns-one-file`: returns one generated document to the caller.
 */
type OpenWriteReason =
  "edits-content" | "runs-processing" | "caller-state" | "returns-one-file";

export type AgentAccess =
  | { kind: typeof AGENT_ACCESS_KIND.open; reason: "reads-only" }
  | { kind: typeof AGENT_ACCESS_KIND.open; reason: OpenWriteReason }
  | {
      kind: typeof AGENT_ACCESS_KIND.callerConfirms;
      reason: "destroys-data" | "writes-content";
    }
  | {
      kind: typeof AGENT_ACCESS_KIND.callerConfirms;
      reason: "outbound";
      /** What leaves the workspace, as the refusal tells the model. */
      sends: string;
    }
  | {
      kind: typeof AGENT_ACCESS_KIND.personApproves;
      reason:
        | "grants-access"
        | "revokes-access"
        | "destroys-data"
        | "writes-content"
        | "outbound"
        /** Settings that apply to everyone in the organization. */
        | "changes-organization-settings";
    }
  | {
      kind: typeof AGENT_ACCESS_KIND.personOnly;
      reason: "deletes-matter";
      where: PersonOnlyLocation;
    };

/**
 * A write tool's access. `per-capability` is the generic executor: the
 * capability it selects decides, at the capability dispatch boundary.
 */
type ToolAgentAccess = AgentAccess | { kind: "per-capability" };

/** A write tool open to agents names why, so a write cannot pass as a read. */
type WriteToolAgentAccess = Exclude<ToolAgentAccess, { reason: "reads-only" }>;

const OPEN_READ = {
  kind: AGENT_ACCESS_KIND.open,
  reason: "reads-only",
} as const satisfies AgentAccess;
const OPEN_EDITS_CONTENT = {
  kind: AGENT_ACCESS_KIND.open,
  reason: "edits-content",
} as const satisfies AgentAccess;
const OPEN_RUNS_PROCESSING = {
  kind: AGENT_ACCESS_KIND.open,
  reason: "runs-processing",
} as const satisfies AgentAccess;
const OPEN_CALLER_STATE = {
  kind: AGENT_ACCESS_KIND.open,
  reason: "caller-state",
} as const satisfies AgentAccess;
const OPEN_RETURNS_ONE_FILE = {
  kind: AGENT_ACCESS_KIND.open,
  reason: "returns-one-file",
} as const satisfies AgentAccess;
const CONFIRM_DESTROYS_DATA = {
  kind: AGENT_ACCESS_KIND.callerConfirms,
  reason: "destroys-data",
} as const satisfies AgentAccess;
const CONFIRM_WRITES_CONTENT = {
  kind: AGENT_ACCESS_KIND.callerConfirms,
  reason: "writes-content",
} as const satisfies AgentAccess;
const APPROVE_WRITES_CONTENT = {
  kind: AGENT_ACCESS_KIND.personApproves,
  reason: "writes-content",
} as const satisfies AgentAccess;
const APPROVE_DESTROYS_DATA = {
  kind: AGENT_ACCESS_KIND.personApproves,
  reason: "destroys-data",
} as const satisfies AgentAccess;
const APPROVE_GRANTS_ACCESS = {
  kind: AGENT_ACCESS_KIND.personApproves,
  reason: "grants-access",
} as const satisfies AgentAccess;
const APPROVE_REVOKES_ACCESS = {
  kind: AGENT_ACCESS_KIND.personApproves,
  reason: "revokes-access",
} as const satisfies AgentAccess;
const APPROVE_ORGANIZATION_SETTINGS = {
  kind: AGENT_ACCESS_KIND.personApproves,
  reason: "changes-organization-settings",
} as const satisfies AgentAccess;
const APPROVE_OUTBOUND = {
  kind: AGENT_ACCESS_KIND.personApproves,
  reason: "outbound",
} as const satisfies AgentAccess;
const PERSON_ONLY_DELETES_MATTER = {
  kind: AGENT_ACCESS_KIND.personOnly,
  reason: "deletes-matter",
  where: "matter-menu",
} as const satisfies AgentAccess;
const PER_CAPABILITY = {
  kind: "per-capability",
} as const satisfies ToolAgentAccess;

/** Read tools are structurally `open`; every write tool decides here. */
const WRITE_TOOL_AGENT_ACCESS = {
  save_matter: OPEN_EDITS_CONTENT,
  delete_matter: PERSON_ONLY_DELETES_MATTER,
  save_contact: OPEN_EDITS_CONTENT,
  delete_contact: CONFIRM_DESTROYS_DATA,
  save_task: OPEN_EDITS_CONTENT,
  delete_task: CONFIRM_DESTROYS_DATA,
  link_matter_contact: OPEN_EDITS_CONTENT,
  save_document: OPEN_EDITS_CONTENT,
  upload_document_version: OPEN_EDITS_CONTENT,
  open_document_version_upload: OPEN_EDITS_CONTENT,
  delete_document: APPROVE_DESTROYS_DATA,
  compare_documents: OPEN_RUNS_PROCESSING,
  prepare_file_comparison: OPEN_RUNS_PROCESSING,
  prepare_file_comparison_from_links: OPEN_RUNS_PROCESSING,
  open_file_comparison: OPEN_RUNS_PROCESSING,
  set_field_value: OPEN_EDITS_CONTENT,
  save_time_entry: CONFIRM_WRITES_CONTENT,
  delete_time_entry: CONFIRM_DESTROYS_DATA,
  save_clause: OPEN_EDITS_CONTENT,
  save_playbook: OPEN_EDITS_CONTENT,
  delete_clause: CONFIRM_DESTROYS_DATA,
  run_playbook: OPEN_RUNS_PROCESSING,
  create_reader_annotation: OPEN_EDITS_CONTENT,
  update_reader_annotation: OPEN_EDITS_CONTENT,
  delete_reader_annotation: CONFIRM_DESTROYS_DATA,
  add_matter_member: APPROVE_GRANTS_ACCESS,
  remove_matter_member: APPROVE_REVOKES_ACCESS,
  update_organization_settings: APPROVE_ORGANIZATION_SETTINGS,
  set_practice_jurisdictions: APPROVE_ORGANIZATION_SETTINGS,
  fill_template: OPEN_RETURNS_ONE_FILE,
  save_filled_template: OPEN_EDITS_CONTENT,
  create_template: OPEN_EDITS_CONTENT,
  configure_template_fields: OPEN_EDITS_CONTENT,
  mint_web_handoff: OPEN_CALLER_STATE,
  [MCP_CAPABILITY_EXECUTORS.write]: PER_CAPABILITY,
  submit_feedback: {
    kind: AGENT_ACCESS_KIND.callerConfirms,
    reason: "outbound",
    sends:
      "submit_feedback sends this report to the stella maintainers and may publish it as an issue.",
  },
} as const satisfies Record<McpWriteToolName, WriteToolAgentAccess>;

type CatalogCapabilityId = keyof typeof CAPABILITY_DISPATCH;

/**
 * Every catalog capability, keyed by the generated dispatch ids so a new
 * capability fails typecheck until it is classified. The agent-access suite
 * derives what each one must be from its catalog metadata: reads are
 * `OPEN_READ` outside a typed exception list, an open write names its reason,
 * no destructive capability is open, and a declared `personApprovedEffect`,
 * an approve or review permission, or an anonymization write means
 * `person-approves`.
 */
const CAPABILITY_AGENT_ACCESS = {
  "account-exports.create": {
    kind: AGENT_ACCESS_KIND.personApproves,
    reason: "writes-content",
  },
  "account-exports.download.get": APPROVE_OUTBOUND,
  "account-exports.get": OPEN_READ,
  "account-exports.status.get": OPEN_READ,
  "tasks.list": OPEN_READ,
  "client-invoices.create": APPROVE_WRITES_CONTENT,
  "client-invoices.prefill": OPEN_READ,
  "invoices.payments.create": APPROVE_WRITES_CONTENT,
  "invoices.payments.list": OPEN_READ,
  "invoices.payments.void": APPROVE_WRITES_CONTENT,
  "time-entries.me.submissions.create": CONFIRM_WRITES_CONTENT,
  "time-entries.me.suggestions.list": OPEN_READ,
  "audit-logs.list": OPEN_READ,
  "billing-codes.create": APPROVE_WRITES_CONTENT,
  "billing-codes.delete": APPROVE_DESTROYS_DATA,
  "billing-codes.list": OPEN_READ,
  "billing-codes.update": APPROVE_WRITES_CONTENT,
  "case-law.analysis.generate": OPEN_RUNS_PROCESSING,
  "case-law.ingestion.get": OPEN_READ,
  "case-law.matter-links.batch.create": OPEN_EDITS_CONTENT,
  "case-law.matter-links.create": OPEN_EDITS_CONTENT,
  "case-law.matter-links.delete": CONFIRM_DESTROYS_DATA,
  "case-law.matter-links.list": OPEN_READ,
  "catalogue.install": OPEN_EDITS_CONTENT,
  "catalogue.list": OPEN_READ,
  "chat.decision-threads.get": OPEN_READ,
  "chat.export.create": OPEN_RETURNS_ONE_FILE,
  "chat.fork.create": OPEN_CALLER_STATE,
  "chat.messages.list": OPEN_READ,
  "chat.messages.revisions.list": OPEN_READ,
  "chat.older-messages.list": OPEN_READ,
  "chat.threads.delete": CONFIRM_DESTROYS_DATA,
  "chat.threads.list": OPEN_READ,
  "chat.threads.rename": OPEN_CALLER_STATE,
  "chat.threads.update": OPEN_CALLER_STATE,
  "clauses.categories.create": OPEN_EDITS_CONTENT,
  "clauses.categories.delete": CONFIRM_DESTROYS_DATA,
  "clauses.categories.list": OPEN_READ,
  "clauses.categories.update": OPEN_EDITS_CONTENT,
  "clauses.create": OPEN_EDITS_CONTENT,
  "clauses.delete": CONFIRM_DESTROYS_DATA,
  "clauses.export": APPROVE_OUTBOUND,
  "clauses.get": OPEN_READ,
  "clauses.import": OPEN_EDITS_CONTENT,
  "clauses.list": OPEN_READ,
  "clauses.rewrite": OPEN_RUNS_PROCESSING,
  "clauses.template-slots.preview": OPEN_READ,
  "clauses.update": OPEN_EDITS_CONTENT,
  "clauses.variants.create": OPEN_EDITS_CONTENT,
  "clauses.variants.delete": CONFIRM_DESTROYS_DATA,
  "clauses.variants.list": OPEN_READ,
  "clauses.variants.update": OPEN_EDITS_CONTENT,
  "clauses.versions.diff": OPEN_READ,
  "clauses.versions.get": OPEN_READ,
  "clauses.versions.restore": OPEN_EDITS_CONTENT,
  "clauses.versions.summarize": OPEN_RUNS_PROCESSING,
  "contacts.business-registries.check": OPEN_READ,
  "contacts.business-registries.lookup": OPEN_READ,
  "contacts.create": OPEN_EDITS_CONTENT,
  "contacts.delete": CONFIRM_DESTROYS_DATA,
  "contacts.export": APPROVE_OUTBOUND,
  "contacts.get": OPEN_READ,
  "contacts.import": OPEN_EDITS_CONTENT,
  "contacts.list": OPEN_READ,
  "contacts.sanctions.events.list": OPEN_READ,
  "contacts.sanctions.get": OPEN_READ,
  "contacts.sanctions.matches.list": OPEN_READ,
  "contacts.sanctions.monitoring.update": APPROVE_WRITES_CONTENT,
  "contacts.sanctions.reviews.update": APPROVE_WRITES_CONTENT,
  "contacts.search": OPEN_READ,
  "contacts.update": OPEN_EDITS_CONTENT,
  "document-translations.prepare": OPEN_READ,
  "document-translations.runs.create": OPEN_RUNS_PROCESSING,
  "document-translations.runs.get": OPEN_READ,
  "document-types.create": APPROVE_ORGANIZATION_SETTINGS,
  "document-types.delete": APPROVE_ORGANIZATION_SETTINGS,
  "document-types.list": OPEN_READ,
  "document-types.reorder": APPROVE_ORGANIZATION_SETTINGS,
  "document-types.update": APPROVE_ORGANIZATION_SETTINGS,
  "documents.compare": OPEN_RUNS_PROCESSING,
  "docx-suggestions.list": OPEN_READ,
  "docx-suggestions.resolve": CONFIRM_WRITES_CONTENT,
  "docx-suggestions.revert": CONFIRM_WRITES_CONTENT,
  "entities.bilingual.create": OPEN_EDITS_CONTENT,
  "entities.blank-document.create": OPEN_EDITS_CONTENT,
  "entities.clip": OPEN_EDITS_CONTENT,
  "entities.copy": CONFIRM_DESTROYS_DATA,
  "entities.create": OPEN_EDITS_CONTENT,
  "entities.delete": APPROVE_DESTROYS_DATA,
  "entities.duplicate": OPEN_EDITS_CONTENT,
  "entities.files.list": OPEN_READ,
  "entities.filesystem-tree.get": OPEN_READ,
  "entities.folder-from-selection.create": OPEN_EDITS_CONTENT,
  "entities.folders.list": OPEN_READ,
  "entities.from-legal-source.create": OPEN_EDITS_CONTENT,
  "entities.get": OPEN_READ,
  "entities.list": OPEN_READ,
  "entities.move": OPEN_EDITS_CONTENT,
  "entities.ocr.create": OPEN_RUNS_PROCESSING,
  "entities.placements.suggest": OPEN_RUNS_PROCESSING,
  "entities.rename": OPEN_EDITS_CONTENT,
  "entities.stamps.check": OPEN_READ,
  "entities.summaries.count": OPEN_READ,
  "entities.summaries.list": OPEN_READ,
  "entities.upload": OPEN_EDITS_CONTENT,
  "entities.versions.delete": CONFIRM_DESTROYS_DATA,
  "entities.versions.description.update": OPEN_EDITS_CONTENT,
  "entities.versions.diff": OPEN_READ,
  "entities.versions.get": OPEN_READ,
  "entities.versions.label.update": OPEN_EDITS_CONTENT,
  "entities.versions.list": OPEN_READ,
  "entities.versions.restore": OPEN_EDITS_CONTENT,
  "entities.versions.summarize": OPEN_RUNS_PROCESSING,
  "entities.versions.upload": OPEN_EDITS_CONTENT,
  "entities.window.list": OPEN_READ,
  "entities.zip.download": APPROVE_OUTBOUND,
  "entity-views.create": OPEN_EDITS_CONTENT,
  "entity-views.delete": CONFIRM_DESTROYS_DATA,
  "entity-views.list": OPEN_READ,
  "entity-views.reorder": OPEN_EDITS_CONTENT,
  "entity-views.rows.list": OPEN_READ,
  "entity-views.update": OPEN_EDITS_CONTENT,
  "expenses.create": APPROVE_WRITES_CONTENT,
  "expenses.delete": APPROVE_DESTROYS_DATA,
  "expenses.list": OPEN_READ,
  "expenses.update": APPROVE_WRITES_CONTENT,
  "fields.cell-metadata.update": OPEN_EDITS_CONTENT,
  "fields.column-flag.update": OPEN_EDITS_CONTENT,
  "fields.kanban-placement.update": OPEN_EDITS_CONTENT,
  "fields.upsert": OPEN_EDITS_CONTENT,
  "flows.create": OPEN_EDITS_CONTENT,
  "flows.delete": CONFIRM_DESTROYS_DATA,
  "flows.get": OPEN_READ,
  "flows.list": OPEN_READ,
  "flows.runs.cancel": OPEN_RUNS_PROCESSING,
  "flows.runs.get": OPEN_READ,
  "flows.runs.list": OPEN_READ,
  "flows.runs.review": APPROVE_WRITES_CONTENT,
  "flows.runs.start": OPEN_RUNS_PROCESSING,
  "flows.update": OPEN_EDITS_CONTENT,
  "invoices.create": APPROVE_WRITES_CONTENT,
  "invoices.delete": APPROVE_DESTROYS_DATA,
  "invoices.entries.add": APPROVE_WRITES_CONTENT,
  "invoices.entries.remove": APPROVE_WRITES_CONTENT,
  "invoices.export": APPROVE_OUTBOUND,
  "invoices.get": OPEN_READ,
  "invoices.lines.create": APPROVE_WRITES_CONTENT,
  "invoices.lines.delete": APPROVE_DESTROYS_DATA,
  "invoices.lines.update": APPROVE_WRITES_CONTENT,
  "invoices.list": OPEN_READ,
  "invoices.pdf.export": CONFIRM_WRITES_CONTENT,
  "invoices.prefill": OPEN_READ,
  "invoices.transition": APPROVE_WRITES_CONTENT,
  "invoices.update": APPROVE_WRITES_CONTENT,
  "legal-reader.annotations.create": OPEN_EDITS_CONTENT,
  "legal-reader.annotations.delete": CONFIRM_DESTROYS_DATA,
  "legal-reader.annotations.list": OPEN_READ,
  "legal-reader.annotations.update": OPEN_EDITS_CONTENT,
  "legislation.boe.law-structure.get": OPEN_READ,
  "legislation.boe.laws.get": OPEN_READ,
  "legislation.boe.related-laws.list": OPEN_READ,
  "legislation.boe.search": OPEN_READ,
  "legislation.boe.text-block.get": OPEN_READ,
  "legislation.borme.summary.get": OPEN_READ,
  "legislation.get": OPEN_READ,
  "legislation.search": OPEN_READ,
  "lists.columns.create": OPEN_EDITS_CONTENT,
  "lists.create": OPEN_EDITS_CONTENT,
  "lists.generation-candidates.acceptance.create": OPEN_EDITS_CONTENT,
  "lists.generation-candidates.create": OPEN_RUNS_PROCESSING,
  "lists.generation-candidates.list": OPEN_READ,
  "lists.generation-candidates.rejection.create": OPEN_EDITS_CONTENT,
  "lists.generations.create": OPEN_RUNS_PROCESSING,
  "lists.generations.list": OPEN_READ,
  "lists.get": OPEN_READ,
  "lists.items.activity.list": OPEN_READ,
  "lists.items.comments.create": OPEN_EDITS_CONTENT,
  "lists.items.fact-details.update": OPEN_EDITS_CONTENT,
  "lists.items.list": OPEN_READ,
  "lists.items.reviews.update": APPROVE_WRITES_CONTENT,
  "lists.items.sources.create": OPEN_EDITS_CONTENT,
  "lists.items.sources.list": OPEN_READ,
  "lists.items.sources.verification.update": APPROVE_WRITES_CONTENT,
  "lists.items.update": OPEN_EDITS_CONTENT,
  "lists.list": OPEN_READ,
  "lists.sample-case.create": OPEN_EDITS_CONTENT,
  "lists.sections.create": OPEN_EDITS_CONTENT,
  "lists.update": OPEN_EDITS_CONTENT,
  "lists.verifications.claim-comments.create": OPEN_EDITS_CONTENT,
  "lists.verifications.claim-comments.delete": CONFIRM_DESTROYS_DATA,
  "lists.verifications.claim-comments.list": OPEN_READ,
  "lists.verifications.claim-comments.update": OPEN_EDITS_CONTENT,
  "lists.verifications.claim-reviews.bulk.create": APPROVE_WRITES_CONTENT,
  "lists.verifications.claim-reviews.create": APPROVE_WRITES_CONTENT,
  "lists.verifications.create": OPEN_EDITS_CONTENT,
  "lists.verifications.get": OPEN_READ,
  "lists.verifications.latest.list": OPEN_READ,
  "lists.verifications.list": OPEN_READ,
  "matters.anonymization-allowlist.create": APPROVE_WRITES_CONTENT,
  "matters.anonymization-allowlist.delete": APPROVE_DESTROYS_DATA,
  "matters.anonymization-allowlist.list": OPEN_READ,
  "matters.anonymization-terms.create": APPROVE_WRITES_CONTENT,
  "matters.anonymization-terms.delete": APPROVE_DESTROYS_DATA,
  "matters.anonymization-terms.list": OPEN_READ,
  "matters.archive": OPEN_EDITS_CONTENT,
  "matters.cells.retry": OPEN_RUNS_PROCESSING,
  "matters.contacts.create": OPEN_EDITS_CONTENT,
  "matters.contacts.delete": CONFIRM_DESTROYS_DATA,
  "matters.correspondence.get": OPEN_READ,
  "matters.correspondence.list": OPEN_READ,
  "matters.correspondence.update": OPEN_EDITS_CONTENT,
  "matters.create": OPEN_EDITS_CONTENT,
  "matters.delete": PERSON_ONLY_DELETES_MATTER,
  "matters.duplicate": OPEN_EDITS_CONTENT,
  "matters.justifications.list": OPEN_READ,
  "matters.list": OPEN_READ,
  "matters.members.add": APPROVE_GRANTS_ACCESS,
  "matters.members.remove": APPROVE_REVOKES_ACCESS,
  "matters.search-preview.get": OPEN_READ,
  "matters.unarchive": OPEN_EDITS_CONTENT,
  "matters.update": OPEN_EDITS_CONTENT,
  "matters.vocabulary.get": OPEN_READ,
  "matters.workflow.get": OPEN_READ,
  "matters.workflow.start": OPEN_RUNS_PROCESSING,
  "matters.workflow.targets.count": OPEN_READ,
  "memories.create": CONFIRM_WRITES_CONTENT,
  "memories.list": OPEN_READ,
  "memories.update": CONFIRM_WRITES_CONTENT,
  "notifications.list": OPEN_READ,
  "notifications.read-state.update": OPEN_CALLER_STATE,
  "number-series.archive": APPROVE_ORGANIZATION_SETTINGS,
  "number-series.create": APPROVE_ORGANIZATION_SETTINGS,
  "number-series.default.update": APPROVE_ORGANIZATION_SETTINGS,
  "number-series.get": OPEN_READ,
  "number-series.list": OPEN_READ,
  "number-series.preview": OPEN_READ,
  "number-series.update": APPROVE_ORGANIZATION_SETTINGS,
  "organization-settings.ai-availability.get": OPEN_READ,
  "organization-settings.anonymization-blacklist.get": OPEN_READ,
  "organization-settings.anonymization-blacklist.update":
    APPROVE_ORGANIZATION_SETTINGS,
  "organization-settings.correspondence.allowed-senders.create":
    APPROVE_ORGANIZATION_SETTINGS,
  "organization-settings.correspondence.allowed-senders.delete":
    APPROVE_ORGANIZATION_SETTINGS,
  // A read: the catalog files it under write because only a settings
  // administrator (`organizationSettings: update`) may list the senders.
  "organization-settings.correspondence.allowed-senders.list":
    APPROVE_ORGANIZATION_SETTINGS,
  "organization-settings.correspondence.allowed-senders.scope.add":
    APPROVE_ORGANIZATION_SETTINGS,
  "organization-settings.correspondence.allowed-senders.scope.remove":
    APPROVE_ORGANIZATION_SETTINGS,
  "organization-settings.deepl-availability.get": OPEN_READ,
  "organization-settings.document-ocr-availability.get": OPEN_READ,
  "organization-settings.get": OPEN_READ,
  "organization-settings.practice-jurisdictions.update":
    APPROVE_ORGANIZATION_SETTINGS,
  "organization-settings.preview": OPEN_READ,
  "organization-settings.sanctions-monitoring.update":
    APPROVE_ORGANIZATION_SETTINGS,
  "organization-settings.update": APPROVE_ORGANIZATION_SETTINGS,
  "playbooks.applicable.run": OPEN_RUNS_PROCESSING,
  "playbooks.approve": APPROVE_WRITES_CONTENT,
  "playbooks.create": OPEN_EDITS_CONTENT,
  "playbooks.delete": CONFIRM_DESTROYS_DATA,
  "playbooks.from-run.create": OPEN_EDITS_CONTENT,
  "playbooks.from-starter.create": OPEN_EDITS_CONTENT,
  "playbooks.get": OPEN_READ,
  "playbooks.list": OPEN_READ,
  "playbooks.recent.list": OPEN_READ,
  "playbooks.run": OPEN_RUNS_PROCESSING,
  "playbooks.starters.list": OPEN_READ,
  "playbooks.update": OPEN_EDITS_CONTENT,
  "playbooks.versions.list": OPEN_READ,
  "playbooks.versions.restore": OPEN_EDITS_CONTENT,
  "properties.batch.create": OPEN_EDITS_CONTENT,
  "properties.create": OPEN_EDITS_CONTENT,
  "properties.delete": CONFIRM_DESTROYS_DATA,
  "properties.list": OPEN_READ,
  "properties.preview": OPEN_RUNS_PROCESSING,
  "properties.prompt.suggest": OPEN_RUNS_PROCESSING,
  "properties.update": OPEN_EDITS_CONTENT,
  "rates.arrangement.get": OPEN_READ,
  "rates.arrangement.summary.get": OPEN_READ,
  "rates.arrangement.update": APPROVE_WRITES_CONTENT,
  "rates.create": APPROVE_WRITES_CONTENT,
  "rates.delete": APPROVE_DESTROYS_DATA,
  "rates.entries.create": APPROVE_WRITES_CONTENT,
  "rates.entries.delete": APPROVE_DESTROYS_DATA,
  "rates.entries.list": OPEN_READ,
  "rates.entries.update": APPROVE_WRITES_CONTENT,
  "rates.list": OPEN_READ,
  "rates.resolve": OPEN_READ,
  "rates.update": APPROVE_WRITES_CONTENT,
  "reports.builtins.clone": OPEN_EDITS_CONTENT,
  "reports.exports.get": APPROVE_OUTBOUND,
  "reports.exports.list": OPEN_READ,
  "reports.templates.list": OPEN_READ,
  "reports.views.export": APPROVE_OUTBOUND,
  "saved-time-narratives.create": CONFIRM_WRITES_CONTENT,
  "saved-time-narratives.delete": CONFIRM_DESTROYS_DATA,
  "saved-time-narratives.list": OPEN_READ,
  "saved-time-narratives.update": CONFIRM_WRITES_CONTENT,
  "search-history.clear": CONFIRM_DESTROYS_DATA,
  "search-history.delete": CONFIRM_DESTROYS_DATA,
  "search-history.list": OPEN_READ,
  "seller-profiles.archive": APPROVE_ORGANIZATION_SETTINGS,
  "seller-profiles.create": APPROVE_ORGANIZATION_SETTINGS,
  "seller-profiles.default.update": APPROVE_ORGANIZATION_SETTINGS,
  "seller-profiles.get": OPEN_READ,
  "seller-profiles.list": OPEN_READ,
  "seller-profiles.update": APPROVE_ORGANIZATION_SETTINGS,
  "signals.acceptances.create": OPEN_EDITS_CONTENT,
  "signals.assignments.create": OPEN_EDITS_CONTENT,
  "signals.dismissals.create": OPEN_EDITS_CONTENT,
  "signals.get": OPEN_READ,
  "signals.list": OPEN_READ,
  "signals.requests.create": OPEN_EDITS_CONTENT,
  "signals.snoozes.create": OPEN_EDITS_CONTENT,
  "skills.commands.list": OPEN_READ,
  "skills.comments.create": OPEN_EDITS_CONTENT,
  "skills.comments.delete": CONFIRM_DESTROYS_DATA,
  "skills.comments.list": OPEN_READ,
  "skills.comments.update": OPEN_EDITS_CONTENT,
  "skills.create": OPEN_EDITS_CONTENT,
  "skills.delete": CONFIRM_DESTROYS_DATA,
  "skills.discover": OPEN_RUNS_PROCESSING,
  "skills.drafts.generate": OPEN_RUNS_PROCESSING,
  "skills.from-blueprint.create": OPEN_EDITS_CONTENT,
  "skills.from-url.import": OPEN_EDITS_CONTENT,
  "skills.get": OPEN_READ,
  "skills.import": OPEN_EDITS_CONTENT,
  "skills.list": OPEN_READ,
  "skills.proposals.create": OPEN_EDITS_CONTENT,
  "skills.proposals.delete": CONFIRM_DESTROYS_DATA,
  "skills.proposals.from-comments.create": OPEN_EDITS_CONTENT,
  "skills.proposals.get": OPEN_READ,
  "skills.proposals.list": OPEN_READ,
  "skills.proposals.review": APPROVE_WRITES_CONTENT,
  "skills.proposals.update": OPEN_EDITS_CONTENT,
  "skills.resources.create": OPEN_EDITS_CONTENT,
  "skills.resources.delete": CONFIRM_DESTROYS_DATA,
  "skills.resources.rename": OPEN_EDITS_CONTENT,
  "skills.resources.rewrite": OPEN_RUNS_PROCESSING,
  "skills.resources.update": OPEN_EDITS_CONTENT,
  "skills.resources.upload": OPEN_EDITS_CONTENT,
  "skills.revisions.get": OPEN_READ,
  "skills.revisions.list": OPEN_READ,
  "skills.update": OPEN_EDITS_CONTENT,
  "skills.upload": OPEN_EDITS_CONTENT,
  "style-sets.create": OPEN_EDITS_CONTENT,
  "style-sets.delete": CONFIRM_DESTROYS_DATA,
  "style-sets.download": OPEN_READ,
  "style-sets.editor.get": OPEN_READ,
  "style-sets.from-editor.create": OPEN_EDITS_CONTENT,
  "style-sets.from-editor.update": OPEN_EDITS_CONTENT,
  "style-sets.list": OPEN_READ,
  "style-sets.replace": OPEN_EDITS_CONTENT,
  "style-sets.stella-editor.get": OPEN_READ,
  "style-sets.update": OPEN_EDITS_CONTENT,
  "tasks.assignees.add": OPEN_EDITS_CONTENT,
  "tasks.assignees.move": OPEN_EDITS_CONTENT,
  "tasks.assignees.remove": CONFIRM_DESTROYS_DATA,
  "tasks.calendar.list": OPEN_READ,
  "tasks.create": OPEN_EDITS_CONTENT,
  "tasks.entity-links.create": OPEN_EDITS_CONTENT,
  "tasks.entity-links.delete": CONFIRM_DESTROYS_DATA,
  "tasks.entity-links.list": OPEN_READ,
  "tasks.get": OPEN_READ,
  "tasks.update": OPEN_EDITS_CONTENT,
  "template-packs.get": OPEN_READ,
  "template-packs.installs.create": OPEN_EDITS_CONTENT,
  "template-packs.list": OPEN_READ,
  "template-packs.visibility.update": APPROVE_ORGANIZATION_SETTINGS,
  "template-recipes.create": OPEN_EDITS_CONTENT,
  "template-recipes.delete": CONFIRM_DESTROYS_DATA,
  "template-recipes.list": OPEN_READ,
  "templates.bindings.list": OPEN_READ,
  "templates.blank.create": OPEN_EDITS_CONTENT,
  "templates.categories.create": OPEN_EDITS_CONTENT,
  "templates.categories.delete": CONFIRM_DESTROYS_DATA,
  "templates.categories.list": OPEN_READ,
  "templates.categories.update": OPEN_EDITS_CONTENT,
  "templates.check": OPEN_READ,
  "templates.clause-slots.list": OPEN_READ,
  "templates.clause-slots.update": OPEN_EDITS_CONTENT,
  "templates.clauses.link": OPEN_EDITS_CONTENT,
  "templates.clauses.list": OPEN_READ,
  "templates.clauses.sync": OPEN_EDITS_CONTENT,
  "templates.clauses.unlink": OPEN_EDITS_CONTENT,
  "templates.condition-decisions.get": OPEN_READ,
  "templates.create": OPEN_EDITS_CONTENT,
  "templates.delete": CONFIRM_DESTROYS_DATA,
  "templates.discover": OPEN_READ,
  "templates.document.update": OPEN_EDITS_CONTENT,
  "templates.fields.suggest": OPEN_RUNS_PROCESSING,
  "templates.fill": OPEN_RETURNS_ONE_FILE,
  "templates.fills.create": OPEN_EDITS_CONTENT,
  "templates.fills.download": OPEN_RETURNS_ONE_FILE,
  "templates.fills.preview": OPEN_READ,
  "templates.from-style-set.create": OPEN_EDITS_CONTENT,
  "templates.from-styles.create": OPEN_EDITS_CONTENT,
  "templates.get": OPEN_READ,
  "templates.list": OPEN_READ,
  "templates.lookup-formats.create": OPEN_EDITS_CONTENT,
  "templates.lookup-formats.default.update": APPROVE_ORGANIZATION_SETTINGS,
  "templates.lookup-formats.delete": CONFIRM_DESTROYS_DATA,
  "templates.lookup-formats.list": OPEN_READ,
  "templates.lookup-formats.my-default.update": OPEN_CALLER_STATE,
  "templates.lookups.preview": OPEN_READ,
  "templates.outdated-clauses.sync": OPEN_EDITS_CONTENT,
  "templates.prefill": OPEN_RUNS_PROCESSING,
  "templates.prepare": OPEN_RUNS_PROCESSING,
  "templates.preview": OPEN_READ,
  "templates.update": OPEN_EDITS_CONTENT,
  "templates.versions.diff": OPEN_READ,
  "templates.versions.get": OPEN_READ,
  "templates.versions.list": OPEN_READ,
  "templates.versions.summarize": OPEN_RUNS_PROCESSING,
  "time-entries.approval-queue.approve": APPROVE_WRITES_CONTENT,
  "time-entries.approval-queue.list": OPEN_READ,
  "time-entries.approval-queue.return": APPROVE_WRITES_CONTENT,
  "time-entries.batch.delete": APPROVE_DESTROYS_DATA,
  "time-entries.batch.update": APPROVE_WRITES_CONTENT,
  "time-entries.create": CONFIRM_WRITES_CONTENT,
  "time-entries.csv.export": APPROVE_OUTBOUND,
  "time-entries.delete": CONFIRM_DESTROYS_DATA,
  "time-entries.get": OPEN_READ,
  "time-entries.internal.create": CONFIRM_WRITES_CONTENT,
  "time-entries.ledes.export": APPROVE_OUTBOUND,
  "time-entries.list": OPEN_READ,
  "time-entries.me.daily-target.update": CONFIRM_WRITES_CONTENT,
  "time-entries.me.list": OPEN_READ,
  "time-entries.members.daily-target.update": APPROVE_ORGANIZATION_SETTINGS,
  "time-entries.pdf.export": APPROVE_OUTBOUND,
  "time-entries.split": APPROVE_WRITES_CONTENT,
  "time-entries.suggestions.decisions.create": CONFIRM_WRITES_CONTENT,
  "time-entries.suggestions.list": OPEN_READ,
  "time-entries.summary.get": OPEN_READ,
  "time-entries.update": CONFIRM_WRITES_CONTENT,
  "time-timers.admin.list": OPEN_READ,
  "time-timers.admin.stop": APPROVE_WRITES_CONTENT,
  "time-timers.confirm": CONFIRM_WRITES_CONTENT,
  "time-timers.discard": CONFIRM_DESTROYS_DATA,
  "time-timers.list": OPEN_READ,
  "time-timers.pause": CONFIRM_WRITES_CONTENT,
  "time-timers.resume": CONFIRM_WRITES_CONTENT,
  "time-timers.start": CONFIRM_WRITES_CONTENT,
  "time-timers.update": CONFIRM_WRITES_CONTENT,
  "uploads.create": OPEN_EDITS_CONTENT,
  "uploads.delete": CONFIRM_DESTROYS_DATA,
  "uploads.update": OPEN_EDITS_CONTENT,
  "usage.entitlement.get": OPEN_READ,
  "vat-rates.archive": APPROVE_ORGANIZATION_SETTINGS,
  "vat-rates.create": APPROVE_ORGANIZATION_SETTINGS,
  "vat-rates.list": OPEN_READ,
  "vat-rates.presets.create": APPROVE_ORGANIZATION_SETTINGS,
  "vat-rates.update": APPROVE_ORGANIZATION_SETTINGS,
  "view-templates.create": OPEN_EDITS_CONTENT,
  "view-templates.delete": CONFIRM_DESTROYS_DATA,
  "view-templates.list": OPEN_READ,
  "views.convert": OPEN_EDITS_CONTENT,
  "views.create": OPEN_EDITS_CONTENT,
  "views.delete": CONFIRM_DESTROYS_DATA,
  "views.list": OPEN_READ,
  "views.reorder": OPEN_EDITS_CONTENT,
  "views.table.export": APPROVE_OUTBOUND,
  "views.update": OPEN_EDITS_CONTENT,
  "work-obligations.acknowledgements.create": APPROVE_WRITES_CONTENT,
  "work-obligations.queues.list": OPEN_READ,
  "work-obligations.transition": APPROVE_WRITES_CONTENT,
  "work-obligations.update": OPEN_EDITS_CONTENT,
} as const satisfies Record<CatalogCapabilityId, AgentAccess>;

const isWriteToolName = (name: string): name is McpWriteToolName =>
  Object.hasOwn(WRITE_TOOL_AGENT_ACCESS, name);

const isCatalogCapabilityId = (id: string): id is CatalogCapabilityId =>
  Object.hasOwn(CAPABILITY_AGENT_ACCESS, id);

export const AGENT_ACCESS_TARGET = {
  tool: "tool",
  capability: "capability",
} as const;

export type AgentAccessTarget =
  | {
      type: typeof AGENT_ACCESS_TARGET.tool;
      name: string;
      access: McpToolAccess;
    }
  | { type: typeof AGENT_ACCESS_TARGET.capability; id: string };

type AgentAccessContext = Pick<McpRequestContext, "toolConfirmation">;

const staticAgentAccess = (target: AgentAccessTarget): ToolAgentAccess => {
  switch (target.type) {
    case AGENT_ACCESS_TARGET.tool: {
      if (target.access === "read") {
        return OPEN_READ;
      }
      return isWriteToolName(target.name)
        ? WRITE_TOOL_AGENT_ACCESS[target.name]
        : panic(`Write tool ${target.name} has no agent access`);
    }
    case AGENT_ACCESS_TARGET.capability:
      return isCatalogCapabilityId(target.id)
        ? CAPABILITY_AGENT_ACCESS[target.id]
        : panic(`Capability ${target.id} has no agent access`);
    default:
      target satisfies never;
      return panic("Unhandled agent access target");
  }
};

/**
 * The one computation of a target's effective access for a caller. A session
 * with no person at the tool boundary (an agent run) cannot relay a
 * confirmation, so a `caller-confirms` operation becomes `person-approves`
 * for it: the run hands the step back to the user.
 */
const effectiveAgentAccess = (
  target: AgentAccessTarget,
  context: AgentAccessContext,
): ToolAgentAccess => {
  const floor = staticAgentAccess(target);
  if (
    floor.kind === AGENT_ACCESS_KIND.callerConfirms &&
    context.toolConfirmation === TOOL_CONFIRMATION.unavailable
  ) {
    return { kind: AGENT_ACCESS_KIND.personApproves, reason: floor.reason };
  }
  return floor;
};

/**
 * Where the call arrives. `chat` is stella's own chat, whose approval step
 * already asked the person for every mutation; `mcp` is any MCP or CLI client.
 */
export const AGENT_CALL_SURFACE = {
  chat: "chat",
  mcp: "mcp",
} as const;

type AgentCallSurface =
  (typeof AGENT_CALL_SURFACE)[keyof typeof AGENT_CALL_SURFACE];

export type AgentCallRefusal = {
  code: "confirmation_required" | "person_approval_required" | "person_only";
  message: string;
  hint: string;
};

export type AgentCallDecision =
  /** `confirmed`: the call runs on a person's relayed approval; audit it so. */
  | { type: "allow"; approval: "none" | "confirmed" }
  | { type: "refuse"; refusal: AgentCallRefusal };

/**
 * A refusal no confirmation can lift. A missing confirmation is not one: it is
 * reported only once the call's references resolve, so it never answers for a
 * resource the caller cannot see.
 */
export const finalAgentRefusal = (
  decision: AgentCallDecision,
): AgentCallRefusal | null =>
  decision.type === "refuse" &&
  decision.refusal.code !== "confirmation_required"
    ? decision.refusal
    : null;

const ALLOW = { type: "allow", approval: "none" } as const;

const confirmationRefusal = (
  access: Extract<AgentAccess, { kind: "caller-confirms" }>,
  subject: string,
): AgentCallRefusal => {
  switch (access.reason) {
    case "writes-content":
      return {
        code: "confirmation_required",
        message: `${subject} changes stored content and was called without confirmation`,
        hint: "Ask the human user to confirm this change, then retry with confirm: true.",
      };
    case "destroys-data":
      return {
        code: "confirmation_required",
        message: `${subject} is an irreversible operation and was called without confirmation`,
        hint: "This operation is irreversible. Confirm with the human user, then retry with confirm: true.",
      };
    case "outbound":
      return {
        code: "confirmation_required",
        message: `${subject} sends data outside this workspace and was called without confirmation`,
        hint: `${access.sends} Show the human user exactly what will be sent, get their approval, then retry with confirm: true.`,
      };
    default:
      access satisfies never;
      return panic("Unhandled confirmation reason");
  }
};

/**
 * Whether one agent call may run. `subject` names the operation in the
 * refusal; `confirmed` is the call's `confirm` argument.
 */
export const decideAgentCall = ({
  target,
  context,
  surface,
  subject,
  confirmed,
}: {
  target: AgentAccessTarget;
  context: AgentAccessContext;
  surface: AgentCallSurface;
  subject: string;
  confirmed: boolean;
}): AgentCallDecision => {
  const access = effectiveAgentAccess(target, context);
  switch (access.kind) {
    case AGENT_ACCESS_KIND.open:
    case "per-capability":
      return ALLOW;
    case AGENT_ACCESS_KIND.callerConfirms:
      if (surface === AGENT_CALL_SURFACE.chat || confirmed) {
        return { type: "allow", approval: "confirmed" };
      }
      return { type: "refuse", refusal: confirmationRefusal(access, subject) };
    case AGENT_ACCESS_KIND.personApproves:
      return surface === AGENT_CALL_SURFACE.chat
        ? { type: "allow", approval: "confirmed" }
        : {
            type: "refuse",
            refusal: {
              code: "person_approval_required",
              message: `${subject} needs a person's approval in stella and cannot run from this client`,
              hint: "Do not retry it. Describe the change in your reply so the user can make or approve it in stella.",
            },
          };
    case AGENT_ACCESS_KIND.personOnly:
      return {
        type: "refuse",
        refusal: {
          code: "person_only",
          message: `Only a person can run ${subject}; agent calls are always refused`,
          hint: `Do not retry it. Tell the user they can do it in ${PERSON_ONLY_LOCATIONS[access.where]}.`,
        },
      };
    default:
      access satisfies never;
      return panic("Unhandled agent access kind");
  }
};

type AgentAccessDescription = {
  access: ToolAgentAccess;
  /**
   * The sentence an agent-facing listing appends to the operation's
   * description, or null when agents run it unchanged. Listings keep
   * `person-approves` and `person-only` operations visible so a model can
   * point the user to them.
   */
  note: string | null;
};

const agentAccessNote = (access: ToolAgentAccess): string | null => {
  switch (access.kind) {
    case AGENT_ACCESS_KIND.open:
    case AGENT_ACCESS_KIND.callerConfirms:
    case "per-capability":
      return null;
    case AGENT_ACCESS_KIND.personApproves:
      return "Needs a person's approval in stella: MCP and CLI calls are refused, so describe the change for the user instead.";
    case AGENT_ACCESS_KIND.personOnly:
      return `Only a person can do this, in ${PERSON_ONLY_LOCATIONS[access.where]}; agent calls are always refused.`;
    default:
      access satisfies never;
      return panic("Unhandled agent access kind");
  }
};

/** How agents see an operation: for listings and generated clients. */
export const describeAgentAccess = ({
  target,
  context,
}: {
  target: AgentAccessTarget;
  context: AgentAccessContext;
}): AgentAccessDescription => {
  const access = effectiveAgentAccess(target, context);
  return { access, note: agentAccessNote(access) };
};

/**
 * An operation's description as agents read it: its agent-access sentence
 * appended when it has one. Live listings and generated clients share it, so
 * neither can advertise an operation the server refuses.
 */
export const describeForAgents = ({
  target,
  context,
  description,
}: {
  target: AgentAccessTarget;
  context: AgentAccessContext;
  description: string;
}): string => {
  const { note } = describeAgentAccess({ target, context });
  return note === null ? description : `${description} ${note}`;
};
