import { describe, expect, test } from "bun:test";

import { CHAT_COMMAND_ERROR_CODE, chatCommandOutcomeOf } from "./chat-command";

const TURN_ID = "0198c0de-0000-7000-8000-000000000001";

describe("what became of a command whose response arrived", () => {
  test("a stream is the command accepted", () => {
    expect(
      chatCommandOutcomeOf({ code: undefined, status: 200, turnId: TURN_ID }),
    ).toEqual({ type: "accepted" });
  });

  test("a replay names the turn an earlier attempt started", () => {
    expect(
      chatCommandOutcomeOf({
        code: CHAT_COMMAND_ERROR_CODE.replayed,
        status: 409,
        turnId: TURN_ID,
      }),
    ).toEqual({ type: "replayed", turnId: TURN_ID });
  });

  test("a refusal that names a turn is still a refusal", () => {
    expect(
      chatCommandOutcomeOf({
        code: "chat_turn_running",
        status: 409,
        turnId: TURN_ID,
      }),
    ).toEqual({ type: "refused" });
  });

  test("a replay code without the turn to join, or on another status, is a refusal", () => {
    for (const answer of [
      { status: 409, turnId: null },
      { status: 400, turnId: TURN_ID },
    ]) {
      expect(
        chatCommandOutcomeOf({
          code: CHAT_COMMAND_ERROR_CODE.replayed,
          ...answer,
        }),
      ).toEqual({ type: "refused" });
    }
  });

  test("an id held elsewhere is a refusal", () => {
    expect(
      chatCommandOutcomeOf({
        code: CHAT_COMMAND_ERROR_CODE.conflict,
        status: 409,
        turnId: null,
      }),
    ).toEqual({ type: "refused" });
  });
});
