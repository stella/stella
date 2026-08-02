import type { OrbState } from "thinking-orbs";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";

export type ChatToolActivityCategory =
  | "artifact"
  | "computation"
  | "mutation"
  | "research"
  | "user-input";

const BUILT_IN_CHAT_TOOL_ACTIVITY_CATEGORIES = {
  add_comment: "mutation",
  "apply-active-docx-edits": "artifact",
  "ask-user": "user-input",
  ares_lookup_company: "research",
  ares_search_companies: "research",
  boe_find_related_laws: "research",
  boe_get_law: "research",
  boe_get_law_block: "research",
  boe_get_law_structure: "research",
  boe_search_legislation: "research",
  borme_get_summary: "research",
  business_registry_lookup: "research",
  "create-current-skill-resource": "mutation",
  "create-document": "user-input",
  create_workspace_document: "artifact",
  delete_clause: "mutation",
  delete_contact: "mutation",
  delete_document: "mutation",
  delete_matter: "mutation",
  delete_time_entry: "mutation",
  edit_workspace_document: "artifact",
  "expand-chat-history": "research",
  fetch_url: "research",
  fill_template: "artifact",
  find_text: "research",
  infosoud_lookup_case: "research",
  link_matter_contact: "mutation",
  manage_organization: "mutation",
  "read-contact": "research",
  "read-content-across-matters": "research",
  read_contact: "research",
  read_content_across_matters: "research",
  read_changes: "research",
  read_comments: "research",
  read_document: "research",
  reply_comment: "mutation",
  resolve_comment: "mutation",
  save_clause: "mutation",
  save_contact: "mutation",
  save_document: "mutation",
  save_matter: "mutation",
  save_task: "mutation",
  save_template: "mutation",
  save_time_entry: "mutation",
  "search-across-matters": "research",
  "search-chat-history": "research",
  search_across_matters: "research",
  set_field_value: "mutation",
  set_practice_jurisdictions: "mutation",
  suggest_template_fields: "artifact",
  "update-current-skill-body": "mutation",
  "update-current-skill-resource": "mutation",
  "update-entity-fields": "mutation",
  web_search: "research",
} as const satisfies Record<string, ChatToolActivityCategory>;

const isCategorizedBuiltInChatToolName = (
  toolName: string,
): toolName is keyof typeof BUILT_IN_CHAT_TOOL_ACTIVITY_CATEGORIES =>
  toolName in BUILT_IN_CHAT_TOOL_ACTIVITY_CATEGORIES;

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
    return BUILT_IN_CHAT_TOOL_ACTIVITY_CATEGORIES[toolName];
  }

  if (toolName.startsWith("mcp__")) {
    return getExternalChatToolActivityCategory(toolName);
  }

  return "computation";
};

type ChatToolActivityState = Extract<
  OrbState,
  "searching" | "shaping" | "working"
>;

export const getChatToolActivityState = (
  toolName: string,
): ChatToolActivityState | null => {
  const category = getChatToolActivityCategory(toolName);

  switch (category) {
    case "artifact":
      return "shaping";
    case "computation":
    case "mutation":
      return "working";
    case "research":
      return "searching";
    case "user-input":
      return null;
    default:
      category satisfies never;
      return null;
  }
};

export const hasCompletedResearchInLatestAssistantMessage = (
  messages: readonly PersistedChatMessage[],
): boolean => {
  const message = messages.at(-1);
  if (message?.role !== "assistant") {
    return false;
  }

  return message.parts.some(
    (part) =>
      part.type === "tool-call" &&
      part.state === "complete" &&
      getChatToolActivityCategory(part.name) === "research",
  );
};

type ResolveChatActivityIndicatorStateOptions = {
  hasCompletedResearch: boolean;
  hasRunningTool: boolean;
  hasVisibleResponse: boolean;
  hasVisibleContent: boolean;
};

type ChatActivityIndicatorState = Extract<OrbState, "solving" | "working">;

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
