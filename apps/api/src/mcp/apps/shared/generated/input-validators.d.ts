// Generated from declared MCP tool input schemas.
type InputValidator = ((input: unknown) => boolean) & { errors?: readonly { instancePath: string; keyword: string; params: Record<string, unknown> }[] | null };
declare const validators: Record<"search_case_law" | "resolve_case_law_decision" | "open_case_law_decision" | "read_case_law_decision_blocks" | "preview_cited_provision" | "read_provision_history", InputValidator>;
export default validators;
