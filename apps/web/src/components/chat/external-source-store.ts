import { create } from "zustand";

import type { BusinessRegistrySlug } from "@stll/api-contract";

import type { DecisionCitationMetadata } from "@/components/references/decision-citation-chip.logic";

export type BusinessRegistrySourceReference = {
  registry: BusinessRegistrySlug;
  companyId: string;
};

/** A decision from stella's own corpus: it opens in stella, not at its publisher. */
export type CaseLawDecisionSourceReference = {
  caseNumber: string;
  decisionId: string;
  citation?:
    | Pick<
        DecisionCitationMetadata,
        "court" | "courtShortCode" | "decisionDate"
      >
    | undefined;
};

export type ExternalSourceReference = {
  sourceUrl?: string | undefined;
  businessRegistry?: BusinessRegistrySourceReference | undefined;
  caseLawDecision?: CaseLawDecisionSourceReference | undefined;
  connectorSlug?: string | undefined;
  iconHref?: string | undefined;
  provider?: string | undefined;
  snippet?: string | undefined;
  sourceToolName?: string | undefined;
  text?: string | undefined;
  title: string;
  url: string;
};

const sourceKey = (url: string) =>
  URL.canParse(url) ? new URL(url).href : url;

type ExternalSourceState = {
  sourcesByUrl: Record<string, ExternalSourceReference>;
  getSource: (url: string) => ExternalSourceReference | undefined;
  getDecisionSource: (ref: string) => ExternalSourceReference | undefined;
  registerSources: (sources: ExternalSourceReference[]) => void;
};

export const useExternalSourceStore = create<ExternalSourceState>()(
  (set, get) => ({
    sourcesByUrl: {},
    getSource: (url) => get().sourcesByUrl[sourceKey(url)],
    getDecisionSource: (ref) =>
      Object.values(get().sourcesByUrl).find(
        (source) => source.caseLawDecision?.decisionId === ref,
      ),
    registerSources: (sources) =>
      set((state) => {
        const sourcesByUrl = { ...state.sourcesByUrl };
        for (const source of sources) {
          const existing =
            sourcesByUrl[sourceKey(source.url)] ??
            (source.sourceUrl === undefined
              ? undefined
              : sourcesByUrl[sourceKey(source.sourceUrl)]);
          const merged = {
            ...existing,
            ...source,
            // A publisher-only refresh enriches the citation without replacing its reader.
            url:
              existing?.sourceUrl !== undefined &&
              sourceKey(source.url) === sourceKey(existing.sourceUrl)
                ? existing.url
                : source.url,
            sourceUrl: source.sourceUrl ?? existing?.sourceUrl,
            businessRegistry:
              source.businessRegistry ?? existing?.businessRegistry,
            caseLawDecision:
              source.caseLawDecision ?? existing?.caseLawDecision,
          };
          for (const url of [source.url, merged.url, merged.sourceUrl]) {
            if (url !== undefined) {
              sourcesByUrl[sourceKey(url)] = merged;
            }
          }
        }
        return { sourcesByUrl };
      }),
  }),
);
