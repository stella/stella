import { panic } from "better-result";

import type { QueryView } from "@/lib/query-view.logic";

export type Availability<T> =
  | { status: "disabled" }
  | { status: "pending" }
  | { status: "error"; error: unknown }
  | { status: "ready"; value: T | undefined };

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
