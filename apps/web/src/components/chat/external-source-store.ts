import { create } from "zustand";

export type ExternalSourceReference = {
  connectorSlug?: string | undefined;
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
          sourcesByUrl[source.url] = {
            ...sourcesByUrl[source.url],
            ...source,
          };
        }
        return { sourcesByUrl };
      }),
  }),
);
