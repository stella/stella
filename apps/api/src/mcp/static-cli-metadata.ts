import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import { defineMcpCliToolAnnotations } from "@/api/mcp/tool-types";

/**
 * Canonical command-line projection for the static MCP tool surface.
 *
 * This is API-owned metadata because it describes the same first-party tools as
 * the MCP registry. The public MCP `tools/list` response deliberately does not
 * expose these command-shaping hints; the CLI build snapshot consumes them and
 * generates its downstream route map from this one source.
 */
export const DEFAULT_MCP_CLI_ANNOTATIONS = defineMcpCliToolAnnotations(
  DEFAULT_MCP_TOOL_DEFINITIONS,
  {
    search: { command: ["search"], excluded: true, scope: "search" },
    fetch: { command: ["fetch"], excluded: true, scope: "read" },

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

    list_contacts: {
      command: ["contact", "list"],
      scope: "read",
      itemsKey: "items",
    },
    save_contact: { command: ["contact", "save"], scope: "matters_write" },
    delete_contact: {
      command: ["contact", "delete"],
      scope: "matters_write",
    },
    read_contact: { command: ["contact", "read"], scope: "read" },
    lookup_business_registry: {
      command: ["contact", "lookup-registry"],
      scope: "read",
    },

    list_tasks: {
      command: ["task", "list"],
      scope: "read",
      itemsKey: "tasks",
      singleReadWhen: "task_id",
    },
    save_task: { command: ["task", "save"], scope: "matters_write" },

    list_documents: {
      command: ["document", "list"],
      scope: "read",
      itemsKey: "documents",
    },
    read_document: { command: ["document", "read"], scope: "read" },
    save_document: {
      command: ["document", "save"],
      scope: "documents_write",
    },
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

    list_clauses: {
      command: ["clause", "list"],
      scope: "read",
      itemsKey: "clauses",
      singleReadWhen: "clause_id",
    },
    save_clause: { command: ["clause", "save"], scope: "knowledge_write" },
    delete_clause: {
      command: ["clause", "delete"],
      scope: "knowledge_write",
    },
    list_playbooks: {
      command: ["playbook", "list"],
      scope: "read",
      itemsKey: "items",
      singleReadWhen: "playbook_id",
    },
    run_playbook: { command: ["playbook", "run"], scope: "knowledge_write" },

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

    send_feedback: { command: ["feedback", "send"], scope: "feedback" },

    set_practice_jurisdictions: {
      command: ["organization", "set-jurisdictions"],
      scope: "onboarding",
    },

    list_templates: {
      command: ["template", "list"],
      scope: "templates",
      itemsKey: "templates",
      paginationless: true,
      singleReadWhen: "template_id",
    },
    fill_template: { command: ["template", "fill"], scope: "templates" },
    save_template: { command: ["template", "save"], scope: "templates" },

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

    search_legislation: {
      command: ["legislation", "search"],
      scope: "read",
      itemsKey: "items",
    },
    list_audit_log: {
      command: ["audit-log", "list"],
      scope: "admin_read",
      itemsKey: "items",
    },
    list_capabilities: {
      command: ["capability", "list"],
      scope: "read",
      itemsKey: "items",
    },
    describe_capability: {
      command: ["capability", "describe"],
      scope: "read",
    },
    invoke_capability: {
      command: ["capability", "invoke"],
      scope: "read",
      // Destructiveness is per-invoked-capability (catalog flag), not a
      // property of the tool, so the leaf is non-destructive; the confirm
      // passthrough lets --yes / a TTY prompt satisfy the server's per-target
      // confirmation_required gate.
      confirmPassthrough: true,
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
  },
);
