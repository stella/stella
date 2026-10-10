import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { inspectBrowserRuntimeSafety } from "@stll/scripts/src/browser-runtime-safety";

import { escapeVisualScript } from "../src/handlers/visual-sandbox/srcdoc";
import {
  VISUAL_RUNTIME_BUILD_OPTIONS,
  VISUAL_RUNTIME_BYTE_BUDGET,
} from "./visual-sandbox-build-options";

const runtimePath = new URL(
  "../src/handlers/visual-sandbox/generated/runtime.js.txt",
  import.meta.url,
);

describe("visual sandbox runtime asset", () => {
  test("stays within the guest runtime byte budget", () => {
    const bytes = readFileSync(runtimePath).byteLength;
    expect(bytes).toBeLessThanOrEqual(VISUAL_RUNTIME_BYTE_BUDGET);
  });

  test("contains charts without dynamic code and confines markup parsing to templates", async () => {
    const built = await Bun.build({
      ...VISUAL_RUNTIME_BUILD_OPTIONS,
      sourcemap: "external",
      entrypoints: [
        new URL(
          "../src/handlers/visual-sandbox/browser/treemap.harness.ts",
          import.meta.url,
        ).pathname,
      ],
    });
    expect(built.success).toBe(true);
    const artifact = built.outputs.find(
      (output) => output.kind === "entry-point",
    );
    expect(artifact).toBeDefined();
    if (!artifact) {
      throw new TypeError("Chart build requires one artifact");
    }
    const sourceMap = built.outputs.find(
      (output) => output.kind === "sourcemap",
    );
    expect(sourceMap).toBeDefined();
    if (!sourceMap) {
      throw new TypeError("Chart build requires source ownership metadata");
    }
    const metadata: { sources: string[]; sourcesContent: string[] } =
      JSON.parse(await sourceMap.text());
    for (const [index, original] of metadata.sourcesContent.entries()) {
      if (!original.includes("innerHTML")) {
        continue;
      }
      expect(metadata.sources[index]).toMatch(
        /@tanstack[/+]charts.*\/dist\/(?:reconcile|motion|svg-focus-guide-serializer)\.js$/u,
      );
    }
    const source = escapeVisualScript(await artifact.text());
    console.log(
      `Treemap harness bundle: ${new TextEncoder().encode(source).byteLength} raw bytes; ${Bun.gzipSync(source).byteLength} gzip bytes`,
    );
    expect(source).toContain("setColorMode");
    expect(source).toContain("treemap");
    expect(source).not.toMatch(/<\/script|<!--/iu);
    expect(
      inspectBrowserRuntimeSafety(readFileSync(runtimePath, "utf-8")).problems,
    ).toEqual([]);
    const { problems, templateWrites } = inspectBrowserRuntimeSafety(source);
    expect(problems).toEqual([]);
    // The library's SVG reconciliation must actually be inspected.
    expect(templateWrites).toBeGreaterThan(0);
  });

  test("detects code generation and markup writes outside template parsing", () => {
    for (const source of [
      "eval('1')",
      "new Function('return 1')",
      "window['eval']('1')",
      "const node=document.createElement('div');node.innerHTML='x'",
      "function a(){const t=document.createElement('template')} function b(t){t.innerHTML='x'}",
      "const t=document.createElement('template');t['innerHTML']='x'",
    ]) {
      expect(
        inspectBrowserRuntimeSafety(source).problems.length,
      ).toBeGreaterThan(0);
    }
    expect(
      inspectBrowserRuntimeSafety(
        "function parse(document,markup){const t=document.createElement('template');t.innerHTML=markup;return t.content}",
      ).problems,
    ).toEqual([]);
  });
});
