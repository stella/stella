import { panic } from "better-result";

import {
  CHAT_LOCAL_RUN_TOOL_NAMES,
  type ChatLocalRunToolDetail,
  isChatLocalRunToolName,
  parseChatLocalRunToolCall,
} from "@stll/api-contract/chat-local-run-tool";

import type { TranslationKey } from "@/i18n/types";

/**
 * What a tool-call row shows for a step a coding agent took on the member's
 * computer: the API stores only the contract's fields
 * (`@stll/api-contract/chat-local-run-tool`), so the row names the command,
 * the file names, the search or the plan, and nothing it read or wrote.
 */
export type LocalRunToolSubtitle =
  | { type: "text"; text: string }
  | { type: "search"; pattern: string; path: string }
  | { type: "command"; command: string; exitCode: number };

export type LocalRunToolView = {
  /** A title naming the step's kind, or `null` to keep the tool's title. */
  titleKey: TranslationKey | null;
  subtitle: LocalRunToolSubtitle | null;
};

const DETAIL_TITLE_KEYS = {
  read: "chat.toolCall.readFile",
  search: "chat.toolCall.searchFiles",
  fetch: "chat.tool.fetch_url",
  plan: "chat.toolCall.updatePlan",
} as const satisfies Record<ChatLocalRunToolDetail["kind"], TranslationKey>;

const text = (value: string): LocalRunToolSubtitle | null =>
  value === "" ? null : { type: "text", text: value };

/** A failed command's exit code, from the result the harness reported. */
const exitCodeOf = (output: unknown): number | null => {
  if (typeof output !== "object" || output === null) {
    return null;
  }
  const code: unknown = Reflect.get(output, "exit_code");
  return typeof code === "number" && Number.isInteger(code) && code !== 0
    ? code
    : null;
};

const detailSubtitle = (
  detail: ChatLocalRunToolDetail,
): LocalRunToolSubtitle | null => {
  switch (detail.kind) {
    case "read":
      return text(detail.path);
    case "search":
      return detail.path === undefined || detail.path === ""
        ? text(detail.pattern)
        : { type: "search", pattern: detail.pattern, path: detail.path };
    case "fetch":
      return text(detail.url);
    case "plan":
      return text(detail.items.join(", "));
    default:
      detail satisfies never;
      return panic("Unhandled local run tool detail");
  }
};

/**
 * The row of a harness-native step, or `null` for any other call (a stella
 * or connector tool) and for a step whose stored input is not the contract's.
 */
export const localRunToolView = ({
  name,
  input,
  output,
}: {
  name: string;
  input: unknown;
  output: unknown;
}): LocalRunToolView | null => {
  if (!isChatLocalRunToolName(name)) {
    return null;
  }
  const call = parseChatLocalRunToolCall(name, input);
  if (call === null) {
    return null;
  }
  switch (call.name) {
    case CHAT_LOCAL_RUN_TOOL_NAMES.commandExecution: {
      const exitCode = exitCodeOf(output);
      return {
        titleKey: null,
        subtitle:
          exitCode === null || call.input.command === ""
            ? text(call.input.command)
            : { type: "command", command: call.input.command, exitCode },
      };
    }
    case CHAT_LOCAL_RUN_TOOL_NAMES.fileChange:
      return {
        titleKey: null,
        subtitle: text(call.input.changes.map(({ path }) => path).join(", ")),
      };
    case CHAT_LOCAL_RUN_TOOL_NAMES.webSearch:
      return { titleKey: null, subtitle: text(call.input.query) };
    case CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool: {
      const { detail, tool } = call.input;
      return detail === undefined
        ? { titleKey: null, subtitle: text(tool) }
        : {
            titleKey: DETAIL_TITLE_KEYS[detail.kind],
            subtitle: detailSubtitle(detail),
          };
    }
    case CHAT_LOCAL_RUN_TOOL_NAMES.unsupportedItem:
      return { titleKey: null, subtitle: null };
    default:
      call satisfies never;
      return panic("Unhandled local run tool call");
  }
};

/**
 * A subtitle as the row shows it. The two sentences that place a value in a
 * phrase are translated at the call site and passed in.
 */
export const localRunToolSubtitleText = (
  subtitle: LocalRunToolSubtitle | null,
  phrases: {
    patternInPath: (values: { pattern: string; path: string }) => string;
    commandExited: (values: { command: string; code: string }) => string;
  },
): string | null => {
  if (subtitle === null) {
    return null;
  }
  switch (subtitle.type) {
    case "text":
      return subtitle.text;
    case "search":
      return phrases.patternInPath({
        pattern: subtitle.pattern,
        path: subtitle.path,
      });
    case "command":
      return phrases.commandExited({
        command: subtitle.command,
        code: String(subtitle.exitCode),
      });
    default:
      subtitle satisfies never;
      return panic("Unhandled local run tool subtitle");
  }
};
