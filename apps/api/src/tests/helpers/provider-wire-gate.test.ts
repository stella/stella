import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

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

/**
 * Reads what `reader` has until it would make the caller wait; a read still
 * waiting is handed back as `pending`, to be awaited by the next call.
 */
const readAvailable = async (
  reader: AnswerReader,
  carried?: ReturnType<AnswerReader["read"]>,
) => {
  const decoder = new TextDecoder();
  let text = "";
  let pending = carried ?? reader.read();
  while (true) {
    const next = await Promise.race([
      pending,
      Bun.sleep(20).then(() => "waiting" as const),
    ]);
    if (next === "waiting") {
      return { done: false, pending, text };
    }
    if (next.done) {
      return { done: true, pending: undefined, text };
    }
    text += decoder.decode(next.value);
    pending = reader.read();
  }
};

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
      const before = await readAvailable(reader);
      // The fixture must reach the fault: the pause is inside the body.
      expect(PAUSE_AT).toBeLessThan(BODY.length);
      expect(before).toMatchObject({
        done: false,
        text: BODY.slice(0, PAUSE_AT),
      });
      await gate.reached("held");
      expect(gate.unfinished()).toEqual(["held: reached"]);

      gate.release("held");
      expect(await readAvailable(reader, before.pending)).toMatchObject({
        done: true,
        text: BODY.slice(PAUSE_AT),
      });
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
      const before = await readAvailable(reader);
      await gate.reached("held");

      controller.abort();
      expect(
        String(await rejectionOf(before.pending ?? reader.read())),
      ).toContain("aborted");
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
