import { panic } from "better-result";

import {
  CHAT_LOCAL_RUN_CONVERSATION_ROLES,
  CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES,
  type ChatLocalRunImageType,
  chatLocalRunImageType,
  parseChatLocalRunConversation,
} from "@stll/api-contract/chat-local-run-step-output";

/**
 * What a coding agent's step produced on the member's computer (a command's
 * output, a change's diff), as the step's row shows it. The page reads it
 * from stella desktop on this computer (`local-run-step-output.ts`); it never
 * passes through the API.
 */

/** What reading a step's output reports, in order. */
export type LocalRunStepOutputEvent =
  | { type: "elsewhere" }
  | { type: "not-kept" }
  | { type: "started"; totalBytes: number }
  | { type: "text"; text: string; bytes: number };

/**
 * `elsewhere`: this computer does not hold the run, or no stella desktop
 * answers here. `not-kept`: the run is here but kept nothing for the step.
 * `shown`: the text read so far, of `totalBytes` the step produced.
 */
export type LocalRunStepOutputView =
  | { status: "elsewhere" }
  | { status: "not-kept" }
  | { status: "shown"; text: string; keptBytes: number; totalBytes: number };

/**
 * How long a read output stays fresh: for good once the desktop answered (a
 * finished step's output never changes), not at all when the run was found
 * elsewhere, since stella desktop may have started since.
 */
export const localRunStepOutputStaleTime = (
  output: LocalRunStepOutputView | LocalRunStepImageView | undefined,
): number => (output?.status === "elsewhere" ? 0 : Number.POSITIVE_INFINITY);

export const LOCAL_RUN_STEP_OUTPUT_UNREAD: LocalRunStepOutputView = {
  status: "shown",
  text: "",
  keptBytes: 0,
  totalBytes: 0,
};

/** The row's view after one more event. */
export const foldLocalRunStepOutput = (
  view: LocalRunStepOutputView,
  event: LocalRunStepOutputEvent,
): LocalRunStepOutputView => {
  switch (event.type) {
    case "elsewhere":
      return { status: "elsewhere" };
    case "not-kept":
      return { status: "not-kept" };
    case "started":
      return {
        status: "shown",
        text: "",
        keptBytes: 0,
        totalBytes: event.totalBytes,
      };
    case "text":
      return view.status === "shown"
        ? {
            status: "shown",
            text: `${view.text}${event.text}`,
            keptBytes: view.keptBytes + event.bytes,
            totalBytes: view.totalBytes,
          }
        : view;
    default:
      event satisfies never;
      return panic("Unhandled step output event");
  }
};

/** Whether the step produced more than the computer keeps of it. */
export const isLocalRunStepOutputCut = (totalBytes: number) =>
  totalBytes > CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES;

/**
 * An image a step viewed, as its row shows it. `too-large`: the image is
 * more than the computer keeps for a step, so none of it is there.
 * `not-image`: what the computer handed over does not begin as an image
 * stella shows. `shown`: the image, as the kind its own bytes name.
 */
export type LocalRunStepImageView =
  | { status: "elsewhere" }
  | { status: "not-kept" }
  | { status: "too-large"; totalBytes: number }
  | { status: "not-image" }
  | { status: "shown"; src: string; type: ChatLocalRunImageType };

/** `String.fromCodePoint` takes its bytes as arguments: this many at once. */
const BASE64_CHUNK_BYTES = 0x80_00;

const base64Of = (bytes: Uint8Array): string => {
  let binary = "";
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK_BYTES) {
    binary += String.fromCodePoint(
      ...bytes.subarray(start, start + BASE64_CHUNK_BYTES),
    );
  }
  return btoa(binary);
};

/**
 * The view of an image read from the computer. Its kind is read from the
 * bytes (`chatLocalRunImageType`), never taken from the answer's headers or
 * the file's name, and it is shown only as that kind, in an image element:
 * bytes that are not one of the kinds shown are never given to the page as
 * anything else.
 */
export const localRunStepImageView = ({
  chunks,
  totalBytes,
}: {
  chunks: readonly Uint8Array[];
  totalBytes: number;
}): LocalRunStepImageView => {
  if (isLocalRunStepOutputCut(totalBytes)) {
    return { status: "too-large", totalBytes };
  }
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  // The desktop never sends more than the cap; nothing past it is shown.
  if (length > CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES) {
    return { status: "not-image" };
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const type = chatLocalRunImageType(bytes);
  return type === null
    ? { status: "not-image" }
    : { status: "shown", type, src: `data:${type};base64,${base64Of(bytes)}` };
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

/**
 * A kept diff's lines in order, each with its tone and a key that stays the
 * same while more text arrives after it: where the line starts.
 */
/** The most diff lines shown one by one, each in its tone. */
export const DIFF_TONED_LINES = 2000;

/**
 * A diff's lines to show one by one, each in its tone, and the text past
 * them, shown as one plain block: a long diff (up to the 1 MiB cap) stays
 * readable and copyable without one element per line.
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
