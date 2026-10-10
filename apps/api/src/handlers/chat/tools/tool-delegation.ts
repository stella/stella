import type {
  BUILT_IN_CHAT_TOOL_POLICY_KINDS,
  MCP_CHAT_TOOL_POLICY_KINDS,
} from "@stll/api-contract";

import type { CAPABILITY_DISPATCH } from "@/api/mcp/generated/capability-dispatch";

type NativeChatToolName = Exclude<
  keyof typeof BUILT_IN_CHAT_TOOL_POLICY_KINDS,
  keyof typeof MCP_CHAT_TOOL_POLICY_KINDS
>;

type DelegationPolicyToolName = {
  [
    TName in NativeChatToolName
  ]: (typeof BUILT_IN_CHAT_TOOL_POLICY_KINDS)[TName] extends
    | "internal"
    | "mutation"
    ? TName
    : never;
}[NativeChatToolName];

type CapabilityDelegation = {
  type: "capability";
  delegatesTo: keyof typeof CAPABILITY_DISPATCH;
};

type DelegationWaiver = {
  type: "waiver";
  reason: string;
};

export type ChatToolDelegation =
  | CapabilityDelegation
  | DelegationWaiver
  | {
      type: "execution-mode";
      server: CapabilityDelegation;
      client: DelegationWaiver;
    };

/** Every native internal or mutation registration makes an authority decision. */
export const NATIVE_CHAT_TOOL_DELEGATIONS = {
  request_secret: {
    type: "waiver",
    reason:
      "The client submits private input through a dedicated authenticated endpoint.",
  },
  show_visual: {
    type: "waiver",
    reason:
      "Publishes a private view for the owning chat turn; no standalone MCP or CLI execution context exists.",
  },
  "ask-user": {
    type: "waiver",
    reason:
      "Client questions return conversation input without a domain write.",
  },
  review_folder_consistency: {
    type: "waiver",
    reason:
      "Scoped document review only; model usage is owned by the AI admission path.",
  },
  "create-document": {
    type: "waiver",
    reason:
      "Client document compilation returns a draft; persistence is a separate authenticated save.",
  },
  "create-current-skill-resource": {
    type: "capability",
    delegatesTo: "skills.resources.create",
  },
  create_matter_document: {
    type: "capability",
    delegatesTo: "entities.from-legal-source.create",
  },
  describe_template: {
    type: "waiver",
    reason:
      "Reads the stored template's fields without modifying the template.",
  },
  discover_tools: {
    type: "waiver",
    reason:
      "Discovers the registry's read projections without executing a write.",
  },
  execute_typescript: {
    type: "waiver",
    reason:
      "The sandbox exposes read projections; writes return direct-tool guidance.",
  },
  "expand-chat-history": {
    type: "waiver",
    reason:
      "Reads earlier messages of the authorized chat without modifying them.",
  },
  find_text: {
    type: "waiver",
    reason: "Searches the mounted live editor without changing its document.",
  },
  get_document_outline: {
    type: "waiver",
    reason:
      "Reads the mounted live editor's outline without changing its document.",
  },
  list_stories: {
    type: "waiver",
    reason: "Lists mounted editor stories without changing their content.",
  },
  read_changes: {
    type: "waiver",
    reason:
      "Reads tracked changes in the mounted editor without resolving them.",
  },
  read_comments: {
    type: "waiver",
    reason: "Reads comments in the mounted editor without modifying them.",
  },
  read_document: {
    type: "waiver",
    reason: "Reads the mounted editor's document without modifying it.",
  },
  read_section: {
    type: "waiver",
    reason: "Reads a mounted editor section without modifying it.",
  },
  read_story: {
    type: "waiver",
    reason: "Reads a mounted editor story without modifying it.",
  },
  show_in_document: {
    type: "waiver",
    reason: "Navigates the mounted editor without changing persisted content.",
  },
  suggest_changes: {
    type: "execution-mode",
    server: { type: "capability", delegatesTo: "entities.versions.upload" },
    client: {
      type: "waiver",
      reason:
        "Queues client review suggestions; acceptance and save are separate user actions.",
    },
  },
  add_comment: {
    type: "waiver",
    reason:
      "Client editor comments have no standalone REST counterpart; document save owns persistence.",
  },
  reply_comment: {
    type: "waiver",
    reason:
      "Client editor replies have no standalone REST counterpart; document save owns persistence.",
  },
  resolve_comment: {
    type: "waiver",
    reason:
      "Client editor comment resolution has no standalone REST counterpart; document save owns persistence.",
  },
  fill_template: { type: "capability", delegatesTo: "templates.fill" },
  list_templates: {
    type: "waiver",
    reason: "Lists authorized templates without modifying the library.",
  },
  "load-skill": {
    type: "waiver",
    reason:
      "Reads available skill instructions; consumption and read audit use their own owners.",
  },
  "read-skill-resource": {
    type: "waiver",
    reason: "Reads a visible skill resource; read audit uses its own owner.",
  },
  remember: {
    type: "waiver",
    reason:
      "The memories create handler is internal to assistant chat, absent from the capability catalog; persistExplicitMemory owns persistence.",
  },
  "search-chat-history": {
    type: "waiver",
    reason: "Searches authorized chat messages without modifying them.",
  },
  "search-past-chats": {
    type: "waiver",
    reason:
      "Searches past chats within the authorized scope without modifying them.",
  },
  suggest_template_fields: {
    type: "capability",
    delegatesTo: "templates.fields.suggest",
  },
  "update-current-skill-body": {
    type: "capability",
    delegatesTo: "skills.update",
  },
  "update-current-skill-resource": {
    type: "capability",
    delegatesTo: "skills.resources.update",
  },
  "update-entity-fields": { type: "capability", delegatesTo: "fields.upsert" },
  spawn_subagents: {
    type: "waiver",
    reason:
      "Nested writers return proposals to the parent; each resulting write has its own approval and authority.",
  },
} as const satisfies Record<DelegationPolicyToolName, ChatToolDelegation>;
