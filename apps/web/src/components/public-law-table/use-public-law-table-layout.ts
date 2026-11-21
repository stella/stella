import { canonicalizePublicCountry } from "@stll/api-contract/public-country-capability";

import { layoutForSurface } from "@/components/public-law-table/public-law-table-layout.logic";
import type {
  PublicLawTableLayout,
  PublicLawTableLayoutUpdate,
} from "@/components/public-law-table/public-law-table-layout.logic";
import type { PresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import { usePresentationPrefs } from "@/lib/account/presentation-prefs/provider";

const layoutStoreBrand = Symbol("public-law-table-layout-store");

type TableLayoutKey = {
  [K in keyof PresentationPrefs]: PresentationPrefs[K] extends Record<
    string,
    PublicLawTableLayout
  >
    ? K
    : never;
}[keyof PresentationPrefs];

/** Derive each corpus's read and write from one preference key. */
export const publicLawTableLayoutStore = <K extends TableLayoutKey>(
  key: K,
  defaultLayout: PresentationPrefs[K][string],
) => ({
  [layoutStoreBrand]: true as const,
  layouts: (prefs: PresentationPrefs) => prefs[key],
  patch: (layouts: PresentationPrefs[K]) =>
    Object.fromEntries([[key, layouts] as const]),
  defaultLayout,
});

type PublicLawTableLayoutStore<TLayout extends PublicLawTableLayout> = {
  readonly [layoutStoreBrand]: true;
  layouts: (prefs: PresentationPrefs) => Record<string, TLayout>;
  patch: (layouts: Record<string, TLayout>) => Partial<PresentationPrefs>;
  defaultLayout: TLayout;
};

/** The same per-jurisdiction layout is available on SSR and the first client render. */
export const usePublicLawTableLayout = <TLayout extends PublicLawTableLayout>(
  store: PublicLawTableLayoutStore<TLayout>,
  surface: string,
) => {
  const jurisdiction = canonicalizePublicCountry(surface);
  const { prefs, setPrefs } = usePresentationPrefs();
  const layouts = store.layouts(prefs);
  const layout = layoutForSurface({
    defaults: store.defaultLayout,
    layouts,
    surface: jurisdiction,
  });
  return {
    layout,
    setLayout: (update: PublicLawTableLayoutUpdate<TLayout>) =>
      setPrefs((latest) => {
        const latestLayouts = store.layouts(latest);
        const current = layoutForSurface({
          defaults: store.defaultLayout,
          layouts: latestLayouts,
          surface: jurisdiction,
        });
        return store.patch({
          ...latestLayouts,
          [jurisdiction]: update(current),
        });
      }),
  };
};
