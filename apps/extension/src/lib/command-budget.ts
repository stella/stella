import { panic } from "better-result";

import {
  BROWSER_CONTROL_ACTION,
  BROWSER_CONTROL_LIMITS,
  type BrowserControlCommand,
} from "@stll/api-contract/browser-control";

import { BROWSER_COMMAND_BUDGET_STORAGE_KEY } from "./storage-keys";

type BudgetUsage = { actions: number; navigations: number };

/** Usage for one pairing; a new pairing starts from nothing. */
export type CommandBudgetLedger = {
  controllerId: string;
  session: BudgetUsage;
  /** The most recent chat turns, newest last. */
  turns: { turnId: string; usage: BudgetUsage }[];
};

/**
 * Turns kept in the ledger. Several chats in one stella tab share the
 * controller, so a turn is remembered past the next one's first command.
 */
const TRACKED_TURNS = 16;

const EMPTY_USAGE: BudgetUsage = { actions: 0, navigations: 0 };

type CommandCost = { actions: 0 | 1; navigations: 0 | 1 };

const commandCost = (command: BrowserControlCommand): CommandCost => {
  switch (command.action) {
    case BROWSER_CONTROL_ACTION.snapshot:
      return { actions: 0, navigations: 0 };
    case BROWSER_CONTROL_ACTION.goBack:
    case BROWSER_CONTROL_ACTION.open:
      return { actions: 1, navigations: 1 };
    case BROWSER_CONTROL_ACTION.click:
    case BROWSER_CONTROL_ACTION.fill:
    case BROWSER_CONTROL_ACTION.pressKey:
    case BROWSER_CONTROL_ACTION.select:
      return { actions: 1, navigations: 0 };
    default:
      command satisfies never;
      return panic("Unhandled browser command action");
  }
};

const add = (usage: BudgetUsage, cost: CommandCost): BudgetUsage => ({
  actions: usage.actions + cost.actions,
  navigations: usage.navigations + cost.navigations,
});

const subtract = (usage: BudgetUsage, cost: CommandCost): BudgetUsage => ({
  actions: Math.max(0, usage.actions - cost.actions),
  navigations: Math.max(0, usage.navigations - cost.navigations),
});

type ChargeRequest = {
  command: BrowserControlCommand;
  controllerId: string;
  turnId: string;
};

type ChargeOutcome =
  | { ledger: CommandBudgetLedger; status: "charged" }
  | { message: string; status: "exceeded" };

/**
 * Charges one command to its chat turn and to the pairing. A command that
 * would cross either limit is refused and charges nothing; page reads are
 * free.
 */
export const chargeCommandBudget = (
  current: CommandBudgetLedger | null,
  { command, controllerId, turnId }: ChargeRequest,
): ChargeOutcome => {
  const ledger =
    current?.controllerId === controllerId
      ? current
      : { controllerId, session: EMPTY_USAGE, turns: [] };
  const cost = commandCost(command);
  const turnUsage =
    ledger.turns.find((turn) => turn.turnId === turnId)?.usage ?? EMPTY_USAGE;
  const nextTurn = add(turnUsage, cost);
  const nextSession = add(ledger.session, cost);

  if (nextSession.actions > BROWSER_CONTROL_LIMITS.sessionActions) {
    return {
      message: `This extension connection has run its ${BROWSER_CONTROL_LIMITS.sessionActions} browser actions. Tell the user what was done; they must reconnect stella from the extension popup to continue.`,
      status: "exceeded",
    };
  }
  if (nextSession.navigations > BROWSER_CONTROL_LIMITS.sessionNavigations) {
    return {
      message: `This extension connection has made its ${BROWSER_CONTROL_LIMITS.sessionNavigations} page navigations. Tell the user what was done; they must reconnect stella from the extension popup to continue.`,
      status: "exceeded",
    };
  }
  if (nextTurn.actions > BROWSER_CONTROL_LIMITS.turnActions) {
    return {
      message: `This chat turn has run its ${BROWSER_CONTROL_LIMITS.turnActions} browser actions. Stop, tell the user what was done, and ask before continuing.`,
      status: "exceeded",
    };
  }
  if (nextTurn.navigations > BROWSER_CONTROL_LIMITS.turnNavigations) {
    return {
      message: `This chat turn has made its ${BROWSER_CONTROL_LIMITS.turnNavigations} page navigations. Stop, tell the user what was done, and ask before continuing.`,
      status: "exceeded",
    };
  }

  return {
    ledger: {
      controllerId,
      session: nextSession,
      turns: [
        ...ledger.turns
          .filter((turn) => turn.turnId !== turnId)
          .slice(-(TRACKED_TURNS - 1)),
        { turnId, usage: nextTurn },
      ],
    },
    status: "charged",
  };
};

/**
 * Gives back a charge for a command the page refused before acting. Only a
 * command that was charged is refunded.
 */
export const refundCommandBudget = (
  current: CommandBudgetLedger | null,
  { command, controllerId, turnId }: ChargeRequest,
): CommandBudgetLedger | null => {
  if (current?.controllerId !== controllerId) {
    return current;
  }
  const cost = commandCost(command);
  return {
    controllerId,
    session: subtract(current.session, cost),
    turns: current.turns.map((turn) =>
      turn.turnId === turnId
        ? { turnId, usage: subtract(turn.usage, cost) }
        : turn,
    ),
  };
};

const parseUsage = (input: unknown): BudgetUsage | null =>
  typeof input === "object" &&
  input !== null &&
  "actions" in input &&
  typeof input.actions === "number" &&
  "navigations" in input &&
  typeof input.navigations === "number"
    ? { actions: input.actions, navigations: input.navigations }
    : null;

const parseTurn = (
  input: unknown,
): { turnId: string; usage: BudgetUsage } | null => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("turnId" in input) ||
    typeof input.turnId !== "string" ||
    !("usage" in input)
  ) {
    return null;
  }
  const usage = parseUsage(input.usage);
  return usage ? { turnId: input.turnId, usage } : null;
};

const parseLedger = (input: unknown): CommandBudgetLedger | null => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("controllerId" in input) ||
    typeof input.controllerId !== "string" ||
    !("session" in input) ||
    !("turns" in input) ||
    !Array.isArray(input.turns)
  ) {
    return null;
  }
  const session = parseUsage(input.session);
  return session
    ? {
        controllerId: input.controllerId,
        session,
        turns: input.turns.map(parseTurn).filter((turn) => turn !== null),
      }
    : null;
};

const readStoredLedger = async (): Promise<CommandBudgetLedger | null> => {
  const stored = await chrome.storage.session.get(
    BROWSER_COMMAND_BUDGET_STORAGE_KEY,
  );
  return parseLedger(stored[BROWSER_COMMAND_BUDGET_STORAGE_KEY]);
};

/**
 * A command's budget, charged by the executor right before it acts, so a
 * command refused beforehand costs nothing. `charge` returns the refusal
 * message when a limit is reached. Callers run inside the control session,
 * so reads and writes never interleave with another command.
 */
export const storedCommandBudget = (request: ChargeRequest) => ({
  async charge(): Promise<string | null> {
    const outcome = chargeCommandBudget(await readStoredLedger(), request);
    if (outcome.status === "exceeded") {
      return outcome.message;
    }
    await chrome.storage.session.set({
      [BROWSER_COMMAND_BUDGET_STORAGE_KEY]: outcome.ledger,
    });
    return null;
  },
  async refund(): Promise<void> {
    const ledger = refundCommandBudget(await readStoredLedger(), request);
    if (ledger !== null) {
      await chrome.storage.session.set({
        [BROWSER_COMMAND_BUDGET_STORAGE_KEY]: ledger,
      });
    }
  },
});

export type CommandBudget = ReturnType<typeof storedCommandBudget>;
