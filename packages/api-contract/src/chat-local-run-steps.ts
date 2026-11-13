import { panic } from "better-result";

import {
  CHAT_LOCAL_RUN_NEEDS_MEMBER,
  CHAT_LOCAL_RUN_TOOL_NAMES,
  type ChatLocalRunToolDetail,
  isChatLocalRunToolName,
  parseChatLocalRunToolCall,
} from "./chat-local-run-tool";

/**
 * How every client shows the steps a coding agent took on the member's
 * computer: what a step's row names, which steps show under a subagent's
 * step, and a subagent's one status. The web and the phone both read this,
 * so a turn groups and reads the same on each.
 *
 * The API stores only the contract's fields (`./chat-local-run-tool`), so a
 * row names the command, the file names, the search or the plan, and nothing
 * it read or wrote.
 */
export type LocalRunToolSubtitle =
  | { type: "text"; text: string }
  | { type: "search"; pattern: string; path: string }
  | { type: "command"; command: string; exitCode: number };

/** A browser step stopped at a sign-in the member completes in Chrome. */
export const LOCAL_RUN_SIGN_IN_TITLE = "sign_in";

/**
 * What a row's title names in place of its tool: the kind of step, or that
 * a browser step waits for the member to sign in. Each client reads it in
 * its own catalogue.
 */
export type LocalRunToolTitleKind =
  ChatLocalRunToolDetail["kind"] | typeof LOCAL_RUN_SIGN_IN_TITLE;

export type LocalRunToolView = {
  /** What the title names, or `null` to keep the tool's own title. */
  titleKind: LocalRunToolTitleKind | null;
  subtitle: LocalRunToolSubtitle | null;
};

const text = (value: string): LocalRunToolSubtitle | null =>
  value === "" ? null : { type: "text", text: value };

/** Whether a browser step's stored result says the member signs in. */
const needsMember = (output: unknown): boolean =>
  typeof output === "object" &&
  output !== null &&
  Reflect.get(output, "status") === CHAT_LOCAL_RUN_NEEDS_MEMBER;

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
    case "proposed_plan":
      // The plan is read whole on its approval card, not in a row.
      return null;
    case "subagent":
      return text(detail.description);
    case "image":
      return text(detail.path);
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
        titleKind: null,
        subtitle:
          exitCode === null || call.input.command === ""
            ? text(call.input.command)
            : { type: "command", command: call.input.command, exitCode },
      };
    }
    case CHAT_LOCAL_RUN_TOOL_NAMES.fileChange:
      return {
        titleKind: null,
        subtitle: text(call.input.changes.map(({ path }) => path).join(", ")),
      };
    case CHAT_LOCAL_RUN_TOOL_NAMES.webSearch:
      return { titleKind: null, subtitle: text(call.input.query) };
    case CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool: {
      const { detail, tool } = call.input;
      return detail === undefined
        ? { titleKind: null, subtitle: text(tool) }
        : {
            titleKind: detail.kind,
            subtitle: detailSubtitle(detail),
          };
    }
    case CHAT_LOCAL_RUN_TOOL_NAMES.unsupportedItem:
      return { titleKind: null, subtitle: null };
    case CHAT_LOCAL_RUN_TOOL_NAMES.browser:
      return {
        titleKind: needsMember(output) ? LOCAL_RUN_SIGN_IN_TITLE : null,
        subtitle:
          call.input.action === "open" && call.input.url !== undefined
            ? text(call.input.url)
            : null,
      };
    default:
      call satisfies never;
      return panic("Unhandled local run tool call");
  }
};

/**
 * Whether a coding agent's own step reports that it failed: its result is
 * `{ status: "failed" }` (`./chat-local-run-tool`), with no error envelope.
 */
export const localRunStepFailed = (name: string, output: unknown): boolean =>
  isChatLocalRunToolName(name) &&
  typeof output === "object" &&
  output !== null &&
  Reflect.get(output, "status") === "failed";

/** The result a coding agent's run gives a call its turn cut off. */
export const isLocalRunInterruptedOutput = (output: unknown): boolean =>
  typeof output === "object" &&
  output !== null &&
  Reflect.get(output, "status") === "interrupted";

/** What a step's details show of what it produced on the computer. */
export type LocalRunStepOutputKind = "command" | "diff";

/**
 * Whether a step produced something the member can open on the computer
 * that ran it: a command's output or a change's diff. `null` for any other
 * call, which keeps nothing there.
 */
export const localRunStepOutputKind = (
  name: string,
): LocalRunStepOutputKind | null => {
  switch (name) {
    case CHAT_LOCAL_RUN_TOOL_NAMES.commandExecution:
      return "command";
    case CHAT_LOCAL_RUN_TOOL_NAMES.fileChange:
      return "diff";
    default:
      return null;
  }
};

/**
 * The plan a coding agent proposed for the member to approve (markdown), or
 * `null` when the call is not a proposed plan.
 */
export const localRunProposedPlan = ({
  name,
  input,
}: {
  name: string;
  input: unknown;
}): string | null => {
  if (!isChatLocalRunToolName(name)) {
    return null;
  }
  const call = parseChatLocalRunToolCall(name, input);
  return call?.name === CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool &&
    call.input.detail?.kind === "proposed_plan"
    ? call.input.detail.text
    : null;
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

type LocalRunCall = { name: string; input: unknown };

const nativeCallOf = ({ name, input }: LocalRunCall) =>
  isChatLocalRunToolName(name) ? parseChatLocalRunToolCall(name, input) : null;

/**
 * What a subagent's own step names beyond its description: the kind of
 * agent the coding agent chose, or `null` when the call is not a subagent's
 * step or its harness names none.
 */
export const localRunSubagentType = (call: LocalRunCall): string | null => {
  const native = nativeCallOf(call);
  return native?.name === CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool &&
    native.input.detail?.kind === "subagent"
    ? (native.input.detail.agentType ?? null)
    : null;
};

/** A turn's tool call as the grouping reads it. */
export type LocalRunStepCall = LocalRunCall & {
  id: string;
  /** How the turn shows the call: a plain row, or a card of its own. */
  shownAs: "row" | "card";
};

type LocalRunSubagentGroups = {
  /**
   * Every step each subagent took, in the turn's order, by the id of the
   * subagent's own step. A subagent that took none has an empty list.
   */
  stepsOf: ReadonlyMap<string, readonly string[]>;
  /** The subagent a step's row shows inside, by the step's id. */
  rowIn: ReadonlyMap<string, string>;
};

/**
 * Which of a turn's calls show under a subagent's step. A subagent's step
 * that shows as a row is a group, and a step naming it (`parentCallId`) is
 * one of its steps: a row among them shows inside the group, a card (an
 * approval) stays on the turn where the member sees it without opening
 * anything. A step whose subagent is not a group (it shows as a card, or the
 * turn does not have it) stays on the turn, so no step is ever hidden. A
 * subagent started by a subagent shows in the outermost one's group, with
 * the steps it took.
 */
export const localRunSubagentGroups = (
  calls: readonly LocalRunStepCall[],
): LocalRunSubagentGroups => {
  const subagents = new Set<string>();
  const parents = new Map<string, string>();
  for (const { id, name, input, shownAs } of calls) {
    const call = nativeCallOf({ name, input });
    if (call === null) {
      continue;
    }
    if (
      shownAs === "row" &&
      call.name === CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool &&
      call.input.detail?.kind === "subagent"
    ) {
      subagents.add(id);
    }
    if (call.input.parentCallId !== undefined) {
      parents.set(id, call.input.parentCallId);
    }
  }
  const outermost = (id: string): string | null => {
    const seen = new Set([id]);
    let subagent: string | null = null;
    let parent = parents.get(id);
    // `seen` ends the walk over ids a desktop made name each other.
    while (parent !== undefined && subagents.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      subagent = parent;
      parent = parents.get(parent);
    }
    return subagent;
  };
  const stepsOf = new Map<string, string[]>();
  const rowIn = new Map<string, string>();
  const inner = new Set<string>();
  for (const { id, shownAs } of calls) {
    const subagent = outermost(id);
    if (subagent === null) {
      continue;
    }
    inner.add(id);
    const steps = stepsOf.get(subagent);
    if (steps === undefined) {
      stepsOf.set(subagent, [id]);
    } else {
      steps.push(id);
    }
    if (shownAs === "row") {
      rowIn.set(id, subagent);
    }
  }
  for (const id of subagents) {
    // A subagent inside another's group is a row there, not a group.
    if (inner.has(id)) {
      stepsOf.delete(id);
    } else if (!stepsOf.has(id)) {
      stepsOf.set(id, []);
    }
  }
  for (const [id, subagent] of rowIn) {
    // Only ids made to name each other leave a row without its group.
    if (!stepsOf.has(subagent)) {
      rowIn.delete(id);
    }
  }
  return { stepsOf, rowIn };
};

/** How a subagent's group reads, as one status. */
export type LocalRunSubagentStatus =
  "needs_approval" | "running" | "failed" | "interrupted" | "done";

/** How one step stands: the subagent's own, or one it took. */
export type LocalRunStepStanding =
  "awaiting_approval" | "running" | "failed" | "interrupted" | "done";

/**
 * A subagent's one status, from its own step and the steps it took. A step
 * waiting on the member comes first, since the subagent cannot go on without
 * them; then work still under way, its own or a step's (a harness may end
 * the call that started a subagent before the subagent ends). Once nothing
 * is under way it reads as its own step ended: a step of it that failed is
 * the subagent's to work around, not the subagent failing.
 */
export const localRunSubagentStatus = ({
  own,
  steps,
}: {
  own: LocalRunStepStanding;
  steps: readonly LocalRunStepStanding[];
}): LocalRunSubagentStatus => {
  const all = [own, ...steps];
  if (all.includes("awaiting_approval")) {
    return "needs_approval";
  }
  if (all.includes("running")) {
    return "running";
  }
  switch (own) {
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "done":
      return "done";
    case "awaiting_approval":
    case "running":
      return panic("A subagent with open work was read as settled");
    default:
      own satisfies never;
      return panic("Unhandled local run step standing");
  }
};
