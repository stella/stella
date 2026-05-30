/**
 * Feature-module registry for the layout painter.
 *
 * O(1) dispatch keyed on `Fragment["kind"]`. Modules self-describe their
 * kind; the registry routes each fragment to its module's `render()`. A
 * fallback closes the loop for unknown kinds and for fragments arriving
 * without a resolved block/measure.
 */

import { panic } from "better-result";

import type { Fragment, FlowBlock, Measure } from "../../layout-engine/types";
import { renderFragment } from "../renderFragment";
import type {
  BlockFor,
  FeatureDispatchInput,
  FeatureFallback,
  FeatureModule,
  MeasureFor,
} from "./types";

export type FeatureRegistry = {
  register<TKind extends Fragment["kind"]>(mod: FeatureModule<TKind>): void;
  get<TKind extends Fragment["kind"]>(
    kind: TKind,
  ): FeatureModule<TKind> | undefined;
  has(kind: Fragment["kind"]): boolean;
  render(input: FeatureDispatchInput): HTMLElement;
};

export type CreateFeatureRegistryOptions = {
  /**
   * Hook for unknown kinds and fragments with no resolved block/measure.
   * Defaults to the placeholder renderer in `renderFragment.ts`.
   */
  fallback?: FeatureFallback;
};

const defaultFallback: FeatureFallback = ({ fragment, context, doc }) =>
  renderFragment(fragment, context, { document: doc });

/**
 * Build a new feature registry. Callers register modules, then dispatch via
 * `render()`. The registry never mutates module objects.
 */
export function createFeatureRegistry(
  options: CreateFeatureRegistryOptions = {},
): FeatureRegistry {
  const modules = new Map<Fragment["kind"], FeatureModule>();
  const fallback = options.fallback ?? defaultFallback;

  const register: FeatureRegistry["register"] = (mod) => {
    if (modules.has(mod.kind)) {
      panic(
        `FeatureRegistry: module for kind "${mod.kind}" is already registered`,
      );
    }
    // SAFETY: we store as the erased `FeatureModule` and re-narrow on
    // retrieval; the module's own `kind` is the discriminator that makes
    // this sound. `as unknown` is required because the parametric module
    // type and the erased union don't structurally overlap to TS.
    modules.set(mod.kind, mod as unknown as FeatureModule);
  };

  const get: FeatureRegistry["get"] = <TKind extends Fragment["kind"]>(
    kind: TKind,
  ) => {
    const found = modules.get(kind);
    if (!found) {
      return undefined;
    }
    // SAFETY: the map key is the module's `kind`; the value was registered
    // with a matching TKind. The cast restores the original narrow type.
    return found as unknown as FeatureModule<TKind>;
  };

  const has: FeatureRegistry["has"] = (kind) => modules.has(kind);

  const render: FeatureRegistry["render"] = ({
    fragment,
    block,
    measure,
    context,
    doc,
  }) => {
    const mod = modules.get(fragment.kind);
    if (!mod || !block || !measure) {
      return fallback({ fragment, context, doc });
    }
    return mod.render({
      // SAFETY: map key is the fragment's own discriminator; caller is
      // responsible for supplying a matching block + measure (the painter's
      // block-lookup map guarantees this for the default registry).
      fragment: fragment as FragmentInputFor<typeof mod>,
      block: block as BlockInputFor<typeof mod>,
      measure: measure as MeasureInputFor<typeof mod>,
      context,
      doc,
    });
  };

  return { register, get, has, render };
}

// Helper aliases to keep the cast comments in `render` readable.
type FragmentInputFor<TMod> =
  TMod extends FeatureModule<infer K> ? Extract<Fragment, { kind: K }> : never;
type BlockInputFor<TMod> =
  TMod extends FeatureModule<infer K> ? BlockFor<K> : FlowBlock;
type MeasureInputFor<TMod> =
  TMod extends FeatureModule<infer K> ? MeasureFor<K> : Measure;
