import type { AhoCorasick as ThreadedAhoCorasick } from "@stll/aho-corasick-wasm";
import type { AhoCorasick as SingleThreadAhoCorasick } from "@stll/aho-corasick-wasm/single-thread";
// oxlint-disable-next-line import/default -- Vite ?url import returns the asset URL as default export
import singleThreadWasmUrl from "@stll/aho-corasick-wasm/single-thread/wasm?url";

import { loadWasmBuild } from "./load-wasm-build";

export const AhoCorasick = await loadWasmBuild<
  typeof ThreadedAhoCorasick | typeof SingleThreadAhoCorasick
>({
  isolated: globalThis.crossOriginIsolated,
  threaded: async () => (await import("@stll/aho-corasick-wasm")).AhoCorasick,
  singleThread: async () => {
    const build = await import("@stll/aho-corasick-wasm/single-thread");
    await build.init(singleThreadWasmUrl);
    return build.AhoCorasick;
  },
});
