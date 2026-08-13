import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => undefined;

/**
 * False during server rendering and the client's hydration pass, then true.
 */
export const useHydrated = (): boolean =>
  useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
