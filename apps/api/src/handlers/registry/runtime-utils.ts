import type { ActionContextOf, ActorContext } from "rivetkit";

import type { ActorEvent } from "@stella/rivet/types";

import type { ActorsUnion } from "@/api/handlers/registry";

type AnyActorContext = ActorContext<
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  undefined
>;

/** Context with a broadcast method. Accepts any actor context (including chat). */
type BroadcastCapableContext = Pick<AnyActorContext, "broadcast">;

export const broadcastEvent = (c: BroadcastCapableContext, event: ActorEvent) =>
  c.broadcast(event.name, event.data);

export const resetActorState = <TContext extends ActionContextOf<ActorsUnion>>(
  c: TContext,
  defaultState: TContext["state"],
) => {
  for (const key in defaultState) {
    if (Object.hasOwn(defaultState, key)) {
      // @ts-expect-error - this is valid
      c.state[key] = defaultState[key];
    }
  }
};
