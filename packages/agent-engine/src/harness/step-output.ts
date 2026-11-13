import path from "node:path";

import {
  CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES,
  type ChatLocalRunConversationEntry,
  chatLocalRunConversationText,
} from "@stll/api-contract/chat-local-run-step-output";
import { isPathInside, repoRelativePath } from "@stll/portable-path";

/**
 * What a native step produced that the member may open on this computer: a
 * command's output, the diff of each file a change wrote, a subagent's own
 * conversation (what it was told, wrote and reported), or the image file a
 * step viewed. It stays here: the sidecar keeps it in the store `run.start`
 * names (`sidecar/step-outputs.ts`) and the desktop serves it to a page on
 * this computer. It is never part of what a turn reports.
 */
export type HarnessStepOutput =
  | { type: "command"; output: string }
  | { type: "diff"; files: readonly HarnessFileDiff[] }
  | HarnessConversation
  | { type: "image"; path: string };

/**
 * A subagent's conversation, as much of it as was held: `droppedBytes` is
 * what it wrote past the bound, counted so the step says how much there was.
 */
type HarnessConversation = {
  type: "conversation";
  entries: readonly ChatLocalRunConversationEntry[];
  droppedBytes: number;
};

export type HarnessFileDiff = { path: string; diff: string };

const LINE_BREAK = /\r\n|\n/u;

const prefixed = (text: string, mark: "+" | "-") =>
  text === ""
    ? ""
    : text
        .replace(/\r?\n$/u, "")
        .split(LINE_BREAK)
        .map((line) => `${mark}${line}`)
        .join("\n");

/** A file's whole text as added (`+`) or removed (`-`) lines. */
export const wholeFileDiff = (text: string, change: "add" | "delete") =>
  prefixed(text, change === "add" ? "+" : "-");

/** One replacement in a file: what it removed, then what it put in its place. */
export const replacementDiff = (removed: string, added: string) =>
  ["@@", prefixed(removed, "-"), prefixed(added, "+")]
    .filter((part) => part !== "")
    .join("\n");

/**
 * `file` relative to the run's folder, with `/` between its parts, when it is
 * inside the folder; else as given.
 */
export const runRelativePath = (file: string, workspaceDir: string) => {
  if (!path.isAbsolute(file) || !isPathInside(workspaceDir, file)) {
    return file;
  }
  const relative = repoRelativePath(workspaceDir, file);
  return relative === "" ? "." : relative;
};

const isContinuationByte = (byte: number | undefined) =>
  byte !== undefined && byte >= 0x80 && byte < 0xc0;

/** At most `max` bytes of UTF-8 `bytes`, never half of a character. */
export const utf8Prefix = (bytes: Uint8Array, max: number) => {
  if (bytes.length <= max) {
    return bytes;
  }
  let end = max;
  while (end > 0 && isContinuationByte(bytes[end])) {
    end -= 1;
  }
  return bytes.subarray(0, end);
};

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/**
 * The most of what a subagent was told, and of what it reported, that its
 * conversation keeps: a share of what a step keeps, so both always fit and
 * neither is the line the cap cuts.
 */
const CONVERSATION_END_MAX_BYTES = CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES / 4;

/** `text` within `max` bytes, whole characters, and how much was left out. */
const boundedText = (text: string, max: number) => {
  const bytes = new TextEncoder().encode(text);
  const kept = utf8Prefix(bytes, max);
  return {
    text: kept.length === bytes.length ? text : new TextDecoder().decode(kept),
    droppedBytes: bytes.length - kept.length,
  };
};

/**
 * What a subagent was told, wrote and reported, held while it works so its
 * step can keep it once it ends. Bounded: past the most a step keeps
 * (`CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES`), what it writes is counted and
 * not held, so a long-running subagent holds no more than its step may keep.
 */
export class SubagentConversation {
  private readonly messages: string[] = [];
  private heldBytes = 0;
  private droppedBytes = 0;

  /** One thing the subagent wrote while it worked. */
  add(text: string) {
    if (text === "") {
      return;
    }
    const bytes = utf8Length(text);
    if (this.heldBytes + bytes > CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES) {
      this.droppedBytes += bytes;
      return;
    }
    this.heldBytes += bytes;
    this.messages.push(text);
  }

  /**
   * The conversation as its step keeps it: the prompt and the report first,
   * each within its share of the cap, so the kept text's cap cuts what was
   * written in between, never what the subagent was asked or what it
   * answered.
   */
  ended({
    prompt,
    report,
  }: {
    prompt: string | null;
    report: string | null;
  }): HarnessConversation {
    const told = boundedText(prompt ?? "", CONVERSATION_END_MAX_BYTES);
    const reported = boundedText(report ?? "", CONVERSATION_END_MAX_BYTES);
    const said = (
      role: "prompt" | "report",
      text: string,
    ): ChatLocalRunConversationEntry[] => (text === "" ? [] : [{ role, text }]);
    const written = this.messages.map(
      (text): ChatLocalRunConversationEntry => ({ role: "message", text }),
    );
    return {
      type: "conversation",
      entries: [
        ...said("prompt", told.text),
        ...said("report", reported.text),
        ...written,
      ],
      droppedBytes:
        this.droppedBytes + told.droppedBytes + reported.droppedBytes,
    };
  }
}

/** The step outputs kept as text. */
type HarnessTextOutput = Exclude<HarnessStepOutput, { type: "image" }>;

/**
 * The text a step's output is kept as: a command's output as it came, a
 * change as one diff, each file under a `---`/`+++` header naming it
 * relative to the run's folder, and a subagent's conversation as a line of
 * JSON per entry (`chatLocalRunConversationText`).
 */
export const stepOutputText = (
  output: HarnessTextOutput,
  workspaceDir: string,
): string => {
  if (output.type === "command") {
    return output.output;
  }
  if (output.type === "conversation") {
    return chatLocalRunConversationText(output.entries);
  }
  return output.files
    .map(({ path: file, diff }) => {
      const shown = runRelativePath(file, workspaceDir);
      const body = diff.endsWith("\n") || diff === "" ? diff : `${diff}\n`;
      return `--- ${shown}\n+++ ${shown}\n${body}`;
    })
    .join("");
};
