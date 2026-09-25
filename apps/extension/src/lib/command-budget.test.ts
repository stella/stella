import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_LIMITS,
  type BrowserControlCommand,
} from "@stll/api-contract/browser-control";

import {
  chargeCommandBudget,
  type CommandBudgetLedger,
  refundCommandBudget,
} from "./command-budget";

const click = {
  action: "click",
  page: { revision: "revision-1", url: "https://example.com/" },
  target: { name: "Next", ref: "e:0:1", role: "button" },
} satisfies BrowserControlCommand;
const open = {
  action: "open",
  url: "https://example.com/",
} satisfies BrowserControlCommand;
const read = { action: "snapshot" } satisfies BrowserControlCommand;

const chargeRepeatedly = (
  command: BrowserControlCommand,
  times: number,
  turnId: (index: number) => string,
  start: CommandBudgetLedger | null = null,
) => {
  let ledger = start;
  for (let index = 0; index < times; index += 1) {
    const outcome = chargeCommandBudget(ledger, {
      command,
      controllerId: "controller-1",
      turnId: turnId(index),
    });
    if (outcome.status !== "charged") {
      return { index, ledger, outcome };
    }
    ledger = outcome.ledger;
  }
  return { index: times, ledger, outcome: null };
};

describe("browser command budget", () => {
  test("refuses the action past the per-turn limit, then a new turn starts fresh", () => {
    const { index, ledger, outcome } = chargeRepeatedly(
      click,
      BROWSER_CONTROL_LIMITS.turnActions + 1,
      () => "turn-1",
    );
    expect(index).toBe(BROWSER_CONTROL_LIMITS.turnActions);
    expect(outcome).toMatchObject({ status: "exceeded" });
    expect(outcome?.status === "exceeded" && outcome.message).toContain(
      "chat turn",
    );

    expect(
      chargeCommandBudget(ledger, {
        command: click,
        controllerId: "controller-1",
        turnId: "turn-2",
      }).status,
    ).toBe("charged");
  });

  test("counts navigations separately and tighter than actions", () => {
    const { index, outcome } = chargeRepeatedly(
      open,
      BROWSER_CONTROL_LIMITS.turnNavigations + 1,
      () => "turn-1",
    );
    expect(index).toBe(BROWSER_CONTROL_LIMITS.turnNavigations);
    expect(outcome?.status === "exceeded" && outcome.message).toContain(
      "navigations",
    );
  });

  test("bounds the pairing across turns until the user reconnects", () => {
    const { index, ledger, outcome } = chargeRepeatedly(
      click,
      BROWSER_CONTROL_LIMITS.sessionActions + 1,
      (turn) => `turn-${turn}`,
    );
    expect(index).toBe(BROWSER_CONTROL_LIMITS.sessionActions);
    expect(outcome?.status === "exceeded" && outcome.message).toContain(
      "reconnect",
    );

    expect(
      chargeCommandBudget(ledger, {
        command: click,
        controllerId: "controller-2",
        turnId: "turn-new",
      }).status,
    ).toBe("charged");
  });

  test("a refund gives back one charge, never below zero", () => {
    const request = {
      command: open,
      controllerId: "controller-1",
      turnId: "turn-1",
    };
    const { ledger } = chargeRepeatedly(open, 2, () => "turn-1");
    const refunded = refundCommandBudget(ledger, request);
    expect(refunded?.session).toEqual({ actions: 1, navigations: 1 });
    expect(refunded?.turns).toEqual([
      { turnId: "turn-1", usage: { actions: 1, navigations: 1 } },
    ]);
    const empty = refundCommandBudget(
      refundCommandBudget(refunded, request),
      request,
    );
    expect(empty?.session).toEqual({ actions: 0, navigations: 0 });
    expect(
      refundCommandBudget(ledger, { ...request, controllerId: "controller-2" }),
    ).toBe(ledger);
  });

  test("page reads are never refused or charged", () => {
    const { ledger } = chargeRepeatedly(
      click,
      BROWSER_CONTROL_LIMITS.turnActions,
      () => "turn-1",
    );
    const outcome = chargeCommandBudget(ledger, {
      command: read,
      controllerId: "controller-1",
      turnId: "turn-1",
    });
    if (outcome.status !== "charged") {
      throw new TypeError("A page read was refused");
    }
    expect(outcome.ledger.session).toEqual({
      actions: BROWSER_CONTROL_LIMITS.turnActions,
      navigations: 0,
    });
    expect(ledger?.session).toEqual(outcome.ledger.session);
  });
});
