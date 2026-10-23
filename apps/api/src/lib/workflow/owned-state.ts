export const CELL_SETTLEMENT_OUTCOMES = [
  "answered",
  "notStated",
  "unsupported",
  "refused",
  "failedTransient",
  "failedDeterministic",
] as const;

export type CellSettlementOutcome = (typeof CELL_SETTLEMENT_OUTCOMES)[number];

type CellOwner = {
  runId: string;
  batchId: string;
};

export type OwnedState = "pending" | "errored";

type OwnedAction<S extends OwnedState> = S extends "pending"
  ? "stop" | "restart"
  : "retry";

export type Owned<S extends OwnedState> = {
  state: S;
  owner: CellOwner;
  deadlineAt: Date;
  attempt: 0 | 1;
  actions: readonly OwnedAction<S>[];
};

export type SettledCell =
  | { state: "answered" }
  | { state: "notStated" }
  | { state: "unsupported" }
  | { state: "refused"; actions: readonly ["retry"] }
  | {
      state: "errored";
      actions: readonly ["retry"];
      retry: "automatic" | "manual";
    };

export function actionsForOwned(
  state: "pending",
  deadlineAt: Date,
  now?: Date,
): readonly ("stop" | "restart")[];
export function actionsForOwned(
  state: "errored",
  deadlineAt: Date,
  now?: Date,
): readonly ["retry"];
export function actionsForOwned(
  state: OwnedState,
  deadlineAt: Date,
  now = new Date(),
): readonly ("stop" | "restart" | "retry")[] {
  if (state === "errored") {
    return ["retry"];
  }
  return [deadlineAt <= now ? "restart" : "stop"];
}

const SETTLEMENTS = {
  answered: (): SettledCell => ({ state: "answered" }),
  notStated: (): SettledCell => ({ state: "notStated" }),
  unsupported: (): SettledCell => ({ state: "unsupported" }),
  refused: (): SettledCell => ({ state: "refused", actions: ["retry"] }),
  failedTransient: (owned: Owned<OwnedState>): SettledCell => ({
    state: "errored",
    actions: ["retry"],
    retry: owned.attempt === 0 ? "automatic" : "manual",
  }),
  failedDeterministic: (): SettledCell => ({
    state: "errored",
    actions: ["retry"],
    retry: "manual",
  }),
} satisfies Record<
  CellSettlementOutcome,
  (owned: Owned<OwnedState>) => SettledCell
>;

export const settle = (
  owned: Owned<OwnedState>,
  outcome: CellSettlementOutcome,
): SettledCell => SETTLEMENTS[outcome](owned);
