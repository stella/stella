import type { LookupOutcome } from "@/api/lib/docx/lookup-fields";

const LOOKUP_PREVIEW_CACHE_MAX = 500;

type GetLookupPreviewOutcomeOptions = {
  key: string;
  load: () => Promise<LookupOutcome>;
};

export const createLookupPreviewCache = () => {
  const outcomes = new Map<string, LookupOutcome>();
  let generation = 0;

  const clear = () => {
    const evictedEntries = outcomes.size;
    outcomes.clear();
    generation += 1;
    return evictedEntries;
  };

  const remember = (key: string, outcome: LookupOutcome) => {
    if (outcome.type === "error") {
      return;
    }
    if (outcomes.size >= LOOKUP_PREVIEW_CACHE_MAX) {
      const oldest = outcomes.keys().next().value;
      if (oldest !== undefined) {
        outcomes.delete(oldest);
      }
    }
    outcomes.set(key, outcome);
  };

  const getOrLoad = async ({ key, load }: GetLookupPreviewOutcomeOptions) => {
    const cached = outcomes.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const loadGeneration = generation;
    const outcome = await load();
    if (loadGeneration === generation) {
      remember(key, outcome);
    }
    return outcome;
  };

  return { clear, getOrLoad };
};

const lookupPreviewCache = createLookupPreviewCache();

/** Drop reconstructible registry results when the runtime reports memory pressure. */
export const clearLookupPreviewCache = () => lookupPreviewCache.clear();

export const getLookupPreviewOutcome = async (
  options: GetLookupPreviewOutcomeOptions,
) => lookupPreviewCache.getOrLoad(options);
