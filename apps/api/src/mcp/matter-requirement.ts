import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import type { McpEffectiveAuthority } from "@/api/mcp/effective-authority";
import type { MANAGE_ORG_ACTIONS } from "@/api/mcp/research-admin-tools";
import type { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import type { InternalToolErrorResult } from "@/api/mcp/tool-types";
import { structuredErrorResult } from "@/api/mcp/tool-utils";

/**
 * Where a write tool acts. `organization` tools (the clause and playbook
 * library, templates, contacts, organization settings, creating a matter)
 * work in an organization that has no matter yet. `matter` tools act on data
 * that lives inside a matter, so they cannot succeed until the caller can
 * reach one.
 */
export const WRITE_TOOL_SCOPE = {
  organization: "organization",
  matter: "matter",
} as const;

type WriteToolScopeValue =
  (typeof WRITE_TOOL_SCOPE)[keyof typeof WRITE_TOOL_SCOPE];

/** A tool whose scope depends on its `action` input. */
type WriteToolScopeByAction = {
  byAction: Readonly<Record<string, WriteToolScopeValue>>;
};

export type WriteToolScope = WriteToolScopeValue | WriteToolScopeByAction;

export type McpWriteToolName = Extract<
  (typeof DEFAULT_MCP_TOOL_DEFINITIONS)[number],
  { access: "write" }
>["name"];

const { organization, matter } = WRITE_TOOL_SCOPE;

/**
 * Every write tool's scope, keyed by the registry's write-tool union so a new
 * write tool fails typecheck until it chooses. Every surface offers every
 * write tool whatever the caller's matter count; this table only decides
 * which calls answer with the needs-a-matter result below.
 */
export const WRITE_TOOL_SCOPES = {
  // Creating a matter needs none. An update names its matter, and the handler
  // answers not_found for one the caller cannot reach.
  save_matter: organization,
  delete_matter: matter,
  save_contact: organization,
  delete_contact: organization,
  save_task: matter,
  delete_task: matter,
  link_matter_contact: matter,
  save_document: matter,
  upload_document_version: matter,
  open_document_version_upload: matter,
  delete_document: matter,
  compare_documents: matter,
  // Staged files and links outside any matter.
  prepare_file_comparison: organization,
  prepare_file_comparison_from_links: organization,
  open_file_comparison: organization,
  set_field_value: matter,
  save_time_entry: matter,
  delete_time_entry: matter,
  save_clause: organization,
  save_playbook: organization,
  delete_clause: organization,
  run_playbook: matter,
  create_reader_annotation: organization,
  update_reader_annotation: organization,
  delete_reader_annotation: organization,
  manage_organization: {
    byAction: {
      add_member: matter,
      remove_member: matter,
      update_org_settings: organization,
    } satisfies Record<
      (typeof MANAGE_ORG_ACTIONS)[number],
      WriteToolScopeValue
    >,
  },
  set_practice_jurisdictions: organization,
  fill_template: organization,
  save_filled_template: matter,
  create_template: organization,
  configure_template_fields: organization,
  // Each catalog capability enforces its own workspace access.
  invoke_capability: organization,
  submit_feedback: organization,
} as const satisfies Record<McpWriteToolName, WriteToolScope>;

const isWriteToolName = (toolName: string): toolName is McpWriteToolName =>
  Object.hasOwn(WRITE_TOOL_SCOPES, toolName);

/** Whether this call of a write tool acts inside a matter. */
export const writeCallNeedsMatter = (
  toolName: McpWriteToolName,
  args: Readonly<Record<string, unknown>>,
): boolean => {
  const scope: WriteToolScope = WRITE_TOOL_SCOPES[toolName];
  if (typeof scope === "string") {
    return scope === matter;
  }
  const action = args["action"];
  return (
    typeof action === "string" &&
    Object.hasOwn(scope.byAction, action) &&
    scope.byAction[action] === matter
  );
};

/**
 * The recoverable answer to a matter-scoped write when the caller can reach no
 * matter at all (typically a new organization). It tells the model to offer
 * creating a matter and to ask first, or, for a role that cannot create one,
 * to send the user to someone who can. `null` when the call may proceed.
 *
 * One step per sentence: a surface that does not list save_matter drops that
 * sentence and keeps the rest.
 */
export const matterRequiredResult = ({
  args,
  context,
  toolName,
}: {
  args: Readonly<Record<string, unknown>>;
  context: McpEffectiveAuthority & {
    accessibleWorkspaceIds: readonly string[];
  };
  toolName: string;
}): InternalToolErrorResult | null => {
  if (context.accessibleWorkspaceIds.length > 0) {
    return null;
  }
  if (!isWriteToolName(toolName) || !writeCallNeedsMatter(toolName, args)) {
    return null;
  }
  const canCreateMatter = hasEffectiveAuthority(context, {
    workspace: ["create"],
  });
  return structuredErrorResult({
    code: "not_found",
    message: `There is no matter to work in yet, and ${toolName} acts inside a matter.`,
    hint: canCreateMatter
      ? "Offer to create a matter for this and ask the user for its name and client; never create one without their go-ahead. " +
        "Once they agree, create it with save_matter. " +
        `Then retry ${toolName} in the new matter.`
      : "Tell the user this needs a matter and that their role cannot create one; an organization admin can create a matter or add them to one. " +
        `Retry ${toolName} once they can reach a matter.`,
    retryable: false,
  });
};
