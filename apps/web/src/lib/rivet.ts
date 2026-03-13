import type { ActorEvent, VanillaOptions } from "@stella/rivet/types";

// --- Actor timeout ---

/** Hard timeout for Rivet actor connection + RPC calls.
 *  Prevents route loaders and queries from hanging
 *  indefinitely when actors are slow to start. */
const ACTOR_TIMEOUT_MS = 10_000;

/** Merge a timeout signal into vanilla actor config options.
 *  Use this for every vanilla `getOrCreate` call so that
 *  forgetting the timeout is a conscious deviation, not an
 *  accidental omission.
 *
 *  @example
 *  const handle = rivet.views.getOrCreate(
 *    ...withActorTimeout(actorConfig, signal),
 *  ); */
export const withActorTimeout = (
  config: VanillaOptions,
  querySignal?: AbortSignal,
): [string[], VanillaOptions[1] & { signal: AbortSignal }] => {
  const timeout = AbortSignal.timeout(ACTOR_TIMEOUT_MS);
  const signal = querySignal
    ? AbortSignal.any([querySignal, timeout])
    : timeout;
  return [config[0], { ...config[1], signal }];
};

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
