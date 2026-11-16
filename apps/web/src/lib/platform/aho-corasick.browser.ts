import type { AhoCorasick as ThreadedAhoCorasick } from "@stll/aho-corasick-wasm";
import type { AhoCorasick as SingleThreadAhoCorasick } from "@stll/aho-corasick-wasm/single-thread";

import { loadWasmBuild } from "@/lib/platform/wasm-build.logic";

export const AhoCorasick = await loadWasmBuild<
  typeof ThreadedAhoCorasick | typeof SingleThreadAhoCorasick
>({
  isolated: globalThis.crossOriginIsolated,
  threaded: async () => (await import("@stll/aho-corasick-wasm")).AhoCorasick,
  singleThread: async () => {
    const [build, wasm] = await Promise.all([
      import("@stll/aho-corasick-wasm/single-thread"),
      import("@stll/aho-corasick-wasm/single-thread/wasm?url"),
    ]);
    await build.init(wasm.default);
    return build.AhoCorasick;
  },
});
