import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  type ChatLocalRunStepContent,
  chatLocalRunStepContentWindow,
} from "./chat-local-run-step-content";
import {
  DIFF_TONED_LINES,
  diffLines,
  diffLineTone,
  foldLocalRunStepOutput,
  LOCAL_RUN_STEP_OUTPUT_UNREAD,
  localRunConversationEntries,
} from "./chat-local-run-step-content-view";

const fold = (answers: readonly ChatLocalRunStepContent[]) => {
  let view = LOCAL_RUN_STEP_OUTPUT_UNREAD;
  for (const answer of answers) {
    view = foldLocalRunStepOutput(view, answer);
  }
  return view;
};

/** The windows the API answers for `text`, each read from the last one's end. */
const windowsOf = (text: string, limit: number, totalBytes: number) => {
  const bytes = new TextEncoder().encode(text);
  const answers: ChatLocalRunStepContent[] = [];
  let start: number | null = 0;
  while (start !== null) {
    const window = chatLocalRunStepContentWindow(bytes, start, limit);
    answers.push({
      state: "stored",
      kind: "command",
      totalBytes,
      storedBytes: bytes.byteLength,
      start: window.start,
      text: new TextDecoder().decode(bytes.subarray(window.start, window.end)),
      nextStart: window.nextStart,
    });
    start = window.nextStart;
  }
  return answers;
};

describe("a step's content as its row shows it", () => {
  test("windows read in order rejoin to the stored text, however small", () => {
    assertProperty(
      "windows read in order rejoin to the stored text, however small",
      fc.property(
        // A window as short as one byte up to the whole text.
        fc.string({ unit: "grapheme" }).chain((text) =>
          fc.tuple(
            fc.constant(text),
            fc.integer({
              min: 1,
              max: Math.max(1, new TextEncoder().encode(text).byteLength),
            }),
          ),
        ),
        ([text, limit]) => {
          const bytes = new TextEncoder().encode(text).byteLength;
          const view = fold(windowsOf(text, limit, bytes + 7));
          expect(view).toEqual({
            status: "text",
            kind: "command",
            text,
            readBytes: bytes,
            storedBytes: bytes,
            totalBytes: bytes + 7,
          });
        },
      ),
    );
  });

  test("a read cut short holds what arrived, short of what is stored", () => {
    const [first] = windowsOf("zsh: no such file", 5, 17);
    const view = fold(first === undefined ? [] : [first]);
    expect(view).toMatchObject({
      status: "text",
      text: "zsh: ",
      readBytes: 5,
      storedBytes: 17,
    });
  });

  test("a later answer that is no window of the text read replaces it", () => {
    const [first] = windowsOf("partial output", 4, 14);
    expect(
      fold([...(first === undefined ? [] : [first]), { state: "not_stored" }]),
    ).toEqual({ status: "answered", content: { state: "not_stored" } });
  });

  test("a diff's file headers read as headers, not as changed lines", () => {
    expect(
      [
        "--- notes.md",
        "+++ notes.md",
        "@@",
        "-Rent is due monthly.",
        "+Rent is due quarterly.",
        " unchanged",
      ].map(diffLineTone),
    ).toEqual(["file", "file", "hunk", "removed", "added", "context"]);
  });
});

test("a long diff shows its first lines toned and the rest as one block", () => {
  const short = diffLines("+added\n-removed\n context\n");
  expect(short.lines.map(({ line }) => line)).toEqual([
    "+added",
    "-removed",
    " context",
  ]);
  expect(short.rest).toBe("");

  const long = Array.from(
    { length: DIFF_TONED_LINES + 3 },
    (_, index) => `+line ${String(index)}`,
  ).join("\n");
  const bounded = diffLines(long);
  expect(bounded.lines).toHaveLength(DIFF_TONED_LINES);
  expect(bounded.rest.split("\n")).toEqual([
    `+line ${String(DIFF_TONED_LINES)}`,
    `+line ${String(DIFF_TONED_LINES + 1)}`,
    `+line ${String(DIFF_TONED_LINES + 2)}`,
  ]);
  // Nothing is lost between the two.
  expect(
    [...bounded.lines.map(({ line }) => line), bounded.rest].join("\n"),
  ).toBe(long);
});

describe("a subagent's conversation as its group shows it", () => {
  const line = (role: string, text: string) => JSON.stringify({ role, text });

  test("reads as what it was told, what it wrote, then what it reported, whatever order it was kept in", () => {
    // The computer keeps the report ahead of what was written.
    const kept = [
      line("prompt", "List the arrears clauses."),
      line("report", "Clause 4."),
      line("message", "Reading the lease."),
      line("message", "Clause 4 covers arrears."),
      "",
    ].join("\n");
    expect(
      localRunConversationEntries(kept).map(({ role, text }) => [role, text]),
    ).toEqual([
      ["prompt", "List the arrears clauses."],
      ["message", "Reading the lease."],
      ["message", "Clause 4 covers arrears."],
      ["report", "Clause 4."],
    ]);
  });

  test("an entry the cap cut, and a line that is no entry, show nothing", () => {
    const kept = [
      line("prompt", "List the arrears clauses."),
      "<script>alert(1)</script>",
      line("message", "Clause 4 covers").slice(0, -6),
    ].join("\n");
    expect(localRunConversationEntries(kept)).toEqual([
      { key: 0, role: "prompt", text: "List the arrears clauses." },
    ]);
    expect(localRunConversationEntries("")).toEqual([]);
  });

  test("an entry keeps its key while more of the conversation arrives", () => {
    const first = `${line("prompt", "Check.")}\n${line("report", "Done.")}\n`;
    const keys = (text: string) =>
      new Map(
        localRunConversationEntries(text).map(({ key, text: said }) => [
          said,
          key,
        ]),
      );
    const later = keys(`${first}${line("message", "Looking.")}\n`);
    for (const [said, key] of keys(first)) {
      expect(later.get(said)).toBe(key);
    }
  });
});
