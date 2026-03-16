import type { ActorEvent } from "@stella/rivet/types";

// --- Event handler utility ---

type ExtractEventData<T extends ActorEvent["name"]> = Extract<
  ActorEvent,
  { name: T }
>["data"];

export const eventHandler = <TName extends ActorEvent["name"]>(
  eventName: TName,
  handler: (data: ExtractEventData<TName>) => void | Promise<void>,
) => [eventName, handler] as const;

// --- Typed event handler from actor definition ---

// Extract typed event payloads from an actor definition's
// `events` config using the `_eventType` phantom field.
type ExtractActorEvents<TActor> = TActor extends {
  config: { events?: infer E };
}
  ? {
      [K in keyof E]: E[K] extends { _eventType?: infer T } ? T : never;
    }
  : Record<string, never>;

export const eventHandlerV2 =
  <TActor>() =>
  <TName extends keyof ExtractActorEvents<TActor> & string>(
    eventName: TName,
    handler: (data: ExtractActorEvents<TActor>[TName]) => void | Promise<void>,
  ) =>
    [eventName, handler] as const;

export const createEventHandler =
  <TActor>() =>
  <TName extends keyof ExtractActorEvents<TActor> & string>(
    eventName: TName,
    handler: (data: ExtractActorEvents<TActor>[TName]) => void | Promise<void>,
  ) =>
    [eventName, handler] as const;
