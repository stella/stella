import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import type { ActorOptions } from "@rivetkit/framework-base";
import { panic } from "better-result";

import type { Registry } from "@stella/api/types";

import type { Actors } from "@/lib/api";
import { useActor } from "@/lib/api";

type ActorName = keyof Actors;

type UseActorReturn<N extends ActorName> = ReturnType<typeof useActor<N>>;

type SuspenseActorReturn<N extends ActorName> = Omit<
  UseActorReturn<N>,
  "handle" | "connection" | "connStatus"
> & {
  handle: NonNullable<UseActorReturn<N>["handle"]>;
  connection: NonNullable<UseActorReturn<N>["connection"]>;
  connStatus: "connected";
};

/**
 * Creates a typed actor context provider and hook pair for
 * a specific actor name.
 *
 * The provider calls `useActor` with the given config and
 * only renders children once connected, showing the fallback
 * while the connection is pending.
 *
 * Usage:
 * ```ts
 * const {
 *   ActorProvider: ChatActorProvider,
 *   useSuspenseActor: useSuspenseChatActor,
 * } = createActorProvider<"chat">();
 * ```
 */
export const createActorProvider = <TName extends ActorName>() => {
  const ActorContext = createContext<UseActorReturn<TName> | null>(null);

  const ActorProvider = ({
    config,
    children,
    fallback,
  }: {
    config: ActorOptions<Registry, TName>;
    children: ReactNode;
    fallback?: ReactNode;
  }) => {
    const actor = useActor<TName>(config);

    const content = actor.isConnected ? children : (fallback ?? null);

    return (
      <ActorContext.Provider value={actor}>{content}</ActorContext.Provider>
    );
  };

  const useSuspenseActor = (): SuspenseActorReturn<TName> => {
    const actor = useContext(ActorContext);
    if (!actor) {
      panic("useSuspenseActor requires ActorProvider");
    }

    if (actor.isConnected) {
      // SAFETY: connection is non-null; narrow the type.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      return actor as unknown as SuspenseActorReturn<TName>;
    }

    if (actor.error) {
      throw actor.error;
    }

    // Children are only rendered when connected, so this
    // should be unreachable from normal component code.
    panic("useSuspenseActor: actor not connected");
  };

  return { ActorProvider, useSuspenseActor };
};
