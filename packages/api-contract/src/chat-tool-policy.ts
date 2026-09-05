export const CHAT_TOOL_POLICY_KIND = {
  external: "external",
  internal: "internal",
  mutation: "mutation",
  publicOfficial: "public_official",
  publicUnofficial: "public_unofficial",
} as const;

export type ChatToolPolicyKind =
  (typeof CHAT_TOOL_POLICY_KIND)[keyof typeof CHAT_TOOL_POLICY_KIND];

export const CHAT_TOOL_POLICY_REQUIRES_APPROVAL = {
  external: true,
  internal: false,
  mutation: true,
  public_official: false,
  public_unofficial: true,
} as const satisfies Record<ChatToolPolicyKind, boolean>;

/** Approval-gated kinds derived from the same map the API consumes at runtime. */
export type NeedsApprovalPolicyKind = {
  [TKind in ChatToolPolicyKind]: (typeof CHAT_TOOL_POLICY_REQUIRES_APPROVAL)[TKind] extends true
    ? TKind
    : never;
}[ChatToolPolicyKind];

export const BUILT_IN_CHAT_TOOL_POLICY_KINDS = {
  "ask-user": CHAT_TOOL_POLICY_KIND.internal,
  boe_find_related_laws: CHAT_TOOL_POLICY_KIND.publicOfficial,
  boe_get_law: CHAT_TOOL_POLICY_KIND.publicOfficial,
  boe_get_law_block: CHAT_TOOL_POLICY_KIND.publicOfficial,
  boe_get_law_structure: CHAT_TOOL_POLICY_KIND.publicOfficial,
  boe_search_legislation: CHAT_TOOL_POLICY_KIND.external,
  borme_get_summary: CHAT_TOOL_POLICY_KIND.publicOfficial,
  business_registry_lookup: CHAT_TOOL_POLICY_KIND.publicOfficial,
  // Server-executed read-only comparisons and reviews resolve only resources
  // already authorized for the caller, so they do not need per-call approval.
  compare_versions: CHAT_TOOL_POLICY_KIND.internal,
  review_folder_consistency: CHAT_TOOL_POLICY_KIND.internal,
  "create-document": CHAT_TOOL_POLICY_KIND.internal,
  "create-current-skill-resource": CHAT_TOOL_POLICY_KIND.mutation,
  // Creates a new entity and writes its rendered DOCX through the API's S3 +
  // database path, so each call requires explicit mutation approval.
  create_matter_document: CHAT_TOOL_POLICY_KIND.mutation,
  describe_template: CHAT_TOOL_POLICY_KIND.internal,
  // Discovery and the hardened sandbox runner expose only authorization-bound
  // read projections; neither performs a mutation itself.
  discover_tools: CHAT_TOOL_POLICY_KIND.internal,
  execute_typescript: CHAT_TOOL_POLICY_KIND.internal,
  "expand-chat-history": CHAT_TOOL_POLICY_KIND.internal,
  // Availability is separately deployment/thread gated. Calls still receive
  // free text or URLs, so they use the external-service approval policy.
  fetch_url: CHAT_TOOL_POLICY_KIND.external,
  find_text: CHAT_TOOL_POLICY_KIND.internal,
  // Folio editor reads inspect the authorized live document without mutation.
  get_document_outline: CHAT_TOOL_POLICY_KIND.internal,
  list_stories: CHAT_TOOL_POLICY_KIND.internal,
  read_changes: CHAT_TOOL_POLICY_KIND.internal,
  read_comments: CHAT_TOOL_POLICY_KIND.internal,
  read_document: CHAT_TOOL_POLICY_KIND.internal,
  read_section: CHAT_TOOL_POLICY_KIND.internal,
  read_story: CHAT_TOOL_POLICY_KIND.internal,
  show_in_document: CHAT_TOOL_POLICY_KIND.internal,
  // The one DOCX mutation tool. In automatic apply mode the API executes it
  // headlessly and writes a new entity version, so each call requires
  // mutation approval. The manual registration is client-executed and
  // queue-only (the bridge parks operations for per-suggestion review and
  // never writes); the API relaxes that registration to `internal` because
  // the Accept click is the meaningful human gate there.
  suggest_changes: CHAT_TOOL_POLICY_KIND.mutation,
  // Folio comment operations write tracked comments, replies, or resolutions;
  // the client executes each only after per-call approval.
  add_comment: CHAT_TOOL_POLICY_KIND.mutation,
  reply_comment: CHAT_TOOL_POLICY_KIND.mutation,
  resolve_comment: CHAT_TOOL_POLICY_KIND.mutation,
  // Template fill writes through a hand-written chat tool rather than a
  // registry projection, but remains approval-gated like every other write.
  fill_template: CHAT_TOOL_POLICY_KIND.mutation,
  infosoud_lookup_case: CHAT_TOOL_POLICY_KIND.publicOfficial,
  list_templates: CHAT_TOOL_POLICY_KIND.internal,
  "load-skill": CHAT_TOOL_POLICY_KIND.internal,
  "read-skill-resource": CHAT_TOOL_POLICY_KIND.internal,
  remember: CHAT_TOOL_POLICY_KIND.mutation,
  "search-chat-history": CHAT_TOOL_POLICY_KIND.internal,
  suggest_template_fields: CHAT_TOOL_POLICY_KIND.internal,
  "update-current-skill-body": CHAT_TOOL_POLICY_KIND.mutation,
  "update-current-skill-resource": CHAT_TOOL_POLICY_KIND.mutation,
  "update-entity-fields": CHAT_TOOL_POLICY_KIND.mutation,
  web_search: CHAT_TOOL_POLICY_KIND.external,
  // Registry write projections must all stay mutation-classified. The exact
  // key-set check in the server binds this map to registered built-in tools,
  // so adding a projection cannot land without an approval classification.
  delete_clause: CHAT_TOOL_POLICY_KIND.mutation,
  delete_contact: CHAT_TOOL_POLICY_KIND.mutation,
  delete_document: CHAT_TOOL_POLICY_KIND.mutation,
  delete_matter: CHAT_TOOL_POLICY_KIND.mutation,
  delete_task: CHAT_TOOL_POLICY_KIND.mutation,
  delete_time_entry: CHAT_TOOL_POLICY_KIND.mutation,
  link_matter_contact: CHAT_TOOL_POLICY_KIND.mutation,
  manage_organization: CHAT_TOOL_POLICY_KIND.mutation,
  run_playbook: CHAT_TOOL_POLICY_KIND.mutation,
  save_clause: CHAT_TOOL_POLICY_KIND.mutation,
  save_contact: CHAT_TOOL_POLICY_KIND.mutation,
  save_document: CHAT_TOOL_POLICY_KIND.mutation,
  save_matter: CHAT_TOOL_POLICY_KIND.mutation,
  save_task: CHAT_TOOL_POLICY_KIND.mutation,
  save_template: CHAT_TOOL_POLICY_KIND.mutation,
  save_time_entry: CHAT_TOOL_POLICY_KIND.mutation,
  set_field_value: CHAT_TOOL_POLICY_KIND.mutation,
  set_practice_jurisdictions: CHAT_TOOL_POLICY_KIND.mutation,
  // The top-level delegation is approval-gated. Subagent writes remain
  // non-executing proposals and return to the top-level loop for per-write
  // approval; this grant never authorizes the proposed writes themselves.
  spawn_subagents: CHAT_TOOL_POLICY_KIND.mutation,
} as const satisfies Record<string, ChatToolPolicyKind>;

export type BuiltInChatToolPolicyKindByName =
  typeof BUILT_IN_CHAT_TOOL_POLICY_KINDS;

export type ApprovalRequiredBuiltInChatToolName = {
  [TName in keyof BuiltInChatToolPolicyKindByName]: BuiltInChatToolPolicyKindByName[TName] extends NeedsApprovalPolicyKind
    ? TName
    : never;
}[keyof BuiltInChatToolPolicyKindByName];
