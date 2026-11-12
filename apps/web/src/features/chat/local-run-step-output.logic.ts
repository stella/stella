import { panic } from "better-result";

import { CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES } from "@stll/api-contract/chat-local-run-step-output";

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
  output: LocalRunStepOutputView | undefined,
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
export const diffLines = (text: string) => {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines: { key: number; line: string; tone: DiffLineTone }[] = [];
  let start = 0;
  for (const line of body.split("\n")) {
    lines.push({ key: start, line, tone: diffLineTone(line) });
    start += line.length + 1;
  }
  return lines;
};
