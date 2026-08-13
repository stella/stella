import { describe, expect, test } from "bun:test";

import {
  referencedAssetPath,
  resolveSourceWorkerEntry,
  workerSourceSpecifiers,
} from "./runtime-asset-contracts";

describe("runtime asset contracts", () => {
  test("discovers every supported Vite worker form", () => {
    const source = `
      new Worker(new URL("./classic.js", import.meta.url));
      new Worker(new URL("./common.cts", import.meta.url));
      new SharedWorker(new URL("@/workers/shared.mts", import.meta.url));
      import worker from "./default?worker";
      import inlineWorker from "./inline?worker&inline";
      import workerUrl from "@/workers/url?worker&url";
      import sharedWorkerUrl from "./shared?sharedworker&url";
    `;

    expect(workerSourceSpecifiers(source)).toEqual([
      "./classic.js",
      "./common.cts",
      "@/workers/shared.mts",
      "./default",
      "./inline",
      "@/workers/url",
      "./shared",
    ]);
  });

  test("resolves aliases and ignores bare package worker imports", async () => {
    const sourceUrl = new URL(
      "../src/lib/pdf/pdfjs-loader.ts",
      import.meta.url,
    );

    expect(await resolveSourceWorkerEntry("./pdfjs-worker", sourceUrl)).toBe(
      "src/lib/pdf/pdfjs-worker.ts",
    );
    expect(
      await resolveSourceWorkerEntry(
        "@/workers/pdf-search-worker.ts",
        sourceUrl,
      ),
    ).toBe("src/workers/pdf-search-worker.ts");
    expect(
      await resolveSourceWorkerEntry("dependency/worker.js", sourceUrl),
    ).toBeUndefined();
  });

  test("keeps emitted graph checks inside the client build", () => {
    expect(
      referencedAssetPath(
        "dist/client/assets/entry.js",
        "https://cdn.example.com/worker.js",
      ),
    ).toBeUndefined();
    expect(
      referencedAssetPath(
        "dist/client/assets/entry.js",
        "data:application/javascript,worker.js",
      ),
    ).toBeUndefined();
    expect(
      referencedAssetPath(
        "dist/client/assets/entry.js",
        "//cdn.example.com/worker.js",
      ),
    ).toBeUndefined();
    expect(
      referencedAssetPath(
        "dist/client/assets/entry.js",
        "./worker-abcd1234.js",
      ),
    ).toBe("dist/client/assets/worker-abcd1234.js");
    expect(
      referencedAssetPath("dist/client/assets/entry.js", "/native/index.wasm"),
    ).toBe("dist/client/native/index.wasm");
  });
});
