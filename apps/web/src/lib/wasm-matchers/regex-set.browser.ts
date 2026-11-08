import type { RegexSet as ThreadedRegexSet } from "@stll/regex-set-wasm";
import type { RegexSet as SingleThreadRegexSet } from "@stll/regex-set-wasm/single-thread";
// oxlint-disable-next-line import/default -- Vite ?url import returns the asset URL as default export
import singleThreadWasmUrl from "@stll/regex-set-wasm/single-thread/wasm?url";

import { loadWasmBuild } from "./load-wasm-build";

export const RegexSet = await loadWasmBuild<
  typeof ThreadedRegexSet | typeof SingleThreadRegexSet
>({
  isolated: globalThis.crossOriginIsolated,
  threaded: async () => (await import("@stll/regex-set-wasm")).RegexSet,
  singleThread: async () => {
    const build = await import("@stll/regex-set-wasm/single-thread");
    await build.init(singleThreadWasmUrl);
    return build.RegexSet;
  },
});
