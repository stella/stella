import {
  CHAT_LOCAL_RUN_STEP_CONTENT_STATE,
  type ChatLocalRunStepContent,
} from "./chat-local-run-step-content";
import {
  CHAT_LOCAL_RUN_CONVERSATION_ROLES,
  parseChatLocalRunConversation,
} from "./chat-local-run-step-output";

/**
 * A coding agent's step content (`./chat-local-run-step-content`) as the web
 * and the phone both show it: the answers of its windowed read folded into
 * one view, a subagent's conversation in reading order, a diff's lines by
 * tone.
 */

/** A stored step's text, as one read answers a window of it. */
type StoredText = Extract<
  ChatLocalRunStepContent,
  { state: "stored"; text: string }
>;

/**
 * `unread`: nothing answered yet. `text`: the text read so far, of
 * `storedBytes` stored and `totalBytes` the step produced. Every other view
 * is the API's answer as it came: an image, or why nothing is shown.
 */
export type LocalRunStepOutputView =
  | { status: "unread" }
  | {
      status: "text";
      kind: StoredText["kind"];
      text: string;
      readBytes: number;
      storedBytes: number;
      totalBytes: number;
    }
  | {
      status: "answered";
      content: Exclude<ChatLocalRunStepContent, StoredText>;
    };

export const LOCAL_RUN_STEP_OUTPUT_UNREAD: LocalRunStepOutputView = {
  status: "unread",
};

const isStoredText = (
  content: ChatLocalRunStepContent,
): content is StoredText =>
  content.state === CHAT_LOCAL_RUN_STEP_CONTENT_STATE.stored &&
  content.kind !== "image";

/**
 * The view after one more answer. A window that starts where the text read
 * so far ends continues it; any other answer replaces the view.
 */
export const foldLocalRunStepOutput = (
  view: LocalRunStepOutputView,
  content: ChatLocalRunStepContent,
): LocalRunStepOutputView => {
  if (!isStoredText(content)) {
    return { status: "answered", content };
  }
  const bytes = new TextEncoder().encode(content.text).byteLength;
  const continues = view.status === "text" && content.start === view.readBytes;
  return {
    status: "text",
    kind: content.kind,
    text: continues ? `${view.text}${content.text}` : content.text,
    readBytes: content.start + bytes,
    storedBytes: content.storedBytes,
    totalBytes: content.totalBytes,
  };
};

/**
 * A subagent's kept conversation in the order it reads: what it was told,
 * what it wrote while it worked, then what it reported. The computer keeps
 * the report ahead of what was written, so the cap never cuts it. Each entry
 * carries a key that holds while more text arrives: its place as kept.
 */
export const localRunConversationEntries = (text: string) => {
  const kept = parseChatLocalRunConversation(text).map((entry, index) => ({
    ...entry,
    key: index,
  }));
  return CHAT_LOCAL_RUN_CONVERSATION_ROLES.flatMap((role) =>
    kept.filter((entry) => entry.role === role),
  );
};

export type DiffLineTone = "file" | "hunk" | "added" | "removed" | "context";

/** How a line of a kept diff reads: a file header, a hunk, or a changed line. */
export const diffLineTone = (line: string): DiffLineTone => {
  if (line.startsWith("--- ") || line.startsWith("+++ ")) {
    return "file";
  }
  if (line.startsWith("@@")) {
    return "hunk";
  }
  if (line.startsWith("+")) {
    return "added";
  }
  return line.startsWith("-") ? "removed" : "context";
};

/** The most diff lines shown one by one, each in its tone. */
export const DIFF_TONED_LINES = 2000;

/**
 * A diff's lines to show one by one, each in its tone and with a key that
 * stays the same while more text arrives after it (where the line starts),
 * and the text past them, shown as one plain block: a long diff (up to the
 * 1 MiB cap) stays readable and copyable without one element per line.
 */
export const diffLines = (text: string) => {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines: { key: number; line: string; tone: DiffLineTone }[] = [];
  let start = 0;
  while (lines.length < DIFF_TONED_LINES && start <= body.length) {
    const end = body.indexOf("\n", start);
    const line = end === -1 ? body.slice(start) : body.slice(start, end);
    lines.push({ key: start, line, tone: diffLineTone(line) });
    if (end === -1) {
      return { lines, rest: "" };
    }
    start = end + 1;
  }
  return { lines, rest: body.slice(start) };
};
