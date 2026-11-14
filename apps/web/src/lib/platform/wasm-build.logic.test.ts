import { describe, expect, test } from "bun:test";

import { loadWasmBuild } from "@/lib/platform/wasm-build.logic";

const builds = () => {
  const loaded: string[] = [];
  return {
    loaded,
    threaded: async () => {
      loaded.push("threaded");
      return "threaded";
    },
    singleThread: async () => {
      loaded.push("single-thread");
      return "single-thread";
    },
  };
};

describe("loadWasmBuild", () => {
  test("a page without cross-origin isolation never loads the threaded build", async () => {
    const { loaded, threaded, singleThread } = builds();
    expect(
      await loadWasmBuild({ isolated: false, threaded, singleThread }),
    ).toBe("single-thread");
    expect(loaded).toEqual(["single-thread"]);
  });

  test("an isolated page loads only the threaded build", async () => {
    const { loaded, threaded, singleThread } = builds();
    expect(
      await loadWasmBuild({ isolated: true, threaded, singleThread }),
    ).toBe("threaded");
    expect(loaded).toEqual(["threaded"]);
  });
});
