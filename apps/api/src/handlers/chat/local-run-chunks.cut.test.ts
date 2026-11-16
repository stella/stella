import { EventType, RUN_CANCEL_REASON } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import {
  createComputer,
  harnessChunks,
  localSource,
} from "@/api/tests/helpers/fake-local-computer";

import {
  CHAT_TURN_OWNER_LOST_REASON,
  CHAT_TURN_PRODUCTION_FAILED_REASON,
  CHAT_TURN_RUN_CUTS,
  type ChatTurnRunCut,
  chatTurnRunCutOf,
} from "./chat-turn-run-cut";
import { isChatTurnReleasedChunk } from "./local-run-chunks";

/** An abort reason each kind of cut carries in production. */
const REASON_OF_CUT = {
  "member-stop": RUN_CANCEL_REASON,
  "owner-lost": CHAT_TURN_OWNER_LOST_REASON,
  "production-failed": CHAT_TURN_PRODUCTION_FAILED_REASON,
  "admission-lost": new ActionAdmissionError({
    message: "Execution admission lost",
    reason: "busy",
  }),
  other: new DOMException("The operation timed out.", "TimeoutError"),
} as const satisfies Record<ChatTurnRunCut, unknown>;

/** How many interrupts a cut of each kind queues for the computer. */
const INTERRUPTS_OF_CUT = {
  "member-stop": 1,
  // A lost owner's turn is another task's now, or ended: the adopter reads
  // the run on, and the run of an ended turn is cancelled from the rows.
  "owner-lost": 0,
  "production-failed": 1,
  "admission-lost": 1,
  other: 1,
} as const satisfies Record<ChatTurnRunCut, number>;

/** A read of a new turn's run, with the cut that ends it in the test's hand. */
const startRead = () => {
  const computer = createComputer();
  const cut = new AbortController();
  const read = localSource(computer)(cut.signal)[Symbol.asyncIterator]();
  return { computer, cut, read };
};

describe("a cut of a local turn", () => {
  test("is told apart by the reason its signal carries", () => {
    for (const kind of CHAT_TURN_RUN_CUTS) {
      expect(chatTurnRunCutOf(REASON_OF_CUT[kind])).toBe(kind);
    }
  });

  for (const kind of CHAT_TURN_RUN_CUTS) {
    test(`${kind} while the read waits on the computer interrupts as its kind says`, async () => {
      const { computer, cut, read } = startRead();
      expect((await read.next()).value).toMatchObject({
        type: EventType.RUN_STARTED,
      });
      // The computer has not picked the run up: the next read waits on it.
      await read.next();
      const waiting = read.next();
      cut.abort(REASON_OF_CUT[kind]);

      expect((await waiting).done).toBe(true);
      expect(computer.queued.interrupts).toBe(INTERRUPTS_OF_CUT[kind]);
    });

    test(`${kind} while the consumer is not pulling interrupts as its kind says`, async () => {
      const { computer, cut, read } = startRead();
      await read.next();
      cut.abort(REASON_OF_CUT[kind]);
      // The consumer learns of the cut from the run and stops reading.
      await read.return?.(undefined);

      expect(computer.queued.interrupts).toBe(INTERRUPTS_OF_CUT[kind]);
    });
  }

  test("a consumer that stops reading without a cut interrupts once", async () => {
    const { computer, read } = startRead();
    await read.next();
    await read.return?.(undefined);

    expect(computer.queued.interrupts).toBe(1);
  });
});

/** A read of a new turn's run that its turn can release to another task. */
const startReleasableRead = () => {
  const computer = createComputer();
  const handOver = new AbortController();
  const read = localSource(computer)(
    new AbortController().signal,
    handOver.signal,
  )[Symbol.asyncIterator]();
  return { computer, handOver, read };
};

const readRest = async (read: AsyncIterator<StreamChunk>) => {
  const chunks: StreamChunk[] = [];
  for (let step = await read.next(); step.done !== true;) {
    chunks.push(step.value);
    step = await read.next();
  }
  return chunks;
};

describe("a local turn released to another task", () => {
  test("ends its read after the last event, where it records it, and leaves the computer running", async () => {
    const { computer, handOver, read } = startReleasableRead();
    const events = await harnessChunks([
      { type: "text.delta", messageId: "answer", delta: "Reading the files." },
    ]);
    computer.events(events);
    const content = events.findIndex(
      (chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT,
    );
    expect(content).toBeGreaterThan(-1);
    let step = await read.next();
    while (
      step.done !== true &&
      step.value.type !== EventType.TEXT_MESSAGE_CONTENT
    ) {
      step = await read.next();
    }
    // Released while the read is on the text's event, with more stored.
    computer.events(
      await harnessChunks([
        { type: "text.delta", messageId: "answer", delta: " Done." },
      ]),
    );
    handOver.abort();
    const rest = await readRest(read);

    expect(rest).toHaveLength(1);
    expect(rest.at(0)).toSatisfy(isChatTurnReleasedChunk);
    expect(computer.chatReadSeq()).toBe(content + 1);
    expect(computer.queued.interrupts).toBe(0);
  });

  test("emits its run start before it releases, however early", async () => {
    const { computer, handOver, read } = startReleasableRead();
    handOver.abort();
    const chunks = await readRest(read);

    expect(chunks.at(0)).toMatchObject({ type: EventType.RUN_STARTED });
    expect(chunks.at(-1)).toSatisfy(isChatTurnReleasedChunk);
    expect(computer.queued.interrupts).toBe(0);
  });

  test("reads on to the run's end once its harness finished", async () => {
    const { computer, handOver, read } = startReleasableRead();
    computer.events(
      await harnessChunks([
        { type: "text.delta", messageId: "answer", delta: "Done." },
        { type: "turn.completed", usage: null, boundary: null },
      ]),
    );
    let step = await read.next();
    while (step.done !== true && step.value.type !== EventType.RUN_FINISHED) {
      step = await read.next();
    }
    handOver.abort();
    computer.finish();
    const rest = await readRest(read);

    expect(rest.some(isChatTurnReleasedChunk)).toBe(false);
    expect(computer.queued.interrupts).toBe(0);
  });
});
