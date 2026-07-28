import type { ChatAnonResult, ChatAnonRuntime } from "@stll/anonymize-chat";

/**
 * The landing demo's anonymization pipeline: stella's real wasm engine, wired
 * to the fixed public-demo workspace. Shared by the demo worker (which runs it
 * in the browser) and `scripts/precompute-anonymize-demo-sample.ts` (which runs
 * it under Bun to regenerate the sample's precomputed highlights), so the
 * precomputed result cannot drift from what a visitor actually sees.
 *
 * Every dependency is imported dynamically, by design: the worker imports this
 * module at evaluation time, and a static import that fails to resolve would
 * abort that evaluation before the worker installs its message listener,
 * leaving the page waiting for a reply no code is left to send. Keep this
 * module free of top-level value imports.
 */

// Public demo has no organisation, so no blacklist/gazetteer/exclusion input
// is needed; every visitor gets the same fixed workspace id and locale.
const DEMO_WORKSPACE_ID = "landing-demo";
const DEMO_LOCALE = "en";

// The chat→AI pipeline keeps places by default (see anonymize-chat); this is a
// capability showcase, so we opt into the deny-list and load city dictionaries
// for the countries a visitor is most likely to type. City names resolve to the
// "address" label. Kept to a focused set so the worker payload stays reasonable.
const DEMO_DENYLIST_COUNTRIES = [
  "US",
  "GB",
  "FR",
  "DE",
  "CZ",
  "IT",
  "ES",
  "NL",
] as const;

export type DemoEngine = { run: (text: string) => Promise<ChatAnonResult> };

/**
 * Resolves the wasm runtime plus the dictionaries the deny-list layer needs:
 * names (for the person corpus) and per-country city lists. `citiesByCountry`
 * drives detection; `cities` is the flat merge the pipeline also expects.
 * `loadCityDictionary` (0.0.8+) resolves each country through a literal-
 * specifier loader map, so the city JSON stays bundler-visible (one lazy chunk
 * per country) and a load failure throws instead of silently yielding an empty
 * list.
 */
export const loadDemoEngine = async (): Promise<DemoEngine> => {
  const [
    { Buffer },
    { runChatAnonPipeline },
    { loadNameDictionaries },
    { loadCityDictionary },
    anonymizeRuntime,
  ] = await Promise.all([
    // eslint-disable-next-line unicorn/prefer-node-protocol -- this is the `buffer` browser-polyfill package (npm, no Node dependency), not Node's own `node:buffer` core module; `node:buffer` would not resolve the same way in a browser/worker bundle
    import("buffer"),
    import("@stll/anonymize-chat"),
    import("@stll/anonymize-data"),
    import("@stll/anonymize-data/cities"),
    import("@stll/anonymize-wasm"),
  ]);

  // The napi-rs/emnapi wasm binding (@stll/anonymize-wasm's native glue) checks
  // `globalThis.Buffer` for some Node-API operations; browsers/workers have no
  // such global, so it throws "NotSupportBufferError" the first time that path
  // is hit at runtime. Node itself would provide this for free — a worker in a
  // real browser needs the polyfill installed before the pipeline actually
  // runs, which this is: the modules above only read it once `run` is called.
  // eslint-disable-next-line typescript/no-unnecessary-condition -- ambient lib types claim globalThis.Buffer always exists; a real browser/worker genuinely may not have it, which is exactly the runtime gap this line covers
  globalThis.Buffer ??= Buffer;

  const [names, cityResults] = await Promise.all([
    loadNameDictionaries(),
    Promise.all(
      DEMO_DENYLIST_COUNTRIES.map(
        async (country) =>
          [country, await loadCityDictionary(country)] as const,
      ),
    ),
  ]);
  const citiesByCountry = Object.fromEntries(cityResults);
  const cities = cityResults.flatMap(([, entries]) => entries);
  const dictionaries = { ...names, cities, citiesByCountry };
  const runtime: ChatAnonRuntime = {
    getBinding: anonymizeRuntime.getBinding,
    createNativePipelineFromConfig:
      anonymizeRuntime.createNativePipelineFromConfig,
    createPipelineContext: anonymizeRuntime.createPipelineContext,
    deanonymise: anonymizeRuntime.deanonymise,
  };

  return {
    run: async (text) =>
      await runChatAnonPipeline({
        runtime,
        dictionaries,
        text,
        locale: DEMO_LOCALE,
        workspaceId: DEMO_WORKSPACE_ID,
        gazetteerEntries: [],
        enableDenyList: true,
        denyListCountries: DEMO_DENYLIST_COUNTRIES,
        // Showcase: also catch a numbered street with no recognized city
        // ("14 Rue de la Paix"), scoped to the demo countries' street types.
        standaloneStreetDetection: "houseNumberAnchored",
        context: anonymizeRuntime.createPipelineContext(),
      }),
  };
};
