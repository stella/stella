import type {
  ChatMessage,
  ChatUIPart,
  ChatUITools,
} from "@/components/chat/chat-ui-tools";

export type ChatToolActivityCategory =
  "artifact" | "computation" | "mutation" | "research" | "user-input";

const BUILT_IN_CHAT_TOOL_ACTIVITY_CATEGORIES = {
  show_visual: "artifact",
  add_comment: "mutation",
  "ask-user": "user-input",
  boe_find_related_laws: "research",
  boe_get_law: "research",
  boe_get_law_block: "research",
  boe_get_law_structure: "research",
  boe_search_legislation: "research",
  borme_get_summary: "research",
  business_registry_lookup: "research",
  connect_connector: "user-input",
  counterparty_check: "research",
  request_secret: "user-input",
  review_folder_consistency: "research",
  "create-current-skill-resource": "mutation",
  "create-document": "user-input",
  create_matter_document: "artifact",
  create_reader_annotation: "mutation",
  delete_clause: "mutation",
  delete_contact: "mutation",
  delete_document: "mutation",
  delete_reader_annotation: "mutation",
  delete_task: "mutation",
  delete_time_entry: "mutation",
  describe_template: "research",
  discover_tools: "research",
  "expand-chat-history": "research",
  fetch_url: "research",
  fill_template: "artifact",
  find_text: "research",
  get_document_outline: "research",
  infosoud_lookup_case: "research",
  link_matter_contact: "mutation",
  list_connectable_connectors: "research",
  list_stories: "research",
  list_templates: "research",
  "load-skill": "research",
  add_matter_member: "mutation",
  remove_matter_member: "mutation",
  update_organization_settings: "mutation",
  execute_typescript: "computation",
  read_changes: "research",
  read_comments: "research",
  read_document: "research",
  read_section: "research",
  read_story: "research",
  "read-skill-resource": "research",
  remember: "mutation",
  reply_comment: "mutation",
  resolve_comment: "mutation",
  run_playbook: "mutation",
  save_clause: "mutation",
  save_playbook: "mutation",
  save_contact: "mutation",
  save_document: "mutation",
  save_matter: "mutation",
  save_task: "mutation",
  create_template: "mutation",
  configure_template_fields: "mutation",
  save_time_entry: "mutation",
  "search-all-past-chats": "research",
  "search-chat-history": "research",
  "search-past-chats": "research",
  set_field_value: "mutation",
  set_practice_jurisdictions: "mutation",
  show_in_document: "research",
  spawn_subagents: "computation",
  suggest_changes: "artifact",
  suggest_template_fields: "artifact",
  "update-current-skill-body": "mutation",
  "update-current-skill-resource": "mutation",
  "update-entity-fields": "mutation",
  update_reader_annotation: "mutation",
  use_connector_secret: "mutation",
  "use-browser": "research",
  web_search: "research",
} as const satisfies Record<keyof ChatUITools, ChatToolActivityCategory>;

const RETIRED_CHAT_TOOL_ACTIVITY_CATEGORIES = {
  "apply-active-docx-edits": "artifact",
  ares_lookup_company: "research",
  ares_search_companies: "research",
  compare_versions: "research",
  delete_matter: "mutation",
  "describe-stella-api": "research",
  "describe-stella-function": "research",
  edit_workspace_document: "artifact",
  "execute-typescript": "computation",
  "read-contact": "research",
  "read-content-across-matters": "research",
  read_contact: "research",
  read_content_across_matters: "research",
  "run-stella-query": "computation",
  save_template: "mutation",
  "search-across-matters": "research",
} as const satisfies Record<string, ChatToolActivityCategory>;

const CHAT_TOOL_ACTIVITY_CATEGORIES = {
  ...BUILT_IN_CHAT_TOOL_ACTIVITY_CATEGORIES,
  ...RETIRED_CHAT_TOOL_ACTIVITY_CATEGORIES,
} as const;

const isCategorizedBuiltInChatToolName = (
  toolName: string,
): toolName is keyof typeof CHAT_TOOL_ACTIVITY_CATEGORIES =>
  toolName in CHAT_TOOL_ACTIVITY_CATEGORIES;

const EXTERNAL_ARTIFACT_OPERATION_PATTERN =
  /(?:^|[_-])(?:compose|draft|fill|render|shape|transform)(?:$|[_-])/u;
const EXTERNAL_MUTATION_OPERATION_PATTERN =
  /(?:^|[_-])(?:add|create|delete|edit|link|manage|remove|reply|resolve|save|set|update|write)(?:$|[_-])/u;
const EXTERNAL_RESEARCH_OPERATION_PATTERN =
  /(?:^|[_-])(?:fetch|find|get|list|lookup|query|read|search)(?:$|[_-])/u;

const getExternalChatToolActivityCategory = (
  toolName: string,
): ChatToolActivityCategory => {
  const sourceToolName = toolName.split("__").slice(2).join("__");

  if (EXTERNAL_ARTIFACT_OPERATION_PATTERN.test(sourceToolName)) {
    return "artifact";
  }

  if (EXTERNAL_RESEARCH_OPERATION_PATTERN.test(sourceToolName)) {
    return "research";
  }

  if (EXTERNAL_MUTATION_OPERATION_PATTERN.test(sourceToolName)) {
    return "mutation";
  }

  return "computation";
};

export const getChatToolActivityCategory = (
  toolName: string,
): ChatToolActivityCategory => {
  if (isCategorizedBuiltInChatToolName(toolName)) {
    return CHAT_TOOL_ACTIVITY_CATEGORIES[toolName];
  }

  if (toolName.startsWith("mcp__")) {
    return getExternalChatToolActivityCategory(toolName);
  }

  return "computation";
};

const isFailedToolOutput = (output: unknown): boolean =>
  typeof output === "object" &&
  output !== null &&
  (("error" in output && output.error !== undefined && output.error !== null) ||
    ("success" in output && output.success === false) ||
    ("isError" in output && output.isError === true));

export const getLatestCompletedResearchPartIndex = (
  messages: readonly ChatMessage[],
): number | null => {
  const message = messages.at(-1);
  if (message?.role !== "assistant") {
    return null;
  }

  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (
      part?.type === "tool-call" &&
      part.state === "complete" &&
      getChatToolActivityCategory(part.name) === "research" &&
      !isFailedToolOutput(part.output)
    ) {
      return index;
    }
  }
  return null;
};

/** The kinds of work the model does itself; a person answers the rest. */
export type ProcessSummaryKind = Exclude<
  ChatToolActivityCategory,
  "user-input"
>;

/**
 * What a run of process steps accomplished, counted by kind: completed tool
 * calls that succeeded. A failed call is left out on purpose; the model
 * works around it, so it is not news to the reader. Steps that wait on a
 * person (ask-user) are not work the model did. Kinds with nothing to count
 * are absent.
 */
export const countProcessWork = (
  parts: readonly ChatUIPart[],
): ReadonlyMap<ProcessSummaryKind, number> => {
  const counts = new Map<ProcessSummaryKind, number>();
  for (const part of parts) {
    if (
      part.type !== "tool-call" ||
      part.state !== "complete" ||
      isFailedToolOutput(part.output)
    ) {
      continue;
    }
    const category = getChatToolActivityCategory(part.name);
    if (category !== "user-input") {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return counts;
};

type ResolveChatActivityIndicatorStateOptions = {
  hasCompletedResearch: boolean;
  hasRunningTool: boolean;
  hasVisibleResponse: boolean;
  hasVisibleContent: boolean;
};

/** `solving` once research came back (the answer is being composed from
 *  sources); `working` before that. */
export type ChatActivityIndicatorState = "solving" | "working";

export const resolveChatActivityIndicatorState = ({
  hasCompletedResearch,
  hasRunningTool,
  hasVisibleResponse,
  hasVisibleContent,
}: ResolveChatActivityIndicatorStateOptions): ChatActivityIndicatorState | null => {
  if (hasRunningTool || hasVisibleResponse) {
    return null;
  }

  if (hasCompletedResearch) {
    return "solving";
  }

  return hasVisibleContent ? null : "working";
};
