import { Result } from "better-result";
import * as v from "valibot";

import { CHAT_LOCAL_RUN_CALL_ID_MAX_LENGTH } from "./chat-local-run-step-output";

/**
 * A step a coding agent took itself on the member's computer (a command, a
 * file it read or changed, a search, a plan), as a chat turn keeps it. Only
 * what the step was about leaves the computer: a command line, file names, a
 * search query or web address, the titles of a plan, a plan the agent
 * proposes for the member to approve, in its own words, the short description
 * and agent type of a subagent it started, and the name of an image it
 * viewed. Its result says only how it ended: a status, a command's exit
 * code, the files a change touched. A command's output, a file's contents, a
 * diff, search matches, a fetched page, a subagent's prompt, messages and
 * report, and an image's bytes are never part of the call or its result.
 *
 * A call a subagent made, a native step or a tool of a connected server,
 * names the subagent's own step, so chat shows it under that step. The link
 * is part of the call's metadata (`CHAT_LOCAL_RUN_PARENT_CALL_METADATA_KEY`),
 * never of its input: a tool's input is the tool's own, and a call of any
 * kind is linked the same way.
 *
 * The desktop's harness sidecar builds each call and result through these
 * schemas, and the API parses what a desktop sends with them again and keeps
 * only their output, so a desktop that sends more (or longer) fields stores
 * nothing extra. Parsing is idempotent: what the sidecar sends is what the
 * API stores.
 */

/** Tool names a harness-native step is persisted under. */
export const CHAT_LOCAL_RUN_TOOL_NAMES = {
  commandExecution: "command_execution",
  fileChange: "file_change",
  webSearch: "harness_web_search",
  nativeTool: "harness_native_tool",
  unsupportedItem: "harness_unsupported_item",
  /** A step in the member's Chrome, through stella desktop and the extension. */
  browser: "local_browser",
} as const;
export type ChatLocalRunToolName =
  (typeof CHAT_LOCAL_RUN_TOOL_NAMES)[keyof typeof CHAT_LOCAL_RUN_TOOL_NAMES];

const TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(CHAT_LOCAL_RUN_TOOL_NAMES),
);

export const isChatLocalRunToolName = (
  name: string,
): name is ChatLocalRunToolName => TOOL_NAMES.has(name);

/** The most of each field a call keeps, in UTF-16 code units or entries. */
export const CHAT_LOCAL_RUN_TOOL_LIMITS = {
  command: 300,
  path: 1024,
  files: 50,
  query: 500,
  url: 2048,
  planItems: 50,
  planItem: 200,
  /** A plan the agent proposes, whole: the member approves what it says. */
  proposedPlan: 20_000,
  name: 128,
  /** A harness's reason for an approval, and the approval's whole message. */
  approval: 300,
  /** What a subagent was started for, in the agent's few words. */
  description: 200,
} as const;

const ELLIPSIS = "…";
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/u;

/** The start of `text`, within `limit` once an ellipsis ends it. */
const cutWithEllipsis = (text: string, limit: number): string => {
  let kept = text.slice(0, Math.min(text.length, limit - ELLIPSIS.length));
  // Never half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/u.test(kept)) {
    kept = kept.slice(0, -1);
  }
  return `${kept}${ELLIPSIS}`;
};

/**
 * `text` as a call shows it: its first line, within `limit`, ending in an
 * ellipsis when anything was left out. A command whose later lines carry a
 * file's contents (a heredoc, an `echo` of text) shows only the line that
 * runs it.
 */
export const chatLocalRunShownText = (text: string, limit: number): string => {
  const trimmed = text.trimStart();
  const [first = ""] = trimmed.split(LINE_BREAK, 1);
  const cut = first.length < trimmed.length;
  return !cut && first.length <= limit ? first : cutWithEllipsis(first, limit);
};

/**
 * `text` within `limit`, every line kept, ending in an ellipsis when
 * anything was left out.
 */
const boundedText = (text: string, limit: number): string =>
  text.length <= limit ? text : cutWithEllipsis(text, limit);

const shownText = (limit: number) =>
  v.pipe(
    v.string(),
    v.transform((text) => chatLocalRunShownText(text, limit)),
  );

const shownList = <TItem extends v.GenericSchema>(item: TItem, max: number) =>
  v.pipe(
    v.array(item),
    v.transform((items) => items.slice(0, max)),
  );

/**
 * Where a call of a local run names the subagent step that made it: a key of
 * the call's metadata, beside who ran the call. A desktop sends the
 * harness's own id of that step on the call's start; the API keeps the
 * step's chat call id there instead, as it keeps the step itself.
 */
export const CHAT_LOCAL_RUN_PARENT_CALL_METADATA_KEY =
  "stellaLocalRunParentCall";

/**
 * The id of the subagent step that made a call. An id is never cut: one that
 * is empty or longer than a chat call id names no step.
 */
const parentCallIdSchema = v.pipe(
  v.string(),
  v.nonEmpty(),
  v.maxLength(CHAT_LOCAL_RUN_CALL_ID_MAX_LENGTH),
);

/**
 * The subagent step a call's metadata names, or `null` when it names none
 * (a call on the main thread, another kind of call, an id that names no
 * step). The call is kept either way.
 */
export const chatLocalRunParentCallId = (metadata: unknown): string | null => {
  if (typeof metadata !== "object" || metadata === null) {
    return null;
  }
  const parsed = v.safeParse(
    parentCallIdSchema,
    Reflect.get(metadata, CHAT_LOCAL_RUN_PARENT_CALL_METADATA_KEY),
  );
  return parsed.success ? parsed.output : null;
};

export const CHAT_LOCAL_RUN_FILE_CHANGE_KINDS = [
  "add",
  "delete",
  "update",
] as const;

/**
 * What a native step other than a command, a file change or a web search
 * was about, for the kinds chat can name: a file it read, a search over
 * files, a web address it fetched, the titles of its plan, the plan it
 * proposes before it acts (markdown, asked about as an approval), a subagent
 * it started (the few words it gave for the task and the kind of agent,
 * never the prompt), and an image it viewed (the file's name).
 */
export const chatLocalRunToolDetailSchema = v.variant("kind", [
  v.object({
    kind: v.literal("read"),
    path: shownText(CHAT_LOCAL_RUN_TOOL_LIMITS.path),
  }),
  v.object({
    kind: v.literal("search"),
    pattern: shownText(CHAT_LOCAL_RUN_TOOL_LIMITS.query),
    path: v.optional(shownText(CHAT_LOCAL_RUN_TOOL_LIMITS.path)),
  }),
  v.object({
    kind: v.literal("fetch"),
    url: shownText(CHAT_LOCAL_RUN_TOOL_LIMITS.url),
  }),
  v.object({
    kind: v.literal("plan"),
    items: shownList(
      shownText(CHAT_LOCAL_RUN_TOOL_LIMITS.planItem),
      CHAT_LOCAL_RUN_TOOL_LIMITS.planItems,
    ),
  }),
  v.object({
    kind: v.literal("proposed_plan"),
    text: v.pipe(
      v.string(),
      v.transform((text) =>
        boundedText(text, CHAT_LOCAL_RUN_TOOL_LIMITS.proposedPlan),
      ),
    ),
  }),
  v.object({
    kind: v.literal("subagent"),
    description: shownText(CHAT_LOCAL_RUN_TOOL_LIMITS.description),
    agentType: v.optional(shownText(CHAT_LOCAL_RUN_TOOL_LIMITS.name)),
  }),
  v.object({
    kind: v.literal("image"),
    path: shownText(CHAT_LOCAL_RUN_TOOL_LIMITS.path),
  }),
]);
export type ChatLocalRunToolDetail = v.InferOutput<
  typeof chatLocalRunToolDetailSchema
>;

/** The files one change touched, by name and kind of change. */
const fileChangesSchema = shownList(
  v.object({
    path: shownText(CHAT_LOCAL_RUN_TOOL_LIMITS.path),
    kind: v.picklist(CHAT_LOCAL_RUN_FILE_CHANGE_KINDS),
  }),
  CHAT_LOCAL_RUN_TOOL_LIMITS.files,
);

/**
 * What a coding agent did in the member's Chrome. The page it read, the
 * element it clicked and the text it typed stay on the computer; only the
 * kind of step and, for `open`, the address it opened are kept.
 */
export const CHAT_LOCAL_RUN_BROWSER_ACTIONS = [
  "open",
  "snapshot",
  "find",
  "click",
  "type",
] as const;

export type ChatLocalRunBrowserAction =
  (typeof CHAT_LOCAL_RUN_BROWSER_ACTIONS)[number];

const BROWSER_ACTIONS: ReadonlySet<string> = new Set(
  CHAT_LOCAL_RUN_BROWSER_ACTIONS,
);

export const isChatLocalRunBrowserAction = (
  name: string,
): name is ChatLocalRunBrowserAction => BROWSER_ACTIONS.has(name);

/** A browser step that stopped at a sign-in the member completes. */
export const CHAT_LOCAL_RUN_NEEDS_MEMBER = "needs_member" as const;

/** A harness-native step: its tool name and the input chat keeps for it. */
export const chatLocalRunToolCallSchema = v.variant("name", [
  v.object({
    name: v.literal(CHAT_LOCAL_RUN_TOOL_NAMES.commandExecution),
    input: v.object({
      command: shownText(CHAT_LOCAL_RUN_TOOL_LIMITS.command),
    }),
  }),
  v.object({
    name: v.literal(CHAT_LOCAL_RUN_TOOL_NAMES.fileChange),
    input: v.object({ changes: fileChangesSchema }),
  }),
  v.object({
    name: v.literal(CHAT_LOCAL_RUN_TOOL_NAMES.webSearch),
    input: v.object({
      query: shownText(CHAT_LOCAL_RUN_TOOL_LIMITS.query),
    }),
  }),
  v.object({
    name: v.literal(CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool),
    input: v.object({
      /** The harness's own name for the tool. */
      tool: shownText(CHAT_LOCAL_RUN_TOOL_LIMITS.name),
      detail: v.optional(chatLocalRunToolDetailSchema),
    }),
  }),
  v.object({
    name: v.literal(CHAT_LOCAL_RUN_TOOL_NAMES.unsupportedItem),
    input: v.object({
      itemType: shownText(CHAT_LOCAL_RUN_TOOL_LIMITS.name),
    }),
  }),
  v.object({
    name: v.literal(CHAT_LOCAL_RUN_TOOL_NAMES.browser),
    // Only `open` keeps an address: the one the agent chose. Any other
    // step keeps its kind alone, whatever else it carries.
    input: v.union([
      v.object({
        action: v.literal("open"),
        url: v.optional(shownText(CHAT_LOCAL_RUN_TOOL_LIMITS.url)),
      }),
      v.object({
        action: v.picklist(
          CHAT_LOCAL_RUN_BROWSER_ACTIONS.filter(
            (action): action is Exclude<ChatLocalRunBrowserAction, "open"> =>
              action !== "open",
          ),
        ),
      }),
    ]),
  }),
]);
export type ChatLocalRunToolCall = v.InferOutput<
  typeof chatLocalRunToolCallSchema
>;
/** What an adapter builds a call from, before it is bounded. */
export type ChatLocalRunToolCallInput = v.InferInput<
  typeof chatLocalRunToolCallSchema
>;

/**
 * The call chat keeps for a harness-native step, or `null` when `input` is
 * not one. A native tool whose detail does not parse keeps its name.
 */
export const parseChatLocalRunToolCall = (
  name: ChatLocalRunToolName,
  input: unknown,
): ChatLocalRunToolCall | null => {
  const parsed = v.safeParse(chatLocalRunToolCallSchema, { name, input });
  if (parsed.success) {
    return parsed.output;
  }
  if (
    name !== CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool ||
    typeof input !== "object" ||
    input === null ||
    !("tool" in input)
  ) {
    return null;
  }
  const named = v.safeParse(chatLocalRunToolCallSchema, {
    name,
    input: { tool: input.tool },
  });
  return named.success ? named.output : null;
};

/**
 * How a step ended, in the harness's words: `declined` when the member
 * refused it, `interrupted` when its turn ended first.
 */
export const CHAT_LOCAL_RUN_TOOL_STATUSES = [
  "completed",
  "failed",
  "declined",
  "in_progress",
  "interrupted",
] as const;

export type ChatLocalRunToolStatus =
  (typeof CHAT_LOCAL_RUN_TOOL_STATUSES)[number];

const statusSchema = v.picklist(CHAT_LOCAL_RUN_TOOL_STATUSES);
const statusOnly = v.object({ status: statusSchema });

/** A harness-native step's result: how it ended, never what it produced. */
export const chatLocalRunToolResultSchema = v.variant("name", [
  v.object({
    name: v.literal(CHAT_LOCAL_RUN_TOOL_NAMES.commandExecution),
    // The cloud translator's field order, so a local turn reads as one.
    result: v.object({
      exit_code: v.optional(v.pipe(v.number(), v.safeInteger())),
      status: statusSchema,
    }),
  }),
  v.object({
    name: v.literal(CHAT_LOCAL_RUN_TOOL_NAMES.fileChange),
    result: v.object({ changes: fileChangesSchema, status: statusSchema }),
  }),
  v.object({
    name: v.literal(CHAT_LOCAL_RUN_TOOL_NAMES.webSearch),
    result: statusOnly,
  }),
  v.object({
    name: v.literal(CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool),
    result: statusOnly,
  }),
  v.object({
    name: v.literal(CHAT_LOCAL_RUN_TOOL_NAMES.unsupportedItem),
    result: statusOnly,
  }),
  v.object({
    name: v.literal(CHAT_LOCAL_RUN_TOOL_NAMES.browser),
    result: v.object({
      status: v.picklist([
        ...CHAT_LOCAL_RUN_TOOL_STATUSES,
        CHAT_LOCAL_RUN_NEEDS_MEMBER,
      ]),
    }),
  }),
]);
export type ChatLocalRunToolResult = v.InferOutput<
  typeof chatLocalRunToolResultSchema
>;
/** What an adapter builds a result from, before it is bounded. */
export type ChatLocalRunToolResultInput = v.InferInput<
  typeof chatLocalRunToolResultSchema
>;

/** The JSON of a result an adapter built, as chat keeps it. */
export const chatLocalRunToolResultContent = (
  result: ChatLocalRunToolResultInput,
): string =>
  JSON.stringify(v.parse(chatLocalRunToolResultSchema, result).result);

const parsedJson = (text: string): unknown => {
  const parsed = Result.try((): unknown => JSON.parse(text));
  return parsed.isOk() ? parsed.value : undefined;
};

/**
 * The result chat keeps for a harness-native step named `name`, from the
 * content a harness reported, or `null` when the content is not one.
 */
export const parseChatLocalRunToolResult = (
  name: ChatLocalRunToolName,
  content: string,
): ChatLocalRunToolResult | null => {
  const parsed = v.safeParse(chatLocalRunToolResultSchema, {
    name,
    result: parsedJson(content),
  });
  return parsed.success ? parsed.output : null;
};

/**
 * What a result keeps when its content is not the step's result: whether
 * the step failed, never the text itself.
 */
export const chatLocalRunToolStatusContent = (failed: boolean): string =>
  JSON.stringify({ status: failed ? "failed" : "completed" });

/** The result content chat keeps for a harness-native step named `name`. */
export const shownChatLocalRunToolResult = (
  name: ChatLocalRunToolName,
  content: string,
  failed: boolean,
): string => {
  const parsed = parseChatLocalRunToolResult(name, content);
  return parsed === null
    ? chatLocalRunToolStatusContent(failed)
    : JSON.stringify(parsed.result);
};

/**
 * Why a local run paused, as its interrupt says it: an approval pauses on a
 * tool call, a blocking question on the member's input. A pause states
 * nothing else there.
 */
export const CHAT_LOCAL_RUN_INTERRUPT_REASONS = {
  approval: "tool_call",
  question: "user_input",
} as const;

/**
 * A harness's reason for asking an approval, as chat shows it: one line,
 * bounded, or `null` without one.
 */
export const chatLocalRunApprovalReason = (reason: unknown): string | null =>
  typeof reason === "string" && reason.trim() !== ""
    ? chatLocalRunShownText(reason, CHAT_LOCAL_RUN_TOOL_LIMITS.approval)
    : null;

/**
 * What an approval asks the member to allow, built from what chat keeps of
 * the call: a command names its shown command line (as t3code, MIT, shows
 * command approvals), anything else the harness's shown `reason`, or its
 * tool. The desktop's summary and the chat's interrupt both read this, so
 * neither carries more of a step than its call does.
 */
export const chatLocalRunApprovalMessage = ({
  toolName,
  input,
  reason,
}: {
  toolName: string | null;
  input: unknown;
  reason: string | null;
}): string => {
  if (toolName === CHAT_LOCAL_RUN_TOOL_NAMES.commandExecution) {
    const call = parseChatLocalRunToolCall(toolName, input);
    if (
      call?.name === CHAT_LOCAL_RUN_TOOL_NAMES.commandExecution &&
      call.input.command !== ""
    ) {
      return call.input.command;
    }
  }
  const shownReason = chatLocalRunApprovalReason(reason);
  if (shownReason !== null) {
    return shownReason;
  }
  return chatLocalRunShownText(
    toolName === null
      ? "Approval required"
      : `Approval required to run ${toolName}`,
    CHAT_LOCAL_RUN_TOOL_LIMITS.approval,
  );
};
