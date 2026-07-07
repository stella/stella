// The baked-in Annotation Table (spec 051 S1), keyed by tool name. Everything
// the CLI needs beyond the four `tools/list` wire fields lives here: the
// command path, the client-side scope for the precheck, the list `itemsKey`,
// single-read flip props, windowed-text/paginationless markers, and the
// `manage_organization` discriminator split. Encoded as plain data so both the
// build-time codegen and (later) a runtime path can import it.
//
// `scope` is the UNPREFIXED form from `route-types.ts`; the scope precheck
// prefixes it with `stella:` before comparing against the decoded token.

import type { ToolAnnotation } from "./route-types.js";

/** Reserved top-level command names a generated domain may never take (spec S1). */
export const RESERVED_TOP_LEVEL_NAMES: ReadonlySet<string> = new Set([
  "auth",
  "tools",
  "reference",
  "help",
  "version",
  "completion",
  "config",
]);

/** Reserved global flags a generated per-tool flag may never collide with (spec S1). */
export const RESERVED_FLAGS: ReadonlySet<string> = new Set([
  "--output",
  "--json",
  "--table",
  "--input",
  "--yes",
  "-y",
  "--all",
  "--cursor",
  "--limit",
  "--org",
  "--no-keychain",
  "--server",
  "--help",
  "-h",
  "--version",
]);

export const TOOL_ANNOTATIONS: Readonly<Record<string, ToolAnnotation>> = {
  // --- compat shims: excluded from the tree entirely (spec S1) ---
  search: { command: ["search"], excluded: true, scope: "search" },
  fetch: { command: ["fetch"], excluded: true, scope: "read" },

  // --- matter domain ---
  save_matter: { command: ["matter", "save"], scope: "matters_write" },
  delete_matter: { command: ["matter", "delete"], scope: "matters_write" },
  list_matters: {
    command: ["matter", "list"],
    scope: "read",
    itemsKey: "matters",
    singleReadWhen: "matter_id",
  },
  link_matter_contact: {
    command: ["matter", "link-contact"],
    scope: "matters_write",
  },

  // --- contact domain ---
  save_contact: { command: ["contact", "save"], scope: "matters_write" },
  delete_contact: { command: ["contact", "delete"], scope: "matters_write" },
  read_contact: { command: ["contact", "read"], scope: "read" },
  lookup_business_registry: {
    command: ["contact", "lookup-registry"],
    scope: "read",
  },

  // --- task domain ---
  list_tasks: {
    command: ["task", "list"],
    scope: "read",
    itemsKey: "tasks",
    singleReadWhen: "task_id",
  },
  save_task: { command: ["task", "save"], scope: "matters_write" },

  // --- document domain ---
  list_documents: {
    command: ["document", "list"],
    scope: "read",
    itemsKey: "documents",
  },
  read_document: { command: ["document", "read"], scope: "read" },
  save_document: { command: ["document", "save"], scope: "documents_write" },
  delete_document: {
    command: ["document", "delete"],
    scope: "documents_write",
  },
  list_properties: {
    command: ["document", "properties", "list"],
    scope: "read",
    itemsKey: "properties",
  },
  set_field_value: {
    command: ["document", "field", "set"],
    scope: "documents_write",
  },

  // --- knowledge domain ---
  list_clauses: {
    command: ["clause", "list"],
    scope: "read",
    // Registry payload key is `clauses` (spec table says `items`; registry wins).
    itemsKey: "clauses",
    singleReadWhen: "clause_id",
  },
  save_clause: { command: ["clause", "save"], scope: "knowledge_write" },
  delete_clause: { command: ["clause", "delete"], scope: "knowledge_write" },
  list_playbooks: {
    command: ["playbook", "list"],
    scope: "read",
    itemsKey: "items",
    singleReadWhen: "playbook_id",
  },
  run_playbook: { command: ["playbook", "run"], scope: "knowledge_write" },

  // --- cross-matter search / read ---
  search_across_matters: {
    command: ["search", "matters"],
    scope: "search",
    itemsKey: "hits",
  },
  read_content_across_matters: {
    command: ["search", "read"],
    scope: "read",
    windowedText: true,
  },
  search_case_law: {
    command: ["case-law", "search"],
    scope: "search",
    itemsKey: "results",
  },
  read_case_law_decision: {
    command: ["case-law", "read"],
    scope: "read",
    windowedText: true,
  },

  // --- feedback ---
  // send_feedback carries a two-phase handshake for the email/stella channels;
  // the CLI keeps it generic (no per-tool special-casing): the phase-1
  // `approval_required` response renders as a single object showing
  // `confirmation_token` and `next_step`, and the runtime prints a re-run hint
  // driven off the response `status` field.
  send_feedback: { command: ["feedback", "send"], scope: "feedback" },

  // --- organization onboarding ---
  set_practice_jurisdictions: {
    command: ["organization", "set-jurisdictions"],
    scope: "onboarding",
  },

  // --- templates ---
  list_templates: {
    command: ["template", "list"],
    scope: "templates",
    itemsKey: "templates",
    paginationless: true,
    singleReadWhen: "template_id",
  },
  fill_template: { command: ["template", "fill"], scope: "templates" },
  save_template: { command: ["template", "save"], scope: "templates" },

  // --- billing ---
  list_time_entries: {
    command: ["time-entry", "list"],
    scope: "read",
    itemsKey: "entries",
    singleReadWhen: "time_entry_id",
  },
  save_time_entry: {
    command: ["time-entry", "save"],
    scope: "billing_write",
  },
  delete_time_entry: {
    command: ["time-entry", "delete"],
    scope: "billing_write",
  },
  resolve_rate: { command: ["rate", "resolve"], scope: "read" },
  list_invoices: {
    command: ["invoice", "list"],
    scope: "read",
    itemsKey: "invoices",
    singleReadWhen: "invoice_id",
  },
  get_usage: { command: ["usage", "get"], scope: "read" },

  // --- research / admin ---
  search_legislation: {
    command: ["legislation", "search"],
    scope: "read",
    // Multi-shape payload (list vs single block vs related); the search-mode
    // list array key is `items`. Read-mode responses render as single objects.
    itemsKey: "items",
  },
  list_audit_log: {
    command: ["audit-log", "list"],
    scope: "admin_read",
    itemsKey: "items",
  },
  manage_organization: {
    command: ["organization"],
    scope: "admin_write",
    discriminator: {
      prop: "action",
      subcommands: {
        add_member: {
          command: "add-member",
          include: ["matter_id", "user_id"],
          required: ["matter_id", "user_id"],
        },
        remove_member: {
          command: "remove-member",
          include: ["matter_id", "user_id"],
          required: ["matter_id", "user_id"],
          destructive: true,
        },
        update_org_settings: {
          command: "update-settings",
          include: [
            "matter_number_pattern",
            "matter_number_padding",
            "prompt_caching_enabled",
          ],
        },
      },
    },
  },
};
