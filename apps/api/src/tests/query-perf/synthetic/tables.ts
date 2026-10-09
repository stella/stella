/** Tables owned by the synthetic fixture; migrations retain ownership of other data. */
export const SYNTHETIC_TABLES = [
  "organization",
  "user",
  "member",
  "workspaces",
  "workspace_members",
  "properties",
  "entities",
  "entity_versions",
  "fields",
  "search_documents",
  "extracted_content",
  "legal_lists",
  "legal_list_sections",
  "legal_list_items",
  "task_assignees",
] as const;
