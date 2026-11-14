import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { CHAT_LOCAL_RUN_STEP_MAX_BYTES } from "@stll/api-contract/chat-local-run-step-output";
import { assertProperty } from "@stll/property-testing";

import {
  DIFF_TONED_LINES,
  diffLines,
  diffLineTone,
  foldLocalRunStepOutput,
  isLocalRunStepOutputCut,
  LOCAL_RUN_STEP_OUTPUT_UNREAD,
  localRunConversationEntries,
  localRunStepImageView,
  type LocalRunStepOutputEvent,
  localRunStepOutputStaleTime,
} from "./local-run-step-output.logic";

const fold = (events: LocalRunStepOutputEvent[]) => {
  let view = LOCAL_RUN_STEP_OUTPUT_UNREAD;
  for (const event of events) {
    view = foldLocalRunStepOutput(view, event);
  }
  return view;
};

describe("a step's output as its row shows it", () => {
  test("text arrives in order after the size, and counts the bytes kept", () => {
    expect(
      fold([
        { type: "started", totalBytes: 9 },
        { type: "text", text: "zsh: ", bytes: 5 },
        { type: "text", text: "nope", bytes: 4 },
      ]),
    ).toEqual({
      status: "shown",
      text: "zsh: nope",
      keptBytes: 9,
      totalBytes: 9,
    });
  });

  test("a run on another computer or a step with nothing kept says so", () => {
    expect(fold([{ type: "elsewhere" }])).toEqual({ status: "elsewhere" });
    expect(fold([{ type: "not-kept" }])).toEqual({ status: "not-kept" });
  });

  test("only output past the cap reads as cut", () => {
    expect(isLocalRunStepOutputCut(CHAT_LOCAL_RUN_STEP_MAX_BYTES.text)).toBe(
      false,
    );
    expect(
      isLocalRunStepOutputCut(CHAT_LOCAL_RUN_STEP_MAX_BYTES.text + 1),
    ).toBe(true);
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

test("an output found elsewhere is read again; one the desktop answered holds", () => {
  expect(localRunStepOutputStaleTime({ status: "elsewhere" })).toBe(0);
  for (const answered of [
    { status: "not-kept" },
    { status: "shown", text: "ok", keptBytes: 2, totalBytes: 2 },
  ] as const) {
    expect(localRunStepOutputStaleTime(answered)).toBe(
      Number.POSITIVE_INFINITY,
    );
  }
  expect(localRunStepOutputStaleTime(undefined)).toBe(Number.POSITIVE_INFINITY);
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

describe("an image a step viewed, as its row shows it", () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  /** The most bytes generated after the signature, and chunk edges among them. */
  const GENERATED_BYTES = 200;
  const GENERATED_EDGES = 4;

  test("is shown as the kind its bytes name, whole, however it arrived", () => {
    assertProperty(
      "is shown as the kind its bytes name, whole, however it arrived",
      fc.property(
        fc.uint8Array({ maxLength: GENERATED_BYTES }),
        fc.array(fc.nat(), { maxLength: GENERATED_EDGES }),
        (rest, cuts) => {
          const bytes = new Uint8Array([...PNG, ...rest]);
          // The same bytes, split into chunks at arbitrary points.
          const edges = [
            0,
            ...cuts.map((cut) => cut % bytes.length).toSorted((a, b) => a - b),
            bytes.length,
          ];
          const chunks = edges
            .slice(1)
            .map((end, index) => bytes.subarray(edges[index], end));
          const view = localRunStepImageView({
            chunks,
            totalBytes: bytes.length,
          });
          expect(view).toEqual({
            status: "shown",
            type: "image/png",
            src: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
          });
        },
      ),
    );
  });

  test("bytes that are no image are never given a form, whatever they claim to be", () => {
    const text = (value: string) => new TextEncoder().encode(value);
    for (const other of [
      text("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"),
      text("<!doctype html><script>alert(1)</script>"),
      text('{"role":"prompt","text":"x"}'),
      new Uint8Array(),
    ]) {
      expect(
        localRunStepImageView({ chunks: [other], totalBytes: other.length }),
      ).toEqual({ status: "not-image" });
    }
  });

  test("an image past what the computer keeps says how large it is and shows nothing", () => {
    const cap = CHAT_LOCAL_RUN_STEP_MAX_BYTES.image;
    const totalBytes = cap + 1;
    // The computer kept only its size.
    expect(localRunStepImageView({ chunks: [], totalBytes })).toEqual({
      status: "too-large",
      totalBytes,
    });
    // More than the cap is never shown, even if a desktop sent it.
    const oversized = new Uint8Array(cap + 1);
    oversized.set(PNG);
    expect(
      localRunStepImageView({ chunks: [oversized], totalBytes: cap }),
    ).toEqual({ status: "not-image" });
  });

  test("an image at its cap is shown whole, past the most a text keeps", () => {
    const cap = CHAT_LOCAL_RUN_STEP_MAX_BYTES.image;
    expect(cap).toBeGreaterThan(CHAT_LOCAL_RUN_STEP_MAX_BYTES.text);
    const whole = new Uint8Array(cap);
    whole.set(PNG);
    // As it arrives: in chunks.
    const half = cap / 2;
    const view = localRunStepImageView({
      chunks: [whole.subarray(0, half), whole.subarray(half)],
      totalBytes: cap,
    });
    expect(view.status).toBe("shown");
    if (view.status !== "shown") {
      return;
    }
    expect(view.type).toBe("image/png");
    const data = view.src.slice("data:image/png;base64,".length);
    expect(Buffer.compare(Buffer.from(data, "base64"), whole)).toBe(0);
  });

  test("a read cut short shows no image and is read again", () => {
    const whole = new Uint8Array([...PNG, 1, 2, 3, 4]);
    const view = localRunStepImageView({
      chunks: [whole.subarray(0, PNG.length + 1)],
      totalBytes: whole.length,
    });
    expect(view).toEqual({ status: "incomplete" });
    expect(localRunStepOutputStaleTime(view)).toBe(0);
  });

  test("an image found elsewhere is read again; one the desktop answered holds", () => {
    expect(localRunStepOutputStaleTime({ status: "elsewhere" })).toBe(0);
    expect(
      localRunStepOutputStaleTime({ status: "too-large", totalBytes: 1 }),
    ).toBe(Number.POSITIVE_INFINITY);
  });
});
