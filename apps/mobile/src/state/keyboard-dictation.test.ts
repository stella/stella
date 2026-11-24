import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import {
  defaultKeyboardLayout,
  KEEP_WARM_CHOICES,
  keepWarmOf,
  KEYBOARD_HANDOFF_WINDOW_MS,
  keyboardJobs,
  parseKeyboardPieces,
  parseKeyboardStatus,
  readKeyboardHandoff,
  transcriptionLanguage,
} from "./keyboard-dictation";
import type { KeyboardOutcome, KeyboardPiece } from "./keyboard-dictation";

const JOB = "0b9f6c2e-4d1a-4e8b-9c3f-2a7d5e6f8b10";
const OTHER_JOB = "5c1d2e3f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
const NOW = 1_800_000_000_000;

describe("the keyboard's link", () => {
  const link = (at: number) => ({
    job: JOB,
    language: "cs",
    at: String(at),
  });

  test("a fresh link records the dictation it names", () => {
    expect(readKeyboardHandoff(link(NOW - 2000), NOW)).toEqual({
      type: "record",
      jobId: JOB,
      language: "cs",
    });
    expect(
      readKeyboardHandoff(link(NOW - KEYBOARD_HANDOFF_WINDOW_MS), NOW).type,
    ).toBe("record");
  });

  test("a stale or future link only warms the microphone", () => {
    expect(
      readKeyboardHandoff(link(NOW - KEYBOARD_HANDOFF_WINDOW_MS - 1), NOW),
    ).toEqual({
      type: "warm",
    });
    expect(readKeyboardHandoff(link(NOW + 1), NOW)).toEqual({ type: "warm" });
  });

  const partial: Readonly<Record<string, string | string[]>>[] = [
    {},
    { job: JOB, language: "cs" },
    { job: "not-a-job", language: "cs", at: String(NOW) },
    { job: JOB, language: "xx", at: String(NOW) },
    { job: JOB, language: "cs", at: "-5" },
    { job: [JOB, OTHER_JOB], language: "cs", at: String(NOW) },
  ];
  test.each(partial)(
    "a partial or foreign link only warms the microphone: %o",
    (params) => {
      expect(readKeyboardHandoff(params, NOW)).toEqual({ type: "warm" });
    },
  );

  test("automatic tells the transcription no language", () => {
    expect(transcriptionLanguage("auto")).toBeUndefined();
    expect(transcriptionLanguage("sk")).toBe("sk");
  });
});

describe("the session's answers", () => {
  test("keep warm reads only the offered choices, anything else as off", () => {
    for (const choice of KEEP_WARM_CHOICES) {
      expect(keepWarmOf(choice)).toBe(choice);
    }
    expect(keepWarmOf(42)).toBe(0);
  });

  test("a status reads as a warm session or none", () => {
    expect(
      parseKeyboardStatus({
        active: true,
        phase: "recording",
        keepWarmSeconds: 900,
        warmUntil: NOW,
        jobId: JOB,
        keyboardSeenAt: NOW - 5,
        layout: "qwerty",
      }),
    ).toEqual({
      session: { type: "warm", phase: "recording", warmUntil: NOW, jobId: JOB },
      keepWarm: 900,
      keyboardSeenAt: NOW - 5,
      layout: "qwerty",
    });
    expect(
      parseKeyboardStatus({
        active: false,
        phase: "ready",
        keepWarmSeconds: 0,
      }),
    ).toEqual({
      session: { type: "off" },
      keepWarm: 0,
      keyboardSeenAt: null,
      layout: null,
    });
  });

  test("before a pick, Czech and Slovak speakers type on QWERTZ, everyone else on QWERTY", () => {
    expect(defaultKeyboardLayout("cs")).toBe("qwertz");
    expect(defaultKeyboardLayout("sk")).toBe("qwertz");
    expect(defaultKeyboardLayout("en")).toBe("qwerty");
    expect(defaultKeyboardLayout("pt-BR")).toBe("qwerty");
  });

  test("a shape the native side never sends fails loudly", () => {
    expect(() => parseKeyboardStatus({ active: "yes" })).toThrow(v.ValiError);
    expect(() =>
      parseKeyboardPieces([{ jobId: JOB, index: -1, last: true }]),
    ).toThrow(v.ValiError);
  });
});

type Deferred = {
  readonly promise: Promise<string | null>;
  readonly resolve: (text: string | null) => void;
  readonly reject: (cause: unknown) => void;
};

const deferred = (): Deferred => {
  let settle: (text: string | null) => void = () => undefined;
  let fail: (cause: unknown) => void = () => undefined;
  const promise = new Promise<string | null>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, resolve: settle, reject: fail };
};

const piece = (
  index: number,
  last: boolean,
  { jobId = JOB, uri = `file:///piece-${String(index)}.m4a` } = {},
): KeyboardPiece => ({
  jobId,
  index,
  uri,
  language: "auto",
  durationMs: 1000,
  last,
});

/** Jobs whose pieces each wait for `answers[uri]`; what they delivered, and how often setup was read. */
const harness = (
  finish = async (joined: string) => await Promise.resolve(joined),
) => {
  const answers = new Map<string, Deferred>();
  const delivered: { jobId: string; outcome: KeyboardOutcome }[] = [];
  let prepared = 0;
  const jobs = keyboardJobs({
    prepare: async () => {
      prepared += 1;
      return await Promise.resolve("setup");
    },
    transcribe: async ({ uri }) => {
      const answer = deferred();
      answers.set(uri, answer);
      return await answer.promise;
    },
    finish,
    deliver: (jobId, outcome) => {
      delivered.push({ jobId, outcome });
    },
  });
  const answer = (index: number) =>
    answers.get(`file:///piece-${String(index)}.m4a`) ?? deferred();
  return { jobs, answer, delivered, prepared: () => prepared };
};

/** Lets the jobs' awaited setup and transcriptions reach the transcriber. */
const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
};

describe("keyboard dictations", () => {
  test("texts join in spoken order whatever order they arrive in, and setup is read once", async () => {
    const { answer, delivered, jobs, prepared } = harness();
    const first = jobs.take([piece(0, false), piece(1, false)]);
    const done = jobs.take([piece(2, true)]);
    await settle();
    answer(2).resolve("third");
    answer(0).resolve("first");
    answer(1).resolve("second");
    await Promise.all([first, done]);
    expect(delivered).toEqual([
      { jobId: JOB, outcome: { type: "text", text: "first second third" } },
    ]);
    expect(prepared()).toBe(1);
  });

  test("a last piece taken before an earlier one waits for it", async () => {
    const { answer, delivered, jobs, prepared } = harness();
    const early = jobs.take([piece(0, false), piece(2, true)]);
    await settle();
    answer(0).resolve("first");
    answer(2).resolve("third");
    await early;
    expect(delivered).toEqual([]);
    const late = jobs.take([piece(1, false)]);
    await settle();
    answer(1).resolve("second");
    await late;
    expect(delivered).toEqual([
      { jobId: JOB, outcome: { type: "text", text: "first second third" } },
    ]);
    expect(prepared()).toBe(1);
  });

  test("a failed piece leaves a gap; the rest still arrives", async () => {
    const { answer, delivered, jobs } = harness();
    const done = jobs.take([piece(0, false), piece(1, false), piece(2, true)]);
    await settle();
    answer(0).resolve("first");
    answer(1).reject(new Error("upload failed"));
    answer(2).resolve(null);
    await done;
    expect(delivered).toEqual([
      { jobId: JOB, outcome: { type: "text", text: "first" } },
    ]);
  });

  test("nothing heard is silent; nothing transcribed is a failure", async () => {
    const silent = harness();
    const quiet = silent.jobs.take([piece(0, true)]);
    await settle();
    silent.answer(0).resolve("  ");
    await quiet;
    expect(silent.delivered).toEqual([
      { jobId: JOB, outcome: { type: "silent" } },
    ]);

    const failing = harness();
    const broken = failing.jobs.take([piece(0, true)]);
    await settle();
    failing.answer(0).resolve(null);
    await broken;
    expect(failing.delivered).toEqual([
      { jobId: JOB, outcome: { type: "failed" } },
    ]);
  });

  test("a last piece with no audio ends the dictation on what came before", async () => {
    const { answer, delivered, jobs } = harness();
    const done = jobs.take([
      piece(0, false),
      { ...piece(1, true), uri: undefined },
    ]);
    await settle();
    answer(0).resolve("only");
    await done;
    expect(delivered).toEqual([
      { jobId: JOB, outcome: { type: "text", text: "only" } },
    ]);
  });

  test("a cleanup that fails delivers the words as heard", async () => {
    const { answer, delivered, jobs } = harness(async () => {
      await Promise.resolve();
      throw new Error("cleanup down");
    });
    const done = jobs.take([piece(0, true)]);
    await settle();
    answer(0).resolve("as heard");
    await done;
    expect(delivered).toEqual([
      { jobId: JOB, outcome: { type: "text", text: "as heard" } },
    ]);
  });

  test("two dictations keep their pieces apart", async () => {
    const { answer, delivered, jobs } = harness();
    const done = jobs.take([
      piece(0, false),
      piece(5, true, { jobId: OTHER_JOB, uri: "file:///piece-5.m4a" }),
      piece(1, true),
    ]);
    await settle();
    answer(5).resolve("other");
    answer(1).resolve("two");
    answer(0).resolve("one");
    await done;
    expect(delivered).toContainEqual({
      jobId: JOB,
      outcome: { type: "text", text: "one two" },
    });
    expect(delivered).toContainEqual({
      jobId: OTHER_JOB,
      outcome: { type: "text", text: "other" },
    });
  });

  test("however pieces arrive and their texts return, the text keeps spoken order", async () => {
    await assertProperty(
      "however pieces arrive and their texts return, the text keeps spoken order",
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }).chain((count) =>
          fc.tuple(
            fc.constant(count),
            fc.shuffledSubarray(
              Array.from({ length: count }, (_, index) => index),
              {
                minLength: count,
                maxLength: count,
              },
            ),
            fc.integer({ min: 1, max: count }),
          ),
        ),
        async ([count, resolveOrder, batches]) => {
          const { answer, delivered, jobs } = harness();
          const pieces = Array.from({ length: count }, (_, index) => index).map(
            (index) => piece(index, index === count - 1),
          );
          const size = Math.ceil(count / batches);
          const taken: Promise<void>[] = [];
          for (let start = 0; start < count; start += size) {
            taken.push(jobs.take(pieces.slice(start, start + size)));
          }
          await settle();
          for (const index of resolveOrder) {
            answer(index).resolve(`w${String(index)}`);
          }
          await Promise.all(taken);
          expect(delivered).toEqual([
            {
              jobId: JOB,
              outcome: {
                type: "text",
                text: Array.from({ length: count }, (_, index) => index)
                  .map((index) => `w${String(index)}`)
                  .join(" "),
              },
            },
          ]);
        },
      ),
    );
  });
});
