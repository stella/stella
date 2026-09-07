import { create } from "zustand";

import type { BusinessRegistrySlug } from "@stll/api-contract";

export type BusinessRegistrySourceReference = {
  registry: BusinessRegistrySlug;
  companyId: string;
};

export type ExternalSourceReference = {
  businessRegistry?: BusinessRegistrySourceReference | undefined;
  connectorSlug?: string | undefined;
  iconHref?: string | undefined;
  provider?: string | undefined;
  snippet?: string | undefined;
  sourceToolName?: string | undefined;
  text?: string | undefined;
  title: string;
  url: string;
};

type ExternalSourceState = {
  sourcesByUrl: Record<string, ExternalSourceReference>;
  getSource: (url: string) => ExternalSourceReference | undefined;
  registerSources: (sources: ExternalSourceReference[]) => void;
};

export const useExternalSourceStore = create<ExternalSourceState>()(
  (set, get) => ({
    sourcesByUrl: {},
    getSource: (url) => get().sourcesByUrl[url],
    registerSources: (sources) =>
      set((state) => {
        const sourcesByUrl = { ...state.sourcesByUrl };
        for (const source of sources) {
          const existing = sourcesByUrl[source.url];
          sourcesByUrl[source.url] = {
            ...existing,
            ...source,
            businessRegistry:
              source.businessRegistry ?? existing?.businessRegistry,
          };
        }
        return { sourcesByUrl };
      }),
  }),
);
