import { DOCUMENT_COMPARE_REQUEST_TIMEOUT_MS } from "@/api/handlers/documents/compare";
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
    delete_task: { command: ["task", "delete"], scope: "matters_write" },

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
    upload_document_version: {
      command: ["document", "upload-version"],
      // This tool adapts host-provided temporary URLs/MCP Apps. The CLI's
      // hand-wired `upload --entity-id` command accepts local bytes and compiles
      // from the same generated transport contract instead of exposing the
      // host adapter as a second, unusable CLI workflow.
      excluded: true,
      scope: "documents_write",
      inputOnly: ["file"],
    },
    open_document_version_upload: {
      command: ["document", "open-version-upload"],
      // Interactive MCP App launcher; local CLI uploads use the generated
      // transport contract directly and never need an embedded host view.
      excluded: true,
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
    prepare_file_comparison: {
      command: ["document", "comparison", "prepare"],
      scope: "documents_write",
    },
    prepare_file_comparison_from_links: {
      command: ["document", "comparison", "prepare-from-links"],
      scope: "documents_write",
    },
    open_file_comparison: {
      command: ["document", "comparison", "open"],
      // Interactive MCP App launcher; the CLI reads local files itself and
      // stages them through the prepare command.
      excluded: true,
      scope: "documents_write",
    },
    compare_documents: {
      command: ["document", "compare"],
      scope: "documents_write",
      itemsKey: "results",
      // One result per target, all in the one response: there is no page to
      // follow, so the leaf takes no cursor.
      paginationless: true,
      requestTimeoutMs: DOCUMENT_COMPARE_REQUEST_TIMEOUT_MS,
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
    save_playbook: { command: ["playbook", "save"], scope: "knowledge_write" },
    run_playbook: { command: ["playbook", "run"], scope: "knowledge_write" },

    list_reader_annotations: {
      command: ["annotation", "list"],
      scope: "read",
      itemsKey: "annotations",
    },
    create_reader_annotation: {
      command: ["annotation", "create"],
      scope: "knowledge_write",
    },
    update_reader_annotation: {
      command: ["annotation", "update"],
      scope: "knowledge_write",
    },
    delete_reader_annotation: {
      command: ["annotation", "delete"],
      scope: "knowledge_write",
    },

    search_across_matters: {
      command: ["search", "matters"],
      scope: "search",
      itemsKey: "hits",
    },
    // A document's text belongs under the `document` group: callers looking for
    // it start from `stella document ...`, not from the search group.
    read_content_across_matters: {
      command: ["document", "content"],
      scope: "read",
      windowedText: { textPath: "text" },
    },
    search_case_law: {
      command: ["case-law", "search"],
      scope: "search",
      itemsKey: "results",
    },
    lookup_case_law: {
      command: ["case-law", "lookup"],
      scope: "read",
      itemsKey: "items",
    },
    // A batch read answers per entry, so the leaf renders `items`. It cannot
    // be a `windowedText` leaf: that annotation names one text and one
    // top-level `nextCursor`, and here both are per entry. `perEntryCursor`
    // takes `--all` off the leaf for the same reason: the follow loop advances
    // a top-level cursor, and with none to advance it would return the first
    // window as though it were the whole decision. A caller continuing one
    // decision's text passes that decision id with its own entry cursor.
    read_case_law_decision: {
      command: ["case-law", "read"],
      scope: "read",
      itemsKey: "items",
      perEntryCursor: true,
    },
    read_case_law_citations: {
      command: ["case-law", "citations"],
      scope: "read",
      itemsKey: "citations",
    },

    prepare_feedback: { command: ["feedback", "prepare"], scope: "feedback" },
    submit_feedback: { command: ["feedback", "submit"], scope: "feedback" },

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
    preview_template_conditions: {
      command: ["template", "preview-conditions"],
      scope: "templates",
      itemsKey: "conditions",
      paginationless: true,
      inputOnly: ["values"],
    },
    save_filled_template: {
      command: ["template", "save-filled"],
      additionalScopes: ["templates"],
      // The server caps render work at five minutes. Leave 30 seconds for the
      // persistence response while retaining a finite transport deadline.
      requestTimeoutMs: 330_000,
      scope: "documents_write",
      inputOnly: ["values"],
      discriminator: {
        prop: "action",
        subcommands: {
          create_document: {
            command: "new-document",
            include: [
              "template_id",
              "matter_id",
              "idempotency_key",
              "parent_id",
              "name",
              "values",
              "completion_mode",
            ],
            required: ["template_id", "matter_id", "idempotency_key", "values"],
          },
          create_version: {
            command: "new-version",
            include: [
              "template_id",
              "matter_id",
              "idempotency_key",
              "entity_id",
              "name",
              "values",
              "completion_mode",
            ],
            required: [
              "template_id",
              "matter_id",
              "entity_id",
              "idempotency_key",
              "values",
            ],
          },
        },
      },
    },
    create_template: {
      command: ["template", "create"],
      scope: "templates",
      // A CLI caller cannot fill `file` (no host transport), and typing a DOCX
      // as base64 on a command line hits the OS argument limit first. `--file
      // <path>` reads the bytes and sends this same prop.
      localFileBase64Prop: "docx_base64",
    },
    configure_template_fields: {
      command: ["template", "configure-fields"],
      scope: "templates",
    },

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
      scope: "search",
      itemsKey: "results",
    },
    read_statute: {
      command: ["legislation", "read"],
      scope: "read",
      windowedText: { textPath: "statute.text" },
    },
    read_statute_provisions: {
      command: ["legislation", "provisions"],
      scope: "read",
      itemsKey: "items",
    },
    read_provision_history: {
      command: ["legislation", "history"],
      scope: "read",
      itemsKey: "items",
    },
    search_boe_legislation: {
      command: ["legislation", "boe-search"],
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
          },
          update_org_settings: {
            command: "update-settings",
            include: [
              "matter_number_pattern",
              "matter_number_padding",
              "prompt_caching_enabled",
              "document_processing_mode",
            ],
          },
        },
      },
    },
  },
);
