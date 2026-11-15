import { describe, expect, test } from "bun:test";

import {
  DEPENDENCY_WASI_WORKERS,
  referencedAssetPath,
  resolveSourceWorkerEntry,
  workerEntryFileName,
  workerSourceSpecifiers,
} from "./runtime-asset-contracts";

describe("runtime asset contracts", () => {
  test("each WASI producer has a distinct asset matching its own contract", () => {
    const workers = Object.values(DEPENDENCY_WASI_WORKERS);
    const emittedNames = new Set<string>();
    for (const worker of workers) {
      for (const prefix of [
        "/checkout/node_modules",
        "/cache/links/package/node_modules",
        "C:\\checkout\\node_modules",
      ]) {
        for (const query of ["", "?worker_file&type=module"]) {
          const sourcePath = `${prefix}${worker.sourceEntry}${query}`;
          const name = workerEntryFileName({ facadeModuleId: sourcePath });
          const asset = `dist/client/${name.replace("[hash]", "abcdefgh")}`;
          expect(
            new Bun.Glob(
              `dist/client/assets/${worker.assetStem}-????????.js`,
            ).match(asset),
          ).toBe(true);
          expect(name).not.toContain("[name]");
          emittedNames.add(name);
        }
      }
    }
    expect(emittedNames.size).toBe(workers.length);
  });

  test("unregistered workers retain their default names and cannot claim a WASI contract", () => {
    for (const facadeModuleId of [
      null,
      "/checkout/src/workers/pdf-search-worker.ts",
      "/checkout/node_modules/another-package/dist/wasi-worker-browser.mjs",
    ]) {
      const name = workerEntryFileName({ facadeModuleId });
      expect(name).toBe("assets/[name]-[hash].js");
      for (const { assetStem } of Object.values(DEPENDENCY_WASI_WORKERS)) {
        expect(
          new Bun.Glob(`assets/${assetStem}-????????.js`).match(
            name
              .replace("[name]", "wasi-worker-browser")
              .replace("[hash]", "abcdefgh"),
          ),
        ).toBe(false);
      }
    }
  });

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
