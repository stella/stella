import type { ReactNode } from "react";

/**
 * Module-global registry of inspector view kinds. Each route (or
 * shared module) registers the renderer + rail icon for the
 * inspector tab types it owns; the inspector panel dispatches
 * through the registry instead of switching on a closed union.
 *
 * Registrations are idempotent by `type` — re-registering the same
 * kind replaces the previous entry. This keeps HMR sane and lets
 * a route's lazy chunk re-import its registration without leaking
 * stale renderers.
 */
export type InspectorViewKind = string;

export type InspectorNavigationPolicy = "persist" | "close-on-route-leave";

/**
 * Compile-time bound enforcing payloads that survive HTML's
 * structured-clone algorithm — the wire format BroadcastChannel,
 * `postMessage`, IndexedDB, and any future cross-context sync use.
 *
 * Hits as a type error at the `openView` call site when a payload
 * smuggles a function, class instance, symbol, or other unclonable
 * value. Catching it at the boundary keeps the runtime guard in
 * `postTabs` as a defense in depth, not the only line.
 *
 * Allowed: primitives, plain object/array trees, Date / RegExp /
 * Blob / File / ArrayBuffer / DataView / URL, Map / Set of the
 * same. Disallowed: `Function`, `symbol`, `bigint` is allowed
 * because structured clone supports it.
 *
 * Behaviour: each disallowed leaf collapses to a descriptive error
 * string in the type position. Distributed conditional types fan
 * the check across union members so a union containing a function
 * fails the same way.
 */
type StructuredCloneLeaf =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | Date
  | RegExp
  | Blob
  | File
  | ArrayBuffer
  | DataView
  | URL;

export type StructuredCloneable<T> = [T] extends [StructuredCloneLeaf]
  ? T
  : T extends symbol
    ? "Error: symbols are not structured-cloneable"
    : T extends (...args: never[]) => unknown
      ? "Error: functions are not structured-cloneable; pass identifiers and re-derive actions inside the view, or keep handler state in a module-level store"
      : T extends Map<infer K, infer V>
        ? Map<StructuredCloneable<K>, StructuredCloneable<V>>
        : T extends Set<infer V>
          ? Set<StructuredCloneable<V>>
          : T extends readonly (infer U)[]
            ? readonly StructuredCloneable<U>[]
            : T extends object
              ? { [K in keyof T]: StructuredCloneable<T[K]> }
              : T;

/**
 * Shape of a tab as it flows into a registered view's render and
 * rail-icon functions. Mirrors `InspectorTab` but typed against the
 * registration's payload so callers don't have to re-narrow.
 */
export type InspectorViewTab<P> = {
  id: string;
  label: string;
  payload: P;
  ownerRouteId?: string | undefined;
};

export type InspectorViewRenderProps<P> = {
  tab: InspectorViewTab<P>;
  onClose: () => void;
};

export type InspectorRailIconProps<P> = {
  tab: InspectorViewTab<P>;
  active: boolean;
};

export type InspectorViewRegistration<P = unknown> = {
  type: InspectorViewKind;
  render: (props: InspectorViewRenderProps<P>) => ReactNode;
  railIcon: (props: InspectorRailIconProps<P>) => ReactNode;
  navigationPolicy?: InspectorNavigationPolicy;
  /**
   * Runtime payload validator. Required for kinds whose payloads
   * cross the BroadcastChannel sync (otherwise re-hydrated tabs
   * with the new kind would be dropped by the receiver). Optional
   * for view kinds whose tabs are never broadcast.
   */
  validate?: (payload: unknown) => payload is P;
  canRename?: boolean;
  ariaLabel?: (tab: InspectorViewTab<P>) => string;
  /**
   * Cap on simultaneously-mounted instances. Used by view kinds
   * that hold heavy DOM/WebGL state (PDF viewer) to bound memory.
   * The active tab is always mounted; the most recently viewed
   * remaining tabs fill the rest of the slots up to the cap.
   */
  maxMounted?: number;
};

// Registry stores registrations keyed by `type`. The payload-typed
// generic `P` flows through the public API; internally the map
// erases payload typing — every registration's `render`/`railIcon`
// already capture their payload via closure when registered, so the
// retrieved value just needs to be callable with the matching tab.
// SAFETY: a registry like `Map<string, InspectorViewRegistration<unknown>>`
// is the right runtime shape; `unknown` here is wider than each
// stored entry's actual `P`, but every call site re-narrows by
// looking up by `type` and (if relevant) running `validate` on the
// payload before invoking `render`. This is the standard
// "heterogeneous registry" pattern; the structural variance is sound.
type StoredRegistration = InspectorViewRegistration;

const registry = new Map<InspectorViewKind, StoredRegistration>();

export const registerInspectorView = <P>(
  registration: InspectorViewRegistration<P>,
): void => {
  // SAFETY: storage erases `P` — each registration's `render` /
  // `railIcon` capture their typed `P` via closure at registration
  // time, and `validate` re-narrows the payload at retrieval. The
  // assertion is the boundary between the typed registration API
  // and the heterogeneous-registry storage shape.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  registry.set(registration.type, registration as StoredRegistration);
};

export const getInspectorView = (
  type: InspectorViewKind,
): StoredRegistration | undefined => registry.get(type);

export const getRegisteredKinds = (): readonly InspectorViewKind[] => [
  ...registry.keys(),
];
