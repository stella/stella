import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { nextMacrotask } from "@stll/concurrency/event-loop";
import { rejectionOf } from "@stll/property-testing/rejection";

import { createReplayGate } from "@/api/tests/helpers/provider-wire-gate";
import { installProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";
import type {
  ProviderWireReplay,
  TranscriptStep,
} from "@/api/tests/helpers/provider-wire-replay";

// A pause point holds a replayed answer at its byte: nothing after it reaches
// the reader until the test releases the label, and an aborted request stops
// waiting. The conversations that act mid-answer rely on exactly this.

const BODY = "data: one\n\ndata: two\n\n";
const PAUSE_AT = "data: one\n\n".length;
const PROVIDER_URL = "https://api.openai.com/v1/responses";

const step = (
  gate: ReturnType<typeof createReplayGate>,
  vet: TranscriptStep["vet"] = () => null,
): TranscriptStep => ({
  exchange: {
    request: { method: "POST", path: "/v1/responses" },
    response: {
      body: { encoding: "text", text: BODY },
      headers: { "content-type": "text/event-stream" },
      status: 200,
    },
  },
  label: "answer",
  pauses: { gate, points: [{ atByte: PAUSE_AT, label: "held" }] },
  vet,
});

const post = async (signal?: AbortSignal) =>
  await fetch(PROVIDER_URL, {
    body: JSON.stringify({ model: "fixture" }),
    method: "POST",
    signal: signal ?? null,
  });

type PendingRead = ReturnType<AnswerReader["read"]>;

/**
 * Reads `length` characters from `reader`; the read after them is handed back
 * as `pending`, to be awaited by the next call.
 */
const readText = async (reader: AnswerReader, length: number) => {
  const decoder = new TextDecoder();
  let text = "";
  let pending = reader.read();
  while (text.length < length) {
    const next = await pending;
    if (next.done) {
      return panic(`The answer ended after ${String(text.length)} characters`);
    }
    text += decoder.decode(next.value);
    pending = reader.read();
  }
  return { pending, text };
};

/** Reads `reader` to its end, starting with the read `carried` over. */
const readToEnd = async (reader: AnswerReader, carried: PendingRead) => {
  const decoder = new TextDecoder();
  let text = "";
  let next = await carried;
  while (!next.done) {
    text += decoder.decode(next.value);
    next = await reader.read();
  }
  return text;
};

/** Whether `read` is still waiting once every queued task has run. The
 *  replay enqueues bytes as they are pulled, so only a held stream waits. */
const isHeld = async (read: PendingRead) =>
  await Promise.race([
    read.then(() => false),
    nextMacrotask().then(() => true),
  ]);

/** The answer's reader; the caller releases it. */
const readerOf = (response: Response) => {
  const body = response.body ?? panic("A replayed answer has a body");
  const reader = body.getReader();
  return reader;
};

type AnswerReader = ReturnType<typeof readerOf>;

let replay: ProviderWireReplay | undefined;

afterEach(() => {
  replay?.restore();
  replay = undefined;
});

describe("a pause point in a replayed answer", () => {
  test("holds the bytes after it until the label is released", async () => {
    replay = installProviderWireReplay();
    const gate = createReplayGate(["held"]);
    replay.play("fixture", [step(gate)]);
    const reader = readerOf(await post());
    try {
      const before = await readText(reader, PAUSE_AT);
      // The fixture must reach the fault: the pause is inside the body.
      expect(PAUSE_AT).toBeLessThan(BODY.length);
      expect(before.text).toBe(BODY.slice(0, PAUSE_AT));
      await gate.reached("held");
      expect(gate.unfinished()).toEqual(["held: reached"]);
      expect(await isHeld(before.pending)).toBe(true);

      gate.release("held");
      expect(await readToEnd(reader, before.pending)).toBe(
        BODY.slice(PAUSE_AT),
      );
      expect(gate.unfinished()).toEqual([]);
      expect(replay.takeTranscriptRemainder()).toEqual([]);
    } finally {
      reader.releaseLock();
    }
  });

  test("ends the held answer as an abort when the request is aborted", async () => {
    replay = installProviderWireReplay();
    const gate = createReplayGate(["held"]);
    replay.play("fixture", [step(gate)]);
    const controller = new AbortController();
    const reader = readerOf(await post(controller.signal));
    try {
      const before = await readText(reader, PAUSE_AT);
      await gate.reached("held");

      controller.abort();
      expect(String(await rejectionOf(before.pending))).toContain("aborted");
    } finally {
      reader.releaseLock();
    }
  });

  test("a request the step refuses fails every wait for a pause point", async () => {
    replay = installProviderWireReplay();
    const gate = createReplayGate(["held"]);
    replay.play("fixture", [
      step(gate, () => {
        gate.fail("the request diverged");
        return "the request diverged";
      }),
    ]);
    expect(String(await rejectionOf(post()))).toContain("the request diverged");
    expect(String(await rejectionOf(gate.reached("held")))).toContain(
      "the request diverged",
    );
    expect(replay.takeFindings().unexpected).toEqual([
      "POST api.openai.com/v1/responses: not the request the transcript expects at answer: the request diverged",
    ]);
  });
});
