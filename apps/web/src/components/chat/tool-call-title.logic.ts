import type { StellaMcpToolName } from "@stll/api-contract/mcp-tool-names";
import { isOwnKey } from "@stll/api-contract/own-key";

import { getChatToolTitleKey } from "@/components/chat/chat-ui-tools";
import type { TranslationKey } from "@/i18n/types";

type ScriptReadArea = "caseLaw" | "legislation" | "other";

/**
 * Which body of law a stella read reaches when a code-mode script calls it.
 * Total over every registry tool, so a new tool decides whether its step
 * reads as legal research before it typechecks.
 */
const SCRIPT_READ_AREA = {
  add_matter_member: "other",
  case_law_coverage: "caseLaw",
  check_counterparty: "other",
  compare_documents: "other",
  configure_template_fields: "other",
  create_organization: "other",
  create_reader_annotation: "other",
  create_template: "other",
  delete_clause: "other",
  delete_contact: "other",
  delete_document: "other",
  delete_matter: "other",
  delete_reader_annotation: "other",
  delete_task: "other",
  delete_time_entry: "other",
  describe_capability: "other",
  fetch: "other",
  fill_template: "other",
  get_usage: "other",
  link_matter_contact: "other",
  list_audit_log: "other",
  list_capabilities: "other",
  list_case_law_courts: "caseLaw",
  list_clauses: "other",
  list_contacts: "other",
  list_documents: "other",
  list_invoices: "other",
  list_matters: "other",
  list_playbooks: "other",
  list_properties: "other",
  list_reader_annotations: "other",
  list_tasks: "other",
  list_templates: "other",
  list_time_entries: "other",
  lookup_business_registry: "other",
  mint_web_handoff: "other",
  open_case_law_decision: "caseLaw",
  open_document_version_upload: "other",
  open_file_comparison: "other",
  prepare_feedback: "other",
  prepare_file_comparison: "other",
  prepare_file_comparison_from_links: "other",
  preview_cited_provision: "legislation",
  preview_template_conditions: "other",
  read_capability: "other",
  read_case_law_citations: "caseLaw",
  read_case_law_decision: "caseLaw",
  read_case_law_decision_blocks: "caseLaw",
  read_contact: "other",
  read_content_across_matters: "other",
  read_document: "other",
  read_guidance: "other",
  read_provision_history: "legislation",
  read_statute: "legislation",
  read_statute_provisions: "legislation",
  remove_matter_member: "other",
  resolve_case_law_decision: "caseLaw",
  resolve_law_citation: "legislation",
  resolve_rate: "other",
  run_playbook: "other",
  save_clause: "other",
  save_contact: "other",
  save_document: "other",
  save_filled_template: "other",
  save_matter: "other",
  save_playbook: "other",
  save_task: "other",
  save_time_entry: "other",
  search: "other",
  search_across_matters: "other",
  search_boe_legislation: "legislation",
  search_case_law: "caseLaw",
  search_guidance: "other",
  search_legislation: "legislation",
  set_field_value: "other",
  set_practice_jurisdictions: "other",
  submit_feedback: "other",
  update_organization_settings: "other",
  update_reader_annotation: "other",
  upload_document_version: "other",
  verify_quote: "caseLaw",
  write_capability: "other",
} as const satisfies Record<StellaMcpToolName, ScriptReadArea>;

/** The legal research a code-mode run does, when that is all it reads. */
type CodeToolResearch = "caseLaw" | "legislation" | "legislationAndCaseLaw";

const CODE_TOOL_RESEARCH_TITLE_KEYS = {
  caseLaw: "chat.toolCall.searchingCaseLaw",
  legislation: "chat.toolCall.readingLegislation",
  legislationAndCaseLaw: "chat.toolCall.searchingLegislationAndCaseLaw",
} as const satisfies Record<CodeToolResearch, TranslationKey>;

// `execute_typescript` is the live code-mode runner; `execute-typescript`
// (hyphen) and `run-stella-query` are its retired predecessors, kept so
// historical threads still render as code cards.
const CODE_TOOL_NAMES = {
  "execute-typescript": true,
  execute_typescript: true,
  "run-stella-query": true,
} as const;
// Input keys that carry the sandbox source across the live and legacy code
// tools: code-mode's `execute_typescript` uses `typescriptCode`; the retired
// tools used `code`.
const CODE_SOURCE_INPUT_KEYS = ["typescriptCode", "code"] as const;

export const isCodeToolName = (name: string): boolean =>
  Object.hasOwn(CODE_TOOL_NAMES, name);

type CodeToolCall = {
  input: unknown;
  name: string;
};

/** The script a code tool ran, read from its call input. */
export const getCodeToolSource = ({
  input,
  name,
}: CodeToolCall): string | undefined => {
  if (!isCodeToolName(name) || input === null || typeof input !== "object") {
    return undefined;
  }
  for (const key of CODE_SOURCE_INPUT_KEYS) {
    const value: unknown = Reflect.get(input, key);
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
};

/** A script's stella reads (`external_<tool>(`), in source order. */
const SCRIPT_CALL_PATTERN = /\bexternal_([a-z][a-z0-9_]*)\s*\(/gu;
// The script is model-written input of any size; a step names what the
// opening of it sets up, where the lookups are.
const MAX_SCANNED_SOURCE_LENGTH = 20_000;
// A `§` citation with its paragraph parts and the abbreviations that follow
// it: "§ 243c odst. 2 o. s. ř."; "§ 280 Abs. 1 BGB" stops before "BGB",
// which carries no period.
const SECTION_CITATION_PATTERN =
  /§{1,2}\s?\d+\p{L}{0,2}(?:\s+\p{L}{1,5}\.\s?\d+\p{L}?)*(?:\s+\p{L}{1,4}\.){0,4}/u;
// The first phrasing a search was given: `query: "…"` or `queries: ["…"`.
const QUERY_PATTERN =
  /\bquer(?:y|ies)\s*:\s*(?:\[\s*)?(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')/u;
// Every single- or double-quoted string in the script.
const STRING_LITERAL_PATTERN = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/gu;
const MAX_TOPIC_LENGTH = 56;

const unescapeLiteral = (body: string): string =>
  body.replaceAll(/\\(.)/gu, (_match, escaped: string) =>
    escaped === "n" || escaped === "t" ? " " : escaped,
  );

const shortenTopic = (text: string): string | undefined => {
  const collapsed = text.replaceAll(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return undefined;
  }
  const codePoints = Array.from(collapsed);
  return codePoints.length <= MAX_TOPIC_LENGTH
    ? collapsed
    : `${codePoints.slice(0, MAX_TOPIC_LENGTH).join("").trimEnd()}…`;
};

const findTopic = (source: string): string | undefined => {
  for (const match of source.matchAll(STRING_LITERAL_PATTERN)) {
    const literal = unescapeLiteral(match[1] ?? match[2] ?? "");
    const citation = SECTION_CITATION_PATTERN.exec(literal)?.[0];
    if (citation !== undefined) {
      return shortenTopic(citation);
    }
  }
  const query = QUERY_PATTERN.exec(source);
  if (query === null) {
    return undefined;
  }
  return shortenTopic(unescapeLiteral(query[1] ?? query[2] ?? ""));
};

const researchOf = (
  areas: ReadonlySet<ScriptReadArea>,
): CodeToolResearch | undefined => {
  if (areas.size === 0 || areas.has("other")) {
    return undefined;
  }
  if (areas.has("legislation") && areas.has("caseLaw")) {
    return "legislationAndCaseLaw";
  }
  return areas.has("legislation") ? "legislation" : "caseLaw";
};

type CodeToolSummary = {
  /** Set only when every read the script makes is legislation or case law. */
  research: CodeToolResearch | undefined;
  /** A cited provision, else the first search phrasing. */
  topic: string | undefined;
  /** How many stella reads the script calls. */
  lookupCount: number;
};

/**
 * What a code-mode script looks up, read from its source without running
 * it: the stella reads it calls and the first thing it asks them for. A read
 * outside legislation and case law, or a script with none, names no
 * research area.
 */
export const summarizeCodeToolSource = (source: string): CodeToolSummary => {
  const scanned = source.slice(0, MAX_SCANNED_SOURCE_LENGTH);
  const areas = new Set<ScriptReadArea>();
  let lookupCount = 0;
  for (const [, toolName = ""] of scanned.matchAll(SCRIPT_CALL_PATTERN)) {
    lookupCount += 1;
    areas.add(
      isOwnKey(SCRIPT_READ_AREA, toolName)
        ? SCRIPT_READ_AREA[toolName]
        : "other",
    );
  }
  return {
    research: researchOf(areas),
    topic: findTopic(scanned),
    lookupCount,
  };
};

export type ToolCallTitleKey =
  | ReturnType<typeof getChatToolTitleKey>
  | (typeof CODE_TOOL_RESEARCH_TITLE_KEYS)[CodeToolResearch];

/**
 * The title a step shows. A code-mode run names the legal research its
 * script does; any other step, and a run that reads anything else, keeps
 * its tool's title.
 */
export const getToolCallTitleKey = (call: CodeToolCall): ToolCallTitleKey => {
  const source = getCodeToolSource(call);
  const research =
    source === undefined ? undefined : summarizeCodeToolSource(source).research;
  return research === undefined
    ? getChatToolTitleKey(call.name)
    : CODE_TOOL_RESEARCH_TITLE_KEYS[research];
};
