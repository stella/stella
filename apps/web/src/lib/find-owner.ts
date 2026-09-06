import type { RefObject } from "react";

import { matchesKeyboardEvent } from "@tanstack/react-hotkeys";
import type { Hotkey } from "@tanstack/react-hotkeys";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { resolveFindOwner } from "@/lib/find-owner.logic";
import type {
  FindCandidate,
  FindOwner,
  FindScope,
} from "@/lib/find-owner.logic";
import { HOTKEYS } from "@/lib/hotkeys";
import { useEffectiveHotkey } from "@/lib/use-effective-shortcuts";

type FindSurface = {
  bar: RefObject<HTMLElement | null> | undefined;
  onFind: () => void;
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
 * The binding every surface answers, refreshed by each mounted surface from
 * the user's effective shortcuts. Module state rather than a value per
 * surface: one shortcut matched in one place is what stops a rebind from
 * leaving the panes listening for different keys.
 */
let findHotkey: Hotkey = HOTKEYS.FIND;

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
 * The app's only listener for the find shortcut. It runs in the capture phase
 * so the press never reaches the document's bubble phase, where Folio's own
 * find/replace dialog listens unscoped (`useKeyboardShortcuts` in
 * `@stll/folio-react`) and would open a second bar on top of the one that won.
 *
 * Surfaces do not bind the shortcut and stand down; they register and are
 * called. A surface that never wins therefore cannot touch the event, and a
 * fourth surface added later cannot reintroduce the two-bar bug, because
 * binding a listener is not how a surface takes part.
 */
const handleFindKeyDown = (event: KeyboardEvent) => {
  if (!matchesKeyboardEvent(event, findHotkey)) {
    return;
  }

  // Candidates stay paired with the surface that produced them: two instances
  // of one owner overlap during a route transition, and only the one still on
  // screen may be handed the press.
  const entries = Array.from(surfaces.values(), (surface) => ({
    candidate: toCandidate(surface, event.target),
    surface,
  }));
  const owner = resolveFindOwner(entries.map((entry) => entry.candidate));
  const winner = entries.find(
    (entry) => entry.candidate.owner === owner && entry.candidate.reachable,
  );
  // No owner (`owner` is null, which no candidate carries) leaves the event
  // untouched: not prevented, not stopped. That is what keeps Cmd/Ctrl+F
  // opening the browser's own find inside a command palette or a modal input.
  if (!winner) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  winner.surface.onFind();
};

type UseFindSurfaceOptions = {
  /**
   * The surface's find bar when it is portaled out of the pane: a press with
   * the caret already in the bar is inside the surface, wherever the popup
   * landed in the document.
   */
  bar?: RefObject<HTMLElement | null>;
  /** While false the surface is not a candidate and its bar cannot open. */
  enabled: boolean;
  /** Opens this surface's find bar. Called once, for a press it wins. */
  onFind: () => void;
  owner: FindOwner;
  /** The surface's own pane: bounds both "inside" and "on screen". */
  root: RefObject<HTMLElement | null>;
  scope: FindScope;
};

/**
 * Register a find bar as a candidate for the find shortcut while `enabled`.
 * This is the only way to answer that shortcut in `apps/web`: the registry
 * owns the listener and calls {@link UseFindSurfaceOptions.onFind} for the
 * press it awards, so a surface never has to decide, prevent, or suppress
 * anything itself.
 */
export const useFindSurface = ({
  bar,
  enabled,
  onFind,
  owner,
  root,
  scope,
}: UseFindSurfaceOptions): void => {
  const hotkey = useEffectiveHotkey("find");
  // Stable, and reads the latest committed closure: the registration below
  // must survive a re-render without re-registering.
  const handleFind = useLatestCallback(onFind);

  useExternalSyncEffect(() => {
    findHotkey = hotkey;
  }, [hotkey]);

  useExternalSyncEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const id = Symbol(owner);
    if (surfaces.size === 0) {
      document.addEventListener("keydown", handleFindKeyDown, {
        capture: true,
      });
    }
    surfaces.set(id, { bar, onFind: handleFind, owner, root, scope });
    return () => {
      surfaces.delete(id);
      if (surfaces.size === 0) {
        document.removeEventListener("keydown", handleFindKeyDown, {
          capture: true,
        });
      }
    };
  }, [bar, enabled, handleFind, owner, root, scope]);
};
