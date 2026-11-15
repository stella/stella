import { describe, expect, test } from "bun:test";

import {
  type AssistRequest,
  type AssistTurn,
  type AssistTurnState,
  createAssistTurns,
} from "@/hooks/assist-turns.logic";
import type { MailSnapshot } from "@/types";

const SNAPSHOT: MailSnapshot = {
  attachments: [],
  bcc: [],
  bodyHtml: "",
  bodyText: "Can you review the agreement?",
  cc: [],
  conversationId: null,
  from: null,
  internetMessageId: null,
  itemInstanceKey: "item-0",
  itemId: null,
  mode: "read",
  sentAt: null,
  subject: "Agreement",
  to: [],
  userEmail: null,
};

const SUMMARY: AssistRequest = {
  instruction: "",
  kind: "summary",
  prompt: "Summarize",
  snapshot: SNAPSHOT,
  workspaceId: null,
};

/** A send whose answers the test releases one at a time. */
const harness = () => {
  const sent: AssistRequest[] = [];
  const pending: ((outcome: AssistTurnState | Error) => void)[] = [];
  let turns: AssistTurn[] = [];
  let changed: (() => void) | null = null;
  let ids = 0;
  const assist = createAssistTurns({
    errorFallback: "stella could not answer.",
    maxTurns: 6,
    newId: () => `turn-${String(++ids)}`,
    onChange: (next) => {
      turns = next;
      changed?.();
    },
    send: async (request) => {
      sent.push(request);
      return await new Promise((resolve, reject) => {
        pending.push((outcome) =>
          outcome instanceof Error ? reject(outcome) : resolve(outcome),
        );
      });
    },
  });
  /** Answers request `index` and waits for the turn to take the answer. */
  const settle = async (index: number, outcome: AssistTurnState | Error) => {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    changed = () => resolve(undefined);
    pending[index]?.(outcome);
    await promise;
    changed = null;
  };
  return { assist, sent, settle, turns: () => turns };
};

describe("createAssistTurns", () => {
  test("joins a repeated request to the one still running", async () => {
    const { assist, sent, settle, turns } = harness();
    assist.ask(SUMMARY);
    assist.ask(SUMMARY);
    expect(sent).toHaveLength(1);
    expect(turns()).toHaveLength(1);

    await settle(0, { sources: [], text: "A summary.", type: "ready" });
    expect(turns().at(0)?.state.type).toBe("ready");

    assist.ask(SUMMARY);
    expect(sent).toHaveLength(2);
    expect(turns()).toHaveLength(2);
  });

  test("runs different requests side by side", () => {
    const { assist, sent, turns } = harness();
    assist.ask(SUMMARY);
    assist.ask({
      ...SUMMARY,
      instruction: "Is there a deadline?",
      kind: "answer",
      prompt: "Is there a deadline?",
    });
    expect(sent).toHaveLength(2);
    expect(turns().map((turn) => turn.kind)).toEqual(["answer", "summary"]);
  });

  test("releases a request that failed, so it can be sent again", async () => {
    const { assist, sent, settle, turns } = harness();
    assist.ask(SUMMARY);
    await settle(0, new Error("network"));
    expect(turns().at(0)?.state).toEqual({
      message: "stella could not answer.",
      type: "error",
    });

    assist.ask(SUMMARY);
    expect(sent).toHaveLength(2);
  });

  test("retries a failed turn in place with the current email", async () => {
    const { assist, sent, settle, turns } = harness();
    const question: AssistRequest = {
      ...SUMMARY,
      instruction: "Who signs?",
      kind: "answer",
      prompt: "Who signs?",
    };
    assist.ask(question);
    await settle(0, { message: "Timed out.", type: "error" });
    const failed = turns().at(0);
    expect(failed?.state.type).toBe("error");

    const current = { ...SNAPSHOT, bodyText: "Updated body." };
    assist.retry(failed?.id ?? "", { snapshot: current, workspaceId: "w1" });
    assist.retry(failed?.id ?? "", { snapshot: current, workspaceId: "w1" });
    expect(sent).toHaveLength(2);
    expect(sent.at(1)).toEqual({
      instruction: "Who signs?",
      kind: "answer",
      prompt: "Who signs?",
      snapshot: current,
      workspaceId: "w1",
    });
    expect(turns()).toHaveLength(1);
    expect(turns().at(0)?.state.type).toBe("loading");

    await settle(1, { sources: [], text: "The director.", type: "ready" });
    expect(turns().at(0)?.state).toEqual({
      sources: [],
      text: "The director.",
      type: "ready",
    });
  });
});
