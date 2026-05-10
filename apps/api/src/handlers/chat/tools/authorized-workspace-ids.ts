import type { SafeId } from "@/api/lib/branded-types";

declare const __authorizedToolWorkspaceIdsBrand: unique symbol;

// A list of workspace IDs that has been verified, in this request, to be
// a subset of the user's currently accessible workspaces. The chat tool
// surface accepts only this branded type so a stale persisted pin or a
// raw body field cannot reach the AI's tools without going through
// `resolveToolWorkspaceIds`.
export type AuthorizedToolWorkspaceIds = SafeId<"workspace">[] & {
  readonly [__authorizedToolWorkspaceIdsBrand]: true;
};

type ResolveToolWorkspaceIdsInput = {
  // Workspace IDs the user pinned for this thread, either fresh from
  // the request body or loaded from the persisted thread row. May be
  // empty and may contain stale IDs the user no longer has access to.
  pinnedIds: readonly SafeId<"workspace">[];
  // The user's currently accessible workspaces, as resolved from the
  // active session. This is the only authoritative source.
  accessibleWorkspaceIds: readonly SafeId<"workspace">[];
};

// Returns the workspace IDs the AI's tools may operate on. Pins are
// always intersected with the currently accessible set so a revoked
// matter cannot be queried through a stale stored pin. If no pins
// remain after intersection, falls back to the full accessible set so
// the AI can still discover relevant matters via its read-only API.
// SAFETY: Branding an array as `AuthorizedToolWorkspaceIds`
// asserts that every element has been verified against the
// session's accessible workspaces. Both branches of this function
// either copy the accessible set verbatim or filter by it, so the
// brand is sound. Keep this assertion local to this module — no
// other code path may construct a value of this brand without
// going through this function or `intersectAccessibleWorkspaceIds`.
const brand = (ids: SafeId<"workspace">[]): AuthorizedToolWorkspaceIds =>
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  ids as AuthorizedToolWorkspaceIds;

export const resolveToolWorkspaceIds = ({
  pinnedIds,
  accessibleWorkspaceIds,
}: ResolveToolWorkspaceIdsInput): AuthorizedToolWorkspaceIds => {
  if (pinnedIds.length === 0) {
    return brand([...accessibleWorkspaceIds]);
  }
  const accessible = new Set<string>(accessibleWorkspaceIds);
  const intersected = pinnedIds.filter((id) => accessible.has(id));
  if (intersected.length === 0) {
    return brand([...accessibleWorkspaceIds]);
  }
  return brand(intersected);
};

// Narrows persisted pins to the currently accessible set without the
// "fall back to all accessible" behaviour. Use this when persisting
// the effective context back to the thread row, so stale IDs are
// stripped from storage rather than silently re-authorized later.
export const intersectAccessibleWorkspaceIds = ({
  pinnedIds,
  accessibleWorkspaceIds,
}: ResolveToolWorkspaceIdsInput): SafeId<"workspace">[] => {
  if (pinnedIds.length === 0) {
    return [];
  }
  const accessible = new Set<string>(accessibleWorkspaceIds);
  return pinnedIds.filter((id) => accessible.has(id));
};
