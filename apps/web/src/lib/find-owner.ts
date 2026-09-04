import { useSyncExternalStore } from "react";

import { useExternalSyncEffect } from "@/hooks/use-effect";

/**
 * Which find bar Cmd/Ctrl+F belongs to right now.
 *
 * Two can be mounted at once: the inspector's external-reference preview and a
 * table view's. Both bind the shortcut, so without an owner which one opens is
 * mount-order luck and both can open together. Precedence is this array's
 * order, and the inspector leads because it is the surface in front of the
 * reader while it is showing a document.
 */
export const FIND_OWNERS = ["inspector", "table"] as const;

export type FindOwner = (typeof FIND_OWNERS)[number];

const claims = new Set<FindOwner>();
const listeners = new Set<() => void>();
let owner: FindOwner | null = null;

const republish = () => {
  const next = FIND_OWNERS.find((candidate) => claims.has(candidate)) ?? null;
  if (next === owner) {
    return;
  }
  owner = next;
  for (const listener of listeners) {
    listener();
  }
};

const claimFind = (candidate: FindOwner): (() => void) => {
  claims.add(candidate);
  republish();
  return () => {
    claims.delete(candidate);
    republish();
  };
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): FindOwner | null => owner;

// Nothing claims the shortcut during SSR: there is no keyboard yet, and a
// server snapshot that disagreed with the first client render would hydrate
// mismatched.
const getServerSnapshot = (): FindOwner | null => null;

/**
 * Claim Cmd/Ctrl+F for this surface while `enabled`, and report whether the
 * claim currently wins. Pass the result to `useHotkey`'s `enabled` so the
 * losing bar keeps its registration (and stays visible in devtools) without
 * firing.
 */
export const useOwnsFind = (
  candidate: FindOwner,
  enabled: boolean,
): boolean => {
  useExternalSyncEffect(
    () => (enabled ? claimFind(candidate) : undefined),
    [candidate, enabled],
  );
  return (
    useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) ===
    candidate
  );
};
