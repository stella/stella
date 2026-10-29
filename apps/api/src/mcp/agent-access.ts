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

export type AgentAccess =
  | { kind: typeof AGENT_ACCESS_KIND.open }
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

const OPEN = { kind: AGENT_ACCESS_KIND.open } as const satisfies AgentAccess;
const CONFIRM_DESTROYS_DATA = {
  kind: AGENT_ACCESS_KIND.callerConfirms,
  reason: "destroys-data",
} as const satisfies AgentAccess;
const CONFIRM_WRITES_CONTENT = {
  kind: AGENT_ACCESS_KIND.callerConfirms,
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
  save_matter: OPEN,
  delete_matter: PERSON_ONLY_DELETES_MATTER,
  save_contact: OPEN,
  delete_contact: CONFIRM_DESTROYS_DATA,
  save_task: OPEN,
  delete_task: CONFIRM_DESTROYS_DATA,
  link_matter_contact: OPEN,
  save_document: OPEN,
  upload_document_version: OPEN,
  open_document_version_upload: OPEN,
  delete_document: APPROVE_DESTROYS_DATA,
  compare_documents: OPEN,
  prepare_file_comparison: OPEN,
  prepare_file_comparison_from_links: OPEN,
  open_file_comparison: OPEN,
  set_field_value: OPEN,
  save_time_entry: OPEN,
  delete_time_entry: CONFIRM_DESTROYS_DATA,
  save_clause: OPEN,
  save_playbook: OPEN,
  delete_clause: CONFIRM_DESTROYS_DATA,
  run_playbook: OPEN,
  create_reader_annotation: OPEN,
  update_reader_annotation: OPEN,
  delete_reader_annotation: CONFIRM_DESTROYS_DATA,
  add_matter_member: APPROVE_GRANTS_ACCESS,
  remove_matter_member: APPROVE_REVOKES_ACCESS,
  update_organization_settings: APPROVE_ORGANIZATION_SETTINGS,
  set_practice_jurisdictions: APPROVE_ORGANIZATION_SETTINGS,
  fill_template: OPEN,
  save_filled_template: OPEN,
  create_template: OPEN,
  configure_template_fields: OPEN,
  mint_web_handoff: OPEN,
  [MCP_CAPABILITY_EXECUTORS.write]: PER_CAPABILITY,
  submit_feedback: {
    kind: AGENT_ACCESS_KIND.callerConfirms,
    reason: "outbound",
    sends:
      "submit_feedback sends this report to the stella maintainers and may publish it as an issue.",
  },
} as const satisfies Record<McpWriteToolName, ToolAgentAccess>;

type CatalogCapabilityId = keyof typeof CAPABILITY_DISPATCH;

/**
 * Every catalog capability, keyed by the generated dispatch ids so a new
 * capability fails typecheck until it is classified. Reads are `open`; the
 * agent-access suite pins that, and that no destructive capability is `open`.
 */
const CAPABILITY_AGENT_ACCESS = {
  "tasks.list": OPEN,
  "client-invoices.create": OPEN,
  "client-invoices.prefill": OPEN,
  "invoices.payments.create": OPEN,
  "invoices.payments.list": OPEN,
  "invoices.payments.void": CONFIRM_DESTROYS_DATA,
  "time-entries.me.submissions.create": OPEN,
  "time-entries.me.suggestions.list": OPEN,
  "audit-logs.list": OPEN,
  "billing-codes.create": OPEN,
  "billing-codes.delete": CONFIRM_DESTROYS_DATA,
  "billing-codes.list": OPEN,
  "billing-codes.update": OPEN,
  "case-law.analysis.generate": OPEN,
  "case-law.ingestion.get": OPEN,
  "case-law.matter-links.batch.create": OPEN,
  "case-law.matter-links.create": OPEN,
  "case-law.matter-links.delete": CONFIRM_DESTROYS_DATA,
  "case-law.matter-links.list": OPEN,
  "catalogue.install": OPEN,
  "catalogue.list": OPEN,
  "chat.decision-threads.get": OPEN,
  "chat.export.create": OPEN,
  "chat.fork.create": OPEN,
  "chat.messages.list": OPEN,
  "chat.messages.revisions.list": OPEN,
  "chat.older-messages.list": OPEN,
  "chat.threads.delete": CONFIRM_DESTROYS_DATA,
  "chat.threads.list": OPEN,
  "chat.threads.rename": OPEN,
  "chat.threads.update": OPEN,
  "clauses.categories.create": OPEN,
  "clauses.categories.delete": CONFIRM_DESTROYS_DATA,
  "clauses.categories.list": OPEN,
  "clauses.categories.update": OPEN,
  "clauses.create": OPEN,
  "clauses.delete": CONFIRM_DESTROYS_DATA,
  "clauses.export": OPEN,
  "clauses.get": OPEN,
  "clauses.import": OPEN,
  "clauses.list": OPEN,
  "clauses.rewrite": OPEN,
  "clauses.template-slots.preview": OPEN,
  "clauses.update": OPEN,
  "clauses.variants.create": OPEN,
  "clauses.variants.delete": CONFIRM_DESTROYS_DATA,
  "clauses.variants.list": OPEN,
  "clauses.variants.update": OPEN,
  "clauses.versions.diff": OPEN,
  "clauses.versions.get": OPEN,
  "clauses.versions.restore": OPEN,
  "clauses.versions.summarize": OPEN,
  "contacts.business-registries.check": OPEN,
  "contacts.business-registries.lookup": OPEN,
  "contacts.create": OPEN,
  "contacts.delete": CONFIRM_DESTROYS_DATA,
  "contacts.export": OPEN,
  "contacts.get": OPEN,
  "contacts.import": OPEN,
  "contacts.list": OPEN,
  "contacts.sanctions.events.list": OPEN,
  "contacts.sanctions.get": OPEN,
  "contacts.sanctions.matches.list": OPEN,
  "contacts.sanctions.monitoring.update": OPEN,
  "contacts.sanctions.reviews.update": OPEN,
  "contacts.search": OPEN,
  "contacts.update": OPEN,
  "document-translations.prepare": OPEN,
  "document-translations.runs.create": OPEN,
  "document-translations.runs.get": OPEN,
  "document-types.create": OPEN,
  "document-types.delete": CONFIRM_DESTROYS_DATA,
  "document-types.list": OPEN,
  "document-types.reorder": OPEN,
  "document-types.update": OPEN,
  "documents.compare": OPEN,
  "docx-suggestions.list": OPEN,
  "docx-suggestions.resolve": CONFIRM_WRITES_CONTENT,
  "docx-suggestions.revert": CONFIRM_WRITES_CONTENT,
  "entities.bilingual.create": OPEN,
  "entities.blank-document.create": OPEN,
  "entities.clip": OPEN,
  "entities.copy": CONFIRM_DESTROYS_DATA,
  "entities.create": OPEN,
  "entities.delete": APPROVE_DESTROYS_DATA,
  "entities.duplicate": OPEN,
  "entities.files.list": OPEN,
  "entities.filesystem-tree.get": OPEN,
  "entities.folder-from-selection.create": OPEN,
  "entities.folders.list": OPEN,
  "entities.from-legal-source.create": OPEN,
  "entities.get": OPEN,
  "entities.list": OPEN,
  "entities.move": OPEN,
  "entities.ocr.create": OPEN,
  "entities.placements.suggest": OPEN,
  "entities.rename": OPEN,
  "entities.stamps.check": OPEN,
  "entities.summaries.count": OPEN,
  "entities.summaries.list": OPEN,
  "entities.upload": OPEN,
  "entities.versions.delete": CONFIRM_DESTROYS_DATA,
  "entities.versions.description.update": OPEN,
  "entities.versions.diff": OPEN,
  "entities.versions.get": OPEN,
  "entities.versions.label.update": OPEN,
  "entities.versions.list": OPEN,
  "entities.versions.restore": OPEN,
  "entities.versions.summarize": OPEN,
  "entities.versions.upload": OPEN,
  "entities.window.list": OPEN,
  "entities.zip.download": OPEN,
  "entity-views.create": OPEN,
  "entity-views.delete": CONFIRM_DESTROYS_DATA,
  "entity-views.list": OPEN,
  "entity-views.reorder": OPEN,
  "entity-views.rows.list": OPEN,
  "entity-views.update": OPEN,
  "expenses.create": OPEN,
  "expenses.delete": CONFIRM_DESTROYS_DATA,
  "expenses.list": OPEN,
  "expenses.update": OPEN,
  "fields.cell-metadata.update": OPEN,
  "fields.column-flag.update": OPEN,
  "fields.kanban-placement.update": OPEN,
  "fields.upsert": OPEN,
  "flows.create": OPEN,
  "flows.delete": CONFIRM_DESTROYS_DATA,
  "flows.get": OPEN,
  "flows.list": OPEN,
  "flows.runs.cancel": OPEN,
  "flows.runs.get": OPEN,
  "flows.runs.list": OPEN,
  "flows.runs.review": OPEN,
  "flows.runs.start": OPEN,
  "flows.update": OPEN,
  "invoices.create": OPEN,
  "invoices.delete": CONFIRM_DESTROYS_DATA,
  "invoices.entries.add": OPEN,
  "invoices.entries.remove": OPEN,
  "invoices.export": OPEN,
  "invoices.get": OPEN,
  "invoices.lines.create": OPEN,
  "invoices.lines.delete": CONFIRM_DESTROYS_DATA,
  "invoices.lines.update": OPEN,
  "invoices.list": OPEN,
  "invoices.pdf.export": OPEN,
  "invoices.prefill": OPEN,
  "invoices.transition": OPEN,
  "invoices.update": OPEN,
  "legal-reader.annotations.create": OPEN,
  "legal-reader.annotations.delete": CONFIRM_DESTROYS_DATA,
  "legal-reader.annotations.list": OPEN,
  "legal-reader.annotations.update": OPEN,
  "legislation.boe.law-structure.get": OPEN,
  "legislation.boe.laws.get": OPEN,
  "legislation.boe.related-laws.list": OPEN,
  "legislation.boe.search": OPEN,
  "legislation.boe.text-block.get": OPEN,
  "legislation.borme.summary.get": OPEN,
  "legislation.get": OPEN,
  "legislation.search": OPEN,
  "lists.columns.create": OPEN,
  "lists.create": OPEN,
  "lists.generation-candidates.acceptance.create": OPEN,
  "lists.generation-candidates.create": OPEN,
  "lists.generation-candidates.list": OPEN,
  "lists.generation-candidates.rejection.create": OPEN,
  "lists.generations.create": OPEN,
  "lists.generations.list": OPEN,
  "lists.get": OPEN,
  "lists.items.activity.list": OPEN,
  "lists.items.comments.create": OPEN,
  "lists.items.fact-details.update": OPEN,
  "lists.items.list": OPEN,
  "lists.items.reviews.update": OPEN,
  "lists.items.sources.create": OPEN,
  "lists.items.sources.list": OPEN,
  "lists.items.sources.verification.update": OPEN,
  "lists.items.update": OPEN,
  "lists.list": OPEN,
  "lists.sample-case.create": OPEN,
  "lists.sections.create": OPEN,
  "lists.update": OPEN,
  "lists.verifications.claim-comments.create": OPEN,
  "lists.verifications.claim-comments.delete": CONFIRM_DESTROYS_DATA,
  "lists.verifications.claim-comments.list": OPEN,
  "lists.verifications.claim-comments.update": OPEN,
  "lists.verifications.claim-reviews.bulk.create": OPEN,
  "lists.verifications.claim-reviews.create": OPEN,
  "lists.verifications.create": OPEN,
  "lists.verifications.get": OPEN,
  "lists.verifications.latest.list": OPEN,
  "lists.verifications.list": OPEN,
  "matters.anonymization-allowlist.create": OPEN,
  "matters.anonymization-allowlist.delete": CONFIRM_DESTROYS_DATA,
  "matters.anonymization-allowlist.list": OPEN,
  "matters.anonymization-terms.create": OPEN,
  "matters.anonymization-terms.delete": CONFIRM_DESTROYS_DATA,
  "matters.anonymization-terms.list": OPEN,
  "matters.archive": OPEN,
  "matters.cells.retry": OPEN,
  "matters.contacts.create": OPEN,
  "matters.contacts.delete": CONFIRM_DESTROYS_DATA,
  "matters.correspondence.get": OPEN,
  "matters.correspondence.list": OPEN,
  "matters.correspondence.update": OPEN,
  "matters.create": OPEN,
  "matters.delete": PERSON_ONLY_DELETES_MATTER,
  "matters.duplicate": OPEN,
  "matters.justifications.list": OPEN,
  "matters.list": OPEN,
  "matters.members.add": APPROVE_GRANTS_ACCESS,
  "matters.members.remove": APPROVE_REVOKES_ACCESS,
  "matters.search-preview.get": OPEN,
  "matters.unarchive": OPEN,
  "matters.update": OPEN,
  "matters.workflow.get": OPEN,
  "matters.workflow.start": OPEN,
  "matters.workflow.targets.count": OPEN,
  "memories.create": CONFIRM_WRITES_CONTENT,
  "memories.list": OPEN,
  "memories.update": CONFIRM_WRITES_CONTENT,
  "notifications.list": OPEN,
  "notifications.read-state.update": OPEN,
  "number-series.archive": OPEN,
  "number-series.create": OPEN,
  "number-series.default.update": OPEN,
  "number-series.get": OPEN,
  "number-series.list": OPEN,
  "number-series.preview": OPEN,
  "number-series.update": OPEN,
  "organization-settings.ai-availability.get": OPEN,
  "organization-settings.anonymization-blacklist.get": OPEN,
  "organization-settings.anonymization-blacklist.update":
    APPROVE_ORGANIZATION_SETTINGS,
  "organization-settings.correspondence.allowed-senders.create":
    APPROVE_ORGANIZATION_SETTINGS,
  "organization-settings.correspondence.allowed-senders.delete":
    APPROVE_ORGANIZATION_SETTINGS,
  // A read: the catalog files it under write because only a settings
  // administrator (`organizationSettings: update`) may list the senders.
  "organization-settings.correspondence.allowed-senders.list": OPEN,
  "organization-settings.correspondence.allowed-senders.scope.add":
    APPROVE_ORGANIZATION_SETTINGS,
  "organization-settings.correspondence.allowed-senders.scope.remove":
    APPROVE_ORGANIZATION_SETTINGS,
  "organization-settings.deepl-availability.get": OPEN,
  "organization-settings.document-ocr-availability.get": OPEN,
  "organization-settings.get": OPEN,
  "organization-settings.practice-jurisdictions.update":
    APPROVE_ORGANIZATION_SETTINGS,
  "organization-settings.preview": OPEN,
  "organization-settings.sanctions-monitoring.update":
    APPROVE_ORGANIZATION_SETTINGS,
  "organization-settings.update": APPROVE_ORGANIZATION_SETTINGS,
  "playbooks.applicable.run": OPEN,
  "playbooks.approve": OPEN,
  "playbooks.create": OPEN,
  "playbooks.delete": CONFIRM_DESTROYS_DATA,
  "playbooks.from-run.create": OPEN,
  "playbooks.from-starter.create": OPEN,
  "playbooks.get": OPEN,
  "playbooks.list": OPEN,
  "playbooks.recent.list": OPEN,
  "playbooks.run": OPEN,
  "playbooks.starters.list": OPEN,
  "playbooks.update": OPEN,
  "playbooks.versions.list": OPEN,
  "playbooks.versions.restore": OPEN,
  "properties.batch.create": OPEN,
  "properties.create": OPEN,
  "properties.delete": CONFIRM_DESTROYS_DATA,
  "properties.list": OPEN,
  "properties.preview": OPEN,
  "properties.prompt.suggest": OPEN,
  "properties.update": OPEN,
  "rates.arrangement.get": OPEN,
  "rates.arrangement.summary.get": OPEN,
  "rates.arrangement.update": OPEN,
  "rates.create": OPEN,
  "rates.delete": CONFIRM_DESTROYS_DATA,
  "rates.entries.create": OPEN,
  "rates.entries.delete": CONFIRM_DESTROYS_DATA,
  "rates.entries.list": OPEN,
  "rates.entries.update": OPEN,
  "rates.list": OPEN,
  "rates.resolve": OPEN,
  "rates.update": OPEN,
  "reports.builtins.clone": OPEN,
  "reports.exports.get": OPEN,
  "reports.exports.list": OPEN,
  "reports.templates.list": OPEN,
  "reports.views.export": OPEN,
  "saved-time-narratives.create": OPEN,
  "saved-time-narratives.delete": CONFIRM_DESTROYS_DATA,
  "saved-time-narratives.list": OPEN,
  "saved-time-narratives.update": OPEN,
  "search-history.clear": CONFIRM_DESTROYS_DATA,
  "search-history.delete": CONFIRM_DESTROYS_DATA,
  "search-history.list": OPEN,
  "seller-profiles.archive": OPEN,
  "seller-profiles.create": OPEN,
  "seller-profiles.default.update": OPEN,
  "seller-profiles.get": OPEN,
  "seller-profiles.list": OPEN,
  "seller-profiles.update": OPEN,
  "signals.acceptances.create": OPEN,
  "signals.assignments.create": OPEN,
  "signals.dismissals.create": OPEN,
  "signals.get": OPEN,
  "signals.list": OPEN,
  "signals.requests.create": OPEN,
  "signals.snoozes.create": OPEN,
  "skills.commands.list": OPEN,
  "skills.comments.create": OPEN,
  "skills.comments.delete": CONFIRM_DESTROYS_DATA,
  "skills.comments.list": OPEN,
  "skills.comments.update": OPEN,
  "skills.create": OPEN,
  "skills.delete": CONFIRM_DESTROYS_DATA,
  "skills.discover": OPEN,
  "skills.drafts.generate": OPEN,
  "skills.from-blueprint.create": OPEN,
  "skills.from-url.import": OPEN,
  "skills.get": OPEN,
  "skills.import": OPEN,
  "skills.list": OPEN,
  "skills.proposals.create": OPEN,
  "skills.proposals.delete": CONFIRM_DESTROYS_DATA,
  "skills.proposals.from-comments.create": OPEN,
  "skills.proposals.get": OPEN,
  "skills.proposals.list": OPEN,
  "skills.proposals.review": OPEN,
  "skills.proposals.update": OPEN,
  "skills.resources.create": OPEN,
  "skills.resources.delete": CONFIRM_DESTROYS_DATA,
  "skills.resources.rename": OPEN,
  "skills.resources.rewrite": OPEN,
  "skills.resources.update": OPEN,
  "skills.resources.upload": OPEN,
  "skills.revisions.get": OPEN,
  "skills.revisions.list": OPEN,
  "skills.update": OPEN,
  "skills.upload": OPEN,
  "style-sets.create": OPEN,
  "style-sets.delete": CONFIRM_DESTROYS_DATA,
  "style-sets.download": OPEN,
  "style-sets.editor.get": OPEN,
  "style-sets.from-editor.create": OPEN,
  "style-sets.from-editor.update": OPEN,
  "style-sets.list": OPEN,
  "style-sets.replace": OPEN,
  "style-sets.stella-editor.get": OPEN,
  "style-sets.update": OPEN,
  "tasks.assignees.add": OPEN,
  "tasks.assignees.move": OPEN,
  "tasks.assignees.remove": CONFIRM_DESTROYS_DATA,
  "tasks.calendar.list": OPEN,
  "tasks.create": OPEN,
  "tasks.entity-links.create": OPEN,
  "tasks.entity-links.delete": CONFIRM_DESTROYS_DATA,
  "tasks.entity-links.list": OPEN,
  "tasks.get": OPEN,
  "tasks.update": OPEN,
  "template-packs.get": OPEN,
  "template-packs.installs.create": OPEN,
  "template-packs.list": OPEN,
  "template-packs.visibility.update": OPEN,
  "template-recipes.create": OPEN,
  "template-recipes.delete": CONFIRM_DESTROYS_DATA,
  "template-recipes.list": OPEN,
  "templates.bindings.list": OPEN,
  "templates.blank.create": OPEN,
  "templates.categories.create": OPEN,
  "templates.categories.delete": CONFIRM_DESTROYS_DATA,
  "templates.categories.list": OPEN,
  "templates.categories.update": OPEN,
  "templates.check": OPEN,
  "templates.clause-slots.list": OPEN,
  "templates.clause-slots.update": OPEN,
  "templates.clauses.link": OPEN,
  "templates.clauses.list": OPEN,
  "templates.clauses.sync": OPEN,
  "templates.clauses.unlink": OPEN,
  "templates.condition-decisions.get": OPEN,
  "templates.create": OPEN,
  "templates.delete": CONFIRM_DESTROYS_DATA,
  "templates.discover": OPEN,
  "templates.document.update": OPEN,
  "templates.fields.suggest": OPEN,
  "templates.fill": OPEN,
  "templates.fills.create": OPEN,
  "templates.fills.download": OPEN,
  "templates.fills.preview": OPEN,
  "templates.from-style-set.create": OPEN,
  "templates.from-styles.create": OPEN,
  "templates.get": OPEN,
  "templates.list": OPEN,
  "templates.lookup-formats.create": OPEN,
  "templates.lookup-formats.default.update": OPEN,
  "templates.lookup-formats.delete": CONFIRM_DESTROYS_DATA,
  "templates.lookup-formats.list": OPEN,
  "templates.lookup-formats.my-default.update": OPEN,
  "templates.lookups.preview": OPEN,
  "templates.outdated-clauses.sync": OPEN,
  "templates.prefill": OPEN,
  "templates.prepare": OPEN,
  "templates.preview": OPEN,
  "templates.update": OPEN,
  "templates.versions.diff": OPEN,
  "templates.versions.get": OPEN,
  "templates.versions.list": OPEN,
  "templates.versions.summarize": OPEN,
  "time-entries.approval-queue.approve": OPEN,
  "time-entries.approval-queue.list": OPEN,
  "time-entries.approval-queue.return": OPEN,
  "time-entries.batch.delete": CONFIRM_DESTROYS_DATA,
  "time-entries.batch.update": OPEN,
  "time-entries.create": OPEN,
  "time-entries.csv.export": OPEN,
  "time-entries.delete": CONFIRM_DESTROYS_DATA,
  "time-entries.get": OPEN,
  "time-entries.internal.create": OPEN,
  "time-entries.ledes.export": OPEN,
  "time-entries.list": OPEN,
  "time-entries.me.daily-target.update": OPEN,
  "time-entries.me.list": OPEN,
  "time-entries.members.daily-target.update": OPEN,
  "time-entries.pdf.export": OPEN,
  "time-entries.split": OPEN,
  "time-entries.suggestions.decisions.create": OPEN,
  "time-entries.suggestions.list": OPEN,
  "time-entries.summary.get": OPEN,
  "time-entries.update": OPEN,
  "time-timers.admin.list": OPEN,
  "time-timers.admin.stop": OPEN,
  "time-timers.confirm": OPEN,
  "time-timers.discard": CONFIRM_DESTROYS_DATA,
  "time-timers.list": OPEN,
  "time-timers.pause": OPEN,
  "time-timers.resume": OPEN,
  "time-timers.start": OPEN,
  "time-timers.update": OPEN,
  "uploads.create": OPEN,
  "uploads.delete": CONFIRM_DESTROYS_DATA,
  "uploads.update": OPEN,
  "usage.entitlement.get": OPEN,
  "vat-rates.archive": OPEN,
  "vat-rates.create": OPEN,
  "vat-rates.list": OPEN,
  "vat-rates.presets.create": OPEN,
  "vat-rates.update": OPEN,
  "view-templates.create": OPEN,
  "view-templates.delete": CONFIRM_DESTROYS_DATA,
  "view-templates.list": OPEN,
  "views.convert": OPEN,
  "views.create": OPEN,
  "views.delete": CONFIRM_DESTROYS_DATA,
  "views.list": OPEN,
  "views.reorder": OPEN,
  "views.table.export": OPEN,
  "views.update": OPEN,
  "work-obligations.acknowledgements.create": OPEN,
  "work-obligations.queues.list": OPEN,
  "work-obligations.transition": OPEN,
  "work-obligations.update": OPEN,
} as const satisfies Record<CatalogCapabilityId, AgentAccess>;

const isWriteToolName = (name: string): name is McpWriteToolName =>
  Object.hasOwn(WRITE_TOOL_AGENT_ACCESS, name);

const isCatalogCapabilityId = (id: string): id is CatalogCapabilityId =>
  Object.hasOwn(CAPABILITY_AGENT_ACCESS, id);

export type AgentAccessTarget =
  | { type: "tool"; name: string; access: McpToolAccess }
  | { type: "capability"; id: string };

type AgentAccessContext = Pick<McpRequestContext, "toolConfirmation">;

const staticAgentAccess = (target: AgentAccessTarget): ToolAgentAccess => {
  switch (target.type) {
    case "tool": {
      if (target.access === "read") {
        return OPEN;
      }
      return isWriteToolName(target.name)
        ? WRITE_TOOL_AGENT_ACCESS[target.name]
        : panic(`Write tool ${target.name} has no agent access`);
    }
    case "capability":
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
