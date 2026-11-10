import type { RegexSet as ThreadedRegexSet } from "@stll/regex-set-wasm";
import type { RegexSet as SingleThreadRegexSet } from "@stll/regex-set-wasm/single-thread";

import { loadWasmBuild } from "@/lib/platform/wasm-build.logic";

export const RegexSet = await loadWasmBuild<
  typeof ThreadedRegexSet | typeof SingleThreadRegexSet
>({
  isolated: globalThis.crossOriginIsolated,
  threaded: async () => (await import("@stll/regex-set-wasm")).RegexSet,
  singleThread: async () => {
    const [build, wasm] = await Promise.all([
      import("@stll/regex-set-wasm/single-thread"),
      import("@stll/regex-set-wasm/single-thread/wasm?url"),
    ]);
    await build.init(wasm.default);
    return build.RegexSet;
  },
});
