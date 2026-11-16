import { EventType, RUN_CANCEL_REASON } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import {
  createComputer,
  localSource,
} from "@/api/tests/helpers/fake-local-computer";

import {
  CHAT_TURN_OWNER_LOST_REASON,
  CHAT_TURN_PRODUCTION_FAILED_REASON,
  CHAT_TURN_RUN_CUTS,
  type ChatTurnRunCut,
  chatTurnRunCutOf,
} from "./chat-turn-run-cut";

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
  "owner-lost": 1,
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
