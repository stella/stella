import { create } from "zustand";

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

// Counted rather than a flag per surface: a claim is released by an effect
// cleanup, and React runs a mount/cleanup/mount cycle in development, so a
// boolean would leave the surface unclaimed between the two mounts.
type FindClaims = Record<FindOwner, number>;

const NO_CLAIMS: FindClaims = { inspector: 0, table: 0 };

type FindOwnerStore = {
  claims: FindClaims;
  claim: (owner: FindOwner) => void;
  release: (owner: FindOwner) => void;
};

const useFindOwnerStore = create<FindOwnerStore>()((set) => ({
  claims: NO_CLAIMS,
  claim: (owner) => {
    set((state) => ({
      claims: { ...state.claims, [owner]: state.claims[owner] + 1 },
    }));
  },
  release: (owner) => {
    set((state) => ({
      claims: {
        ...state.claims,
        [owner]: Math.max(state.claims[owner] - 1, 0),
      },
    }));
  },
}));

const ownerOf = (claims: FindClaims): FindOwner | null =>
  FIND_OWNERS.find((owner) => claims[owner] > 0) ?? null;

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
  const claim = useFindOwnerStore((state) => state.claim);
  const release = useFindOwnerStore((state) => state.release);

  useExternalSyncEffect(() => {
    if (!enabled) {
      return undefined;
    }
    claim(candidate);
    return () => {
      release(candidate);
    };
  }, [candidate, claim, enabled, release]);

  return useFindOwnerStore((state) => ownerOf(state.claims)) === candidate;
};
