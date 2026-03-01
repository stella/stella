import type { ActorEvent } from "@stella/rivet/types";

type ExtractEventData<T extends ActorEvent["name"]> = Extract<
  ActorEvent,
  { name: T }
>["data"];

export const eventHandler = <TName extends ActorEvent["name"]>(
  eventName: TName,
  handler: (data: ExtractEventData<TName>) => void | Promise<void>,
) => [eventName, handler] as const;
