import { Suspense, createContext, useContext, useMemo, useRef } from "react";
import type { ReactNode } from "react";

import type { ActorOptions } from "@rivetkit/framework-base";

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

type ActorContextValue<N extends ActorName> = {
  actor: UseActorReturn<N>;
  pendingPromise: Promise<void> | null;
};

/**
 * Creates a typed actor context provider and suspense hook
 * pair for a specific actor name.
 *
 * The provider calls `useActor` with the given config,
 * keeps the connection alive above a built-in Suspense
 * boundary, and only renders children once connected.
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
  const ActorContext = createContext<ActorContextValue<TName> | null>(null);

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
    const resolverRef = useRef<(() => void) | null>(null);
    const promiseRef = useRef<Promise<void> | null>(null);

    if (!actor.isConnected) {
      promiseRef.current ??= new Promise<void>((resolve) => {
        resolverRef.current = resolve;
      });
    } else {
      resolverRef.current?.();
      resolverRef.current = null;
      promiseRef.current = null;
    }

    const value = useMemo(
      (): ActorContextValue<TName> => ({
        actor,
        pendingPromise: promiseRef.current,
      }),
      [actor],
    );

    return (
      <ActorContext.Provider value={value}>
        <Suspense fallback={fallback}>{children}</Suspense>
      </ActorContext.Provider>
    );
  };

  const useSuspenseActor = (): SuspenseActorReturn<TName> => {
    const ctx = useContext(ActorContext);
    if (!ctx) {
      throw new Error("useSuspenseActor requires ActorProvider");
    }

    const { actor, pendingPromise } = ctx;

    if (actor.isConnected) {
      // SAFETY: connection is non-null; narrow the type.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      return actor as unknown as SuspenseActorReturn<TName>;
    }

    if (actor.error) {
      throw actor.error;
    }

    if (pendingPromise) {
      // eslint-disable-next-line typescript/only-throw-error
      throw pendingPromise;
    }

    throw new Error("useSuspenseActor: unreachable state");
  };

  return { ActorProvider, useSuspenseActor };
};
