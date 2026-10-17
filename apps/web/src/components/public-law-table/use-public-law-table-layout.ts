import { useState } from "react";

import { layoutForSurface } from "@/components/public-law-table/public-law-table-layout.logic";
import type { PublicLawTableLayout } from "@/components/public-law-table/public-law-table-layout.logic";

/**
 * Where one public-law table keeps its arrangements and what they mean. A
 * module constant per table, so the hook reads one identity across renders.
 */
export type PublicLawTableLayoutStore<TLayout extends PublicLawTableLayout> = {
  read: () => Record<string, TLayout>;
  write: (layouts: Record<string, TLayout>) => void;
  defaultLayout: TLayout;
};

/**
 * How this browser draws a public-law table on one surface, and how to change
 * it.
 *
 * Local to the browser: the public-law pages are public, so there is no account
 * to hang the arrangement on, and a signed-in reader's choice stays theirs. Per
 * surface (a jurisdiction), because what a row needs to say differs by corpus:
 * a reader who hid a column in Czech law did not say anything about Polish.
 */
export const usePublicLawTableLayout = <TLayout extends PublicLawTableLayout>(
  store: PublicLawTableLayoutStore<TLayout>,
  surface: string,
) => {
  const [layouts, setLayouts] = useState<Record<string, TLayout> | null>(null);
  if (layouts === null) {
    setLayouts(store.read());
  }

  // The same object until the reader changes it: the table compares its
  // controlled state by identity, and a layout rebuilt per render loops it.
  const layout = layoutForSurface({
    defaults: store.defaultLayout,
    layouts,
    surface,
  });

  return {
    layout,
    setLayout: (next: TLayout) => {
      const stored = { ...layouts, [surface]: next };
      setLayouts(stored);
      store.write(stored);
    },
  };
};
