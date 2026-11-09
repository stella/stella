import * as v from "valibot";

/**
 * A step a coding agent took itself on the member's computer (a command, a
 * file it read or changed, a search, a plan), as a chat turn keeps it. Only
 * what the step was about leaves the computer: a command line, file names, a
 * search query or web address, and the titles of a plan. A command's output,
 * a file's contents, a diff and a fetched page are never part of the call.
 *
 * The desktop's harness sidecar builds each call through this schema, and the
 * API parses what a desktop sends with it again and keeps only its output, so
 * a desktop that sends more (or longer) fields stores nothing extra. Parsing
 * is idempotent: what the sidecar sends is what the API stores.
 */

/** Tool names a harness-native step is persisted under. */
export const CHAT_LOCAL_RUN_TOOL_NAMES = {
  commandExecution: "command_execution",
  fileChange: "file_change",
  webSearch: "harness_web_search",
  nativeTool: "harness_native_tool",
  unsupportedItem: "harness_unsupported_item",
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
  name: 128,
} as const;

const ELLIPSIS = "…";
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/u;

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
  if (!cut && first.length <= limit) {
    return first;
  }
  let kept = first.slice(0, Math.min(first.length, limit - ELLIPSIS.length));
  // Never half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/u.test(kept)) {
    kept = kept.slice(0, -1);
  }
  return `${kept}${ELLIPSIS}`;
};

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

export const CHAT_LOCAL_RUN_FILE_CHANGE_KINDS = [
  "add",
  "delete",
  "update",
] as const;

/**
 * What a native step other than a command, a file change or a web search
 * was about, for the kinds chat can name: a file it read, a search over
 * files, a web address it fetched, and the titles of its plan.
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
]);
export type ChatLocalRunToolDetail = v.InferOutput<
  typeof chatLocalRunToolDetailSchema
>;

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
    input: v.object({
      changes: shownList(
        v.object({
          path: shownText(CHAT_LOCAL_RUN_TOOL_LIMITS.path),
          kind: v.picklist(CHAT_LOCAL_RUN_FILE_CHANGE_KINDS),
        }),
        CHAT_LOCAL_RUN_TOOL_LIMITS.files,
      ),
    }),
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
