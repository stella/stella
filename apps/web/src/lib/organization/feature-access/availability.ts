import { panic } from "better-result";

import type { QueryView } from "@/lib/query-view.logic";

export type Availability<T> =
  | { status: "disabled" }
  | { status: "pending" }
  | { status: "error"; error: unknown }
  | { status: "ready"; value: T | undefined };

const selectAvailability = (
  states: readonly [Availability<unknown>, ...Availability<unknown>[]],
  precedence: readonly Availability<unknown>["status"][],
): Availability<void> => {
  for (const status of precedence) {
    const state = states.find((candidate) => candidate.status === status);
    if (state?.status === "error") {
      return state;
    }
    if (state?.status === "ready") {
      return { status: "ready", value: undefined };
    }
    if (state?.status === "pending") {
      return { status: "pending" };
    }
    if (state?.status === "disabled") {
      return { status: "disabled" };
    }
  }
  return panic("Cannot combine an empty availability list");
};

/** Any prerequisite is met with precedence ready > pending > error > disabled. */
export const anyAvailable = (
  ...states: readonly [Availability<unknown>, ...Availability<unknown>[]]
): Availability<void> =>
  selectAvailability(states, ["ready", "pending", "error", "disabled"]);

/** Every prerequisite is met with precedence disabled > error > pending > ready. */
export const allAvailable = (
  ...states: readonly [Availability<unknown>, ...Availability<unknown>[]]
): Availability<void> =>
  selectAvailability(states, ["disabled", "error", "pending", "ready"]);

export const queryAvailability = <T, E>(
  enabled: boolean,
  view: QueryView<T, E>,
): Availability<T> => {
  if (!enabled) {
    return { status: "disabled" };
  }
  switch (view.type) {
    case "pending":
      return { status: "pending" };
    case "error":
      return { status: "error", error: view.error };
    case "empty":
      return { status: "ready", value: undefined };
    case "items":
      return { status: "ready", value: view.items };
    default:
      view satisfies never;
      return panic("Unknown query availability");
  }
};
