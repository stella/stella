/**
 * How a chat answer's steps read to a person, on every surface that shows
 * them (the web app and the phone). A tool call is internal plumbing; what a
 * person sees is a translated label for it ("Reading workspace data", not
 * `execute_typescript`) and, for a settled run of steps, what the run got
 * done ("Searched legislation and case law · 5 lookups"). Each app
 * translates the labels through its own catalogue under the label's name.
 */
import { panic } from "better-result";

import { ASK_USER_TOOL_NAME, CREATE_DOCUMENT_TOOL_NAME } from "./chat";
import { codeStepReads, type ScriptReadArea } from "./chat-code-step";
import { CONNECT_CONNECTOR_TOOL_NAME } from "./chat-connector";
import { CHAT_LOCAL_RUN_QUESTION_TOOL } from "./chat-local-run-question";
import { REQUEST_SECRET_TOOL_NAME } from "./chat-secret";
import type { BuiltInChatToolPolicyKindByName } from "./chat-tool-policy";
import { isOwnKey } from "./own-key";

export type ChatToolActivityCategory =
  "artifact" | "computation" | "mutation" | "research" | "user-input";

type ChatToolDisplay = {
  readonly category: ChatToolActivityCategory;
  /** The name each app's catalogue keeps the step's translated title under. */
  readonly label: string;
};

/** Every tool the chat registers today. */
const BUILT_IN_CHAT_TOOL_DISPLAY = {
  show_visual: { category: "artifact", label: "show_visual" },
  show_app: { category: "artifact", label: "show_app" },
  add_comment: { category: "mutation", label: "add_comment" },
  "ask-user": { category: "user-input", label: "ask-user" },
  boe_find_related_laws: {
    category: "research",
    label: "boe_find_related_laws",
  },
  boe_get_law: { category: "research", label: "boe_get_law" },
  boe_get_law_block: { category: "research", label: "boe_get_law_block" },
  boe_get_law_structure: {
    category: "research",
    label: "boe_get_law_structure",
  },
  boe_search_legislation: {
    category: "research",
    label: "boe_search_legislation",
  },
  borme_get_summary: { category: "research", label: "borme_get_summary" },
  business_registry_lookup: {
    category: "research",
    label: "business_registry_lookup",
  },
  connect_connector: { category: "user-input", label: "connect_connector" },
  counterparty_check: { category: "research", label: "counterparty_check" },
  request_secret: { category: "user-input", label: "request_secret" },
  review_folder_consistency: {
    category: "research",
    label: "review_folder_consistency",
  },
  "create-current-skill-resource": {
    category: "mutation",
    label: "skill-edit",
  },
  "create-document": { category: "user-input", label: "create-document" },
  create_matter_document: {
    category: "artifact",
    label: "create_matter_document",
  },
  create_reader_annotation: {
    category: "mutation",
    label: "create_reader_annotation",
  },
  delete_clause: { category: "mutation", label: "delete_clause" },
  delete_contact: { category: "mutation", label: "delete_contact" },
  delete_document: { category: "mutation", label: "delete_document" },
  delete_matter: { category: "mutation", label: "delete_matter" },
  delete_reader_annotation: {
    category: "mutation",
    label: "delete_reader_annotation",
  },
  delete_task: { category: "mutation", label: "delete_task" },
  delete_time_entry: { category: "mutation", label: "delete_time_entry" },
  describe_template: { category: "research", label: "describe_template" },
  // Code mode's discovery companion: fetches a read tool's signature.
  discover_tools: { category: "research", label: "discover_tools" },
  "expand-chat-history": { category: "research", label: "expand-chat-history" },
  fetch_url: { category: "research", label: "fetch_url" },
  fill_template: { category: "artifact", label: "fill_template" },
  find_text: { category: "research", label: "find_text" },
  get_document_outline: { category: "research", label: "get_document_outline" },
  infosoud_lookup_case: { category: "research", label: "infosoud_lookup_case" },
  link_matter_contact: { category: "mutation", label: "link_matter_contact" },
  list_connectable_connectors: {
    category: "research",
    label: "list_connectable_connectors",
  },
  list_stories: { category: "research", label: "list_stories" },
  list_templates: { category: "research", label: "list_templates" },
  "load-skill": { category: "research", label: "load-skill" },
  add_matter_member: { category: "mutation", label: "add_matter_member" },
  remove_matter_member: { category: "mutation", label: "remove_matter_member" },
  update_organization_settings: {
    category: "mutation",
    label: "update_organization_settings",
  },
  // Code mode's sandbox runner, which reads the workspace's data.
  execute_typescript: { category: "computation", label: "execute_typescript" },
  read_changes: { category: "research", label: "read_changes" },
  read_comments: { category: "research", label: "read_comments" },
  read_document: { category: "research", label: "read_document" },
  read_section: { category: "research", label: "read_section" },
  read_story: { category: "research", label: "read_story" },
  "read-skill-resource": { category: "research", label: "read-skill-resource" },
  remember: { category: "mutation", label: "remember" },
  reply_comment: { category: "mutation", label: "reply_comment" },
  resolve_comment: { category: "mutation", label: "resolve_comment" },
  run_playbook: { category: "mutation", label: "run_playbook" },
  save_clause: { category: "mutation", label: "save_clause" },
  save_playbook: { category: "mutation", label: "save_playbook" },
  save_contact: { category: "mutation", label: "save_contact" },
  save_document: { category: "mutation", label: "save_document" },
  save_matter: { category: "mutation", label: "save_matter" },
  save_task: { category: "mutation", label: "save_task" },
  create_template: { category: "mutation", label: "create_template" },
  configure_template_fields: {
    category: "mutation",
    label: "configure_template_fields",
  },
  save_time_entry: { category: "mutation", label: "save_time_entry" },
  "search-all-past-chats": {
    category: "research",
    label: "search-all-past-chats",
  },
  save_skill_package: { category: "mutation", label: "save_skill_package" },
  "search-chat-history": { category: "research", label: "search-chat-history" },
  "search-past-chats": { category: "research", label: "search-past-chats" },
  set_field_value: { category: "mutation", label: "set_field_value" },
  set_practice_jurisdictions: {
    category: "mutation",
    label: "set_practice_jurisdictions",
  },
  show_in_document: { category: "research", label: "show_in_document" },
  spawn_subagents: { category: "computation", label: "spawn_subagents" },
  suggest_changes: { category: "artifact", label: "suggest_changes" },
  suggest_template_fields: {
    category: "artifact",
    label: "suggest_template_fields",
  },
  "update-current-skill-body": { category: "mutation", label: "skill-edit" },
  "update-current-skill-resource": {
    category: "mutation",
    label: "skill-edit",
  },
  "update-entity-fields": {
    category: "mutation",
    label: "update-entity-fields",
  },
  update_reader_annotation: {
    category: "mutation",
    label: "update_reader_annotation",
  },
  use_connector_secret: { category: "mutation", label: "use_connector_secret" },
  validate_skill_package: {
    category: "computation",
    label: "validate_skill_package",
  },
  "use-browser": { category: "research", label: "use-browser" },
  web_search: { category: "research", label: "web_search" },
} as const satisfies Record<
  keyof BuiltInChatToolPolicyKindByName,
  ChatToolDisplay
>;

/**
 * Tools no longer registered whose calls stored threads still carry; each
 * keeps a recognisable label rather than the unknown fallback.
 */
const RETIRED_CHAT_TOOL_DISPLAY = {
  // The manual DOCX edit tool `suggest_changes` replaced.
  "apply-active-docx-edits": {
    category: "artifact",
    label: "apply-active-docx-edits",
  },
  // The automatic DOCX edit tool the server-executed `suggest_changes`
  // variant replaced.
  edit_workspace_document: { category: "artifact", label: "suggest_changes" },
  compare_versions: { category: "research", label: "compare_versions" },
  // Replaced by `business_registry_lookup`.
  ares_lookup_company: { category: "research", label: "ares_lookup_company" },
  ares_search_companies: {
    category: "research",
    label: "ares_search_companies",
  },
  // Split into `create_template` and `configure_template_fields`.
  save_template: { category: "mutation", label: "save_template" },
  // Hand-written code tools that code mode replaced.
  "describe-stella-api": { category: "research", label: "describe-stella-api" },
  "describe-stella-function": {
    category: "research",
    label: "describe-stella-function",
  },
  "execute-typescript": {
    category: "computation",
    label: "execute-typescript",
  },
  "run-stella-query": { category: "computation", label: "run-stella-query" },
  "read-contact": { category: "research", label: "read-contact" },
  read_contact: { category: "research", label: "read-contact" },
  "read-content-across-matters": {
    category: "research",
    label: "read-content-across-matters",
  },
  read_content_across_matters: {
    category: "research",
    label: "read-content-across-matters",
  },
  "search-across-matters": {
    category: "research",
    label: "search-across-matters",
  },
} as const satisfies Record<string, ChatToolDisplay>;

/**
 * Actions a coding agent on the member's computer takes itself, stored under
 * the names the agent engine gives them (`HARNESS_TOOL_NAMES` in
 * `@stll/agent-engine`). Its calls to stella use the names above.
 */
const HARNESS_CHAT_TOOL_DISPLAY = {
  command_execution: { category: "computation", label: "command_execution" },
  file_change: { category: "computation", label: "file_change" },
  harness_web_search: { category: "computation", label: "harness_web_search" },
  // A step of the agent's own (a read, a search, a proposed plan): its row and
  // approval card name its kind from the step's detail, not from this label.
  harness_native_tool: { category: "computation", label: "unknown" },
  // `CHAT_LOCAL_RUN_QUESTION_TOOL`, spelled out: a key computed from a
  // constant reads as a widening literal, and the web's approval grant set,
  // typed by these names, would then infer as a set of any string.
  request_user_input: {
    category: "user-input",
    label: "request_user_input",
  },
  request_permissions: {
    category: "computation",
    label: "request_permissions",
  },
  harness_unsupported_item: {
    category: "computation",
    label: "harness_unsupported_item",
  },
  // A step in the member's own Chrome, titled as the web chat's browser
  // step is.
  local_browser: { category: "research", label: "use-browser" },
} as const satisfies Record<string, ChatToolDisplay>;

const CHAT_TOOL_DISPLAY = {
  ...BUILT_IN_CHAT_TOOL_DISPLAY,
  ...RETIRED_CHAT_TOOL_DISPLAY,
  ...HARNESS_CHAT_TOOL_DISPLAY,
} as const;

/** A step a coding agent on the member's computer took itself. */
export type HarnessChatToolName = keyof typeof HARNESS_CHAT_TOOL_DISPLAY;

/** A tool no longer registered whose calls stored threads still carry. */
export type RetiredChatToolName = keyof typeof RETIRED_CHAT_TOOL_DISPLAY;

/** A tool name this module knows, current, retired or the local agent's. */
export type KnownChatToolName = keyof typeof CHAT_TOOL_DISPLAY;

/** The fallback for a tool no surface knows, an external one included. */
export const UNKNOWN_CHAT_TOOL_LABEL = "unknown";

/**
 * The name of a step's title in an app's catalogue. Two tools may share a
 * title; a tool this module does not know reads as `unknown`.
 */
export type ChatToolLabel =
  | (typeof CHAT_TOOL_DISPLAY)[KnownChatToolName]["label"]
  | typeof UNKNOWN_CHAT_TOOL_LABEL;

/** Every title an app's catalogue must hold. */
export const CHAT_TOOL_LABELS: readonly ChatToolLabel[] = [
  ...new Set<ChatToolLabel>([
    ...Object.values(CHAT_TOOL_DISPLAY).map(({ label }) => label),
    UNKNOWN_CHAT_TOOL_LABEL,
  ]),
];

export const isKnownChatToolName = (
  toolName: string,
): toolName is KnownChatToolName => isOwnKey(CHAT_TOOL_DISPLAY, toolName);

/** The title a step of this tool shows, as its catalogue names it. */
export const chatToolLabel = (toolName: string): ChatToolLabel =>
  isKnownChatToolName(toolName)
    ? CHAT_TOOL_DISPLAY[toolName].label
    : UNKNOWN_CHAT_TOOL_LABEL;

const EXTERNAL_ARTIFACT_OPERATION_PATTERN =
  /(?:^|[_-])(?:compose|draft|fill|render|shape|transform)(?:$|[_-])/u;
const EXTERNAL_MUTATION_OPERATION_PATTERN =
  /(?:^|[_-])(?:add|create|delete|edit|link|manage|remove|reply|resolve|save|set|update|write)(?:$|[_-])/u;
const EXTERNAL_RESEARCH_OPERATION_PATTERN =
  /(?:^|[_-])(?:fetch|find|get|list|lookup|query|read|search)(?:$|[_-])/u;

/** An external MCP tool (`mcp__<connector>__<tool>`), read from its verb. */
const externalChatToolActivityCategory = (
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

/** What kind of work a call of this tool is. */
export const getChatToolActivityCategory = (
  toolName: string,
): ChatToolActivityCategory => {
  if (isKnownChatToolName(toolName)) {
    return CHAT_TOOL_DISPLAY[toolName].category;
  }
  if (toolName.startsWith("mcp__")) {
    return externalChatToolActivityCategory(toolName);
  }
  return "computation";
};

const USER_INPUT_CHAT_TOOL_NAMES = {
  [ASK_USER_TOOL_NAME]: true,
  [REQUEST_SECRET_TOOL_NAME]: true,
  [CONNECT_CONNECTOR_TOOL_NAME]: true,
  // A blocking question a coding agent on the member's computer asks: its
  // call stays open until the member answers it from the question card.
  [CHAT_LOCAL_RUN_QUESTION_TOOL]: true,
} as const satisfies Record<string, true>;

export type UserInputChatToolName = keyof typeof USER_INPUT_CHAT_TOOL_NAMES;

/** A tool whose call waits on a person, answered from its own card. */
export const isUserInputChatToolName = (
  name: string,
): name is UserInputChatToolName =>
  Object.hasOwn(USER_INPUT_CHAT_TOOL_NAMES, name);

/**
 * Calls that read as part of the answer, each in a card of its own (a
 * question, a draft, a subagent run), never folded into the run of steps.
 */
export const isAnswerCardChatToolName = (name: string): boolean =>
  isUserInputChatToolName(name) ||
  name === CREATE_DOCUMENT_TOOL_NAME ||
  name === "spawn_subagents";

/** The shape of a stored or streamed message part these rules read. */
export type ChatActivityPart = {
  readonly type: string;
  readonly name?: unknown;
  readonly state?: unknown;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly content?: unknown;
};

/** A tool's output that says the call failed. */
export const isFailedToolOutput = (output: unknown): boolean =>
  typeof output === "object" &&
  output !== null &&
  (("error" in output && output.error !== undefined && output.error !== null) ||
    ("success" in output && output.success === false) ||
    ("isError" in output && output.isError === true));

/**
 * Whether a part belongs to a run of steps: reasoning, a tool call other
 * than an answer card, or a tool result (an invisible companion that keeps
 * the run whole). A surface with cards of its own (the web's approval
 * cards) narrows this further.
 */
export const isProcessPart = (part: ChatActivityPart): boolean => {
  if (part.type === "thinking" || part.type === "tool-result") {
    return true;
  }
  return (
    part.type === "tool-call" &&
    typeof part.name === "string" &&
    !isAnswerCardChatToolName(part.name)
  );
};

/**
 * Whether a process part shows as a step. Reasoning with no text, a tool
 * result, and a skill the model failed to load (it tries another) show
 * nothing. A finished web search or page fetch is a step too, unless the
 * surface shows it among the answer's sources instead (the web's sources
 * tray); a surface without one keeps it as a step, so it is not lost.
 */
export const isVisibleProcessStep = (
  part: ChatActivityPart,
  {
    searchesShownApart,
  }: {
    /** The surface lists finished searches and fetches as sources. */
    readonly searchesShownApart: boolean;
  },
): boolean => {
  if (part.type === "thinking") {
    return typeof part.content === "string" && part.content.trim() !== "";
  }
  if (part.type === "tool-result") {
    return false;
  }
  if (part.type !== "tool-call") {
    return true;
  }
  if (
    part.state === "error" &&
    (part.name === "load-skill" || part.name === "read-skill-resource")
  ) {
    return false;
  }
  return !(
    searchesShownApart &&
    (part.name === "web_search" || part.name === "fetch_url") &&
    part.state === "complete"
  );
};

/**
 * Where a read reaches, as a run's summary names it: a code step's reads
 * (`ScriptReadArea`), the document open beside the chat, the web, or past
 * chats. `null` is plumbing a summary does not count, such as loading a
 * skill or fetching a tool's signature.
 */
type ProcessReadArea = ScriptReadArea | "openDocument" | "web" | "chats" | null;

/** A tool this module knows whose calls are of `category`. */
type ChatToolNameOfCategory<TCategory extends ChatToolActivityCategory> = {
  [
    Name in KnownChatToolName
  ]: (typeof CHAT_TOOL_DISPLAY)[Name]["category"] extends TCategory
    ? Name
    : never;
}[KnownChatToolName];

/**
 * Where each research tool's call reaches. Total over the research tools,
 * so a new one decides how a run's summary names it before it typechecks.
 */
const RESEARCH_TOOL_READ_AREA = {
  ares_lookup_company: "registers",
  ares_search_companies: "registers",
  boe_find_related_laws: "legislation",
  boe_get_law: "legislation",
  boe_get_law_block: "legislation",
  boe_get_law_structure: "legislation",
  boe_search_legislation: "legislation",
  borme_get_summary: "registers",
  business_registry_lookup: "registers",
  compare_versions: "openDocument",
  counterparty_check: "registers",
  "describe-stella-api": null,
  "describe-stella-function": null,
  describe_template: "other",
  discover_tools: null,
  "expand-chat-history": "chats",
  fetch_url: "web",
  find_text: "openDocument",
  get_document_outline: "openDocument",
  infosoud_lookup_case: "registers",
  list_connectable_connectors: null,
  list_stories: "openDocument",
  list_templates: "other",
  "load-skill": null,
  local_browser: "web",
  "read-contact": "matters",
  "read-content-across-matters": "documents",
  read_contact: "matters",
  read_content_across_matters: "documents",
  "read-skill-resource": null,
  read_changes: "openDocument",
  read_comments: "openDocument",
  read_document: "openDocument",
  read_section: "openDocument",
  read_story: "openDocument",
  review_folder_consistency: "documents",
  "search-across-matters": "documents",
  "search-all-past-chats": "chats",
  "search-chat-history": "chats",
  "search-past-chats": "chats",
  show_in_document: null,
  "use-browser": "web",
  web_search: "web",
} as const satisfies Record<
  ChatToolNameOfCategory<"research">,
  ProcessReadArea
>;

/**
 * The phrases a settled run's summary is made of, each translated by the
 * app under its name: what the run looked through (at most two of these),
 * how many lookups that took, what it changed, and, when it did none of
 * that, how many steps it took.
 */
export const PROCESS_SUMMARY_PHRASES = [
  "searchedLegislation",
  "searchedCaseLaw",
  "searchedLegislationAndCaseLaw",
  "readDocument",
  "readDocuments",
  "searchedMatters",
  "checkedRegisters",
  "searchedWeb",
  "searchedChats",
  "sourcesChecked",
  "lookups",
  "documentEdits",
  "changesSaved",
  "steps",
] as const;
export type ProcessSummaryPhrase = (typeof PROCESS_SUMMARY_PHRASES)[number];

/** One phrase of a summary with the count its plural reads. */
export type ProcessSummaryPiece = {
  readonly phrase: ProcessSummaryPhrase;
  readonly count: number;
};

/** The area phrases, in the order a summary names them. */
const AREA_PHRASES = [
  ["openDocument", "readDocument"],
  ["documents", "readDocuments"],
  ["matters", "searchedMatters"],
  ["registers", "checkedRegisters"],
  ["web", "searchedWeb"],
  ["chats", "searchedChats"],
] as const satisfies readonly (readonly [
  Exclude<ProcessReadArea, "caseLaw" | "legislation" | "other" | null>,
  ProcessSummaryPhrase,
])[];

const MAX_SUMMARY_AREAS = 2;
/** One lookup is said by the area alone ("Searched the web"). */
const MIN_COUNTED_LOOKUPS = 2;

const legalPhrase = (
  areas: ReadonlySet<ProcessReadArea>,
): ProcessSummaryPhrase | null => {
  if (areas.has("legislation") && areas.has("caseLaw")) {
    return "searchedLegislationAndCaseLaw";
  }
  if (areas.has("legislation")) {
    return "searchedLegislation";
  }
  return areas.has("caseLaw") ? "searchedCaseLaw" : null;
};

const researchReadArea = (toolName: string): ProcessReadArea => {
  if (isOwnKey(RESEARCH_TOOL_READ_AREA, toolName)) {
    return RESEARCH_TOOL_READ_AREA[toolName];
  }
  // An external connector's read is a source of its own.
  return "other";
};

/**
 * What a settled run of steps did, in the phrases its summary reads ("Searched
 * legislation and case law · 5 lookups · 1 document edit"): where its reads
 * reached, how many lookups they took, and what it changed. Only completed
 * calls that succeeded count; a failed call is left out on purpose, since
 * the model works around it, and a code step counts each read its ledger
 * says went through. Steps that wait on a person are not work the model
 * did. A run that did none of this (reasoning alone, a coding agent's own
 * steps) reads as its `stepCount`.
 */
export const summarizeProcessRun = (
  parts: readonly ChatActivityPart[],
  { stepCount }: { readonly stepCount: number },
): readonly ProcessSummaryPiece[] => {
  const areas = new Set<ProcessReadArea>();
  let lookups = 0;
  let documentEdits = 0;
  let changesSaved = 0;
  for (const part of parts) {
    if (part.type !== "tool-call" || typeof part.name !== "string") {
      continue;
    }
    const succeeded =
      part.state === "complete" && !isFailedToolOutput(part.output);
    const code = codeStepReads({
      input: part.input,
      name: part.name,
      output: part.output,
      succeeded,
    });
    if (code !== undefined) {
      for (const area of code.areas) {
        areas.add(area);
      }
      lookups += code.lookups;
      continue;
    }
    if (!succeeded) {
      continue;
    }
    const category = getChatToolActivityCategory(part.name);
    switch (category) {
      case "research": {
        const area = researchReadArea(part.name);
        if (area !== null) {
          areas.add(area);
          lookups += 1;
        }
        break;
      }
      case "artifact":
        documentEdits += 1;
        break;
      case "mutation":
        changesSaved += 1;
        break;
      case "computation":
      case "user-input":
        break;
      default:
        category satisfies never;
        return panic("Unhandled tool category", { category });
    }
  }
  const named = [
    legalPhrase(areas),
    ...AREA_PHRASES.flatMap(([area, phrase]) =>
      areas.has(area) ? [phrase] : [],
    ),
  ]
    .filter((phrase) => phrase !== null)
    .slice(0, MAX_SUMMARY_AREAS);
  const pieces: ProcessSummaryPiece[] = named.map((phrase) => ({
    phrase,
    count: 1,
  }));
  // Reads with no area of their own (an external connector's, a template's)
  // are counted as sources when nothing else names the run.
  if (named.length === 0 && lookups > 0) {
    pieces.push({ phrase: "sourcesChecked", count: lookups });
  } else if (named.length > 0 && lookups >= MIN_COUNTED_LOOKUPS) {
    pieces.push({ phrase: "lookups", count: lookups });
  }
  if (documentEdits > 0) {
    pieces.push({ phrase: "documentEdits", count: documentEdits });
  }
  if (changesSaved > 0) {
    pieces.push({ phrase: "changesSaved", count: changesSaved });
  }
  return pieces.length > 0 ? pieces : [{ phrase: "steps", count: stepCount }];
};

export type ProcessGroup<TItem> =
  | {
      readonly kind: "process";
      readonly startIndex: number;
      readonly items: TItem[];
    }
  | { readonly kind: "standard"; readonly index: number; readonly item: TItem };

/**
 * A message's parts in order, with each run of consecutive process parts
 * gathered into one group, so a multi-step turn reads as one summary
 * between its texts instead of a line per call.
 */
export const groupProcessParts = <TItem>(
  items: readonly TItem[],
  isProcess: (item: TItem) => boolean,
): ProcessGroup<TItem>[] => {
  const groups: ProcessGroup<TItem>[] = [];
  for (const [index, item] of items.entries()) {
    if (!isProcess(item)) {
      groups.push({ kind: "standard", index, item });
      continue;
    }
    const previous = groups.at(-1);
    if (previous?.kind === "process") {
      previous.items.push(item);
      continue;
    }
    groups.push({ kind: "process", startIndex: index, items: [item] });
  }
  return groups;
};
