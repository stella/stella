import type { RefObject } from "react";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { resolveFindOwner } from "@/lib/find-owner.logic";
import type {
  FindCandidate,
  FindOwner,
  FindScope,
} from "@/lib/find-owner.logic";

type FindSurface = {
  bar: RefObject<HTMLElement | null> | undefined;
  owner: FindOwner;
  root: RefObject<HTMLElement | null>;
  scope: FindScope;
};

// Keyed by the identity handed out at registration rather than by owner: React
// runs a mount/cleanup/mount cycle in development, and two instances of one
// surface overlap during a route transition, so a per-owner slot would let the
// older instance's cleanup delete the live one's registration. Nothing
// subscribes: ownership is decided per key press, not per render.
const surfaces = new Map<symbol, FindSurface>();

/**
 * `offsetParent` is null while an inspector tab is CSS-hidden, which is how
 * the pane keeps background tabs mounted; Base UI marks everything outside an
 * open modal `inert` (`aria-hidden` where `inert` is unsupported). Either way
 * the surface is not what the user is looking at, so it does not get the key.
 */
const isOnScreen = (root: HTMLElement | null): boolean =>
  root !== null &&
  root.offsetParent !== null &&
  root.closest("[inert], [aria-hidden='true']") === null;

const contains = (
  element: HTMLElement | null | undefined,
  target: EventTarget | null,
): boolean =>
  element !== null &&
  element !== undefined &&
  target instanceof Node &&
  element.contains(target);

const toCandidate = (
  surface: FindSurface,
  target: EventTarget | null,
): FindCandidate => {
  const root = surface.root.current;
  return {
    containsTarget:
      contains(root, target) || contains(surface.bar?.current, target),
    owner: surface.owner,
    reachable: isOnScreen(root),
    scope: surface.scope,
  };
};

/**
 * Whether this surface's find bar owns the key press. Ask before calling
 * `preventDefault`: a surface that does not own the press must leave the event
 * untouched, so the browser's own find still opens when no bar claims it.
 */
export const ownsFindKeyEvent = (
  owner: FindOwner,
  event: { target: EventTarget | null },
): boolean =>
  resolveFindOwner(
    Array.from(surfaces.values(), (surface) =>
      toCandidate(surface, event.target),
    ),
  ) === owner;

type UseFindSurfaceOptions = {
  /**
   * The surface's find bar when it is portaled out of the pane: a press with
   * the caret already in the bar is inside the surface, wherever the popup
   * landed in the document.
   */
  bar?: RefObject<HTMLElement | null>;
  /** While false the surface is not a candidate and its bar cannot open. */
  enabled: boolean;
  owner: FindOwner;
  /** The surface's own pane: bounds both "inside" and "on screen". */
  root: RefObject<HTMLElement | null>;
  scope: FindScope;
};

/**
 * Register a find bar as a candidate for Cmd/Ctrl+F while `enabled`. Every
 * surface that binds the shortcut must register, then gate its handler on
 * {@link ownsFindKeyEvent}.
 */
export const useFindSurface = ({
  bar,
  enabled,
  owner,
  root,
  scope,
}: UseFindSurfaceOptions): void => {
  useExternalSyncEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const id = Symbol(owner);
    surfaces.set(id, { bar, owner, root, scope });
    return () => {
      surfaces.delete(id);
    };
  }, [bar, enabled, owner, root, scope]);
};
