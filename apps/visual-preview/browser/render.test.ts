import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { chromium } from "playwright-core";

import { VISUAL_PREVIEW_LIMITS } from "@stll/api-contract/visual-preview";

import { renderVisual, VisualRenderTimeoutError } from "../src/render";

const launch = () => chromium.launch({ headless: true });

describe("composed visual preview", () => {
  test("renders a PNG with bounded diagnostics and content size", async () => {
    const result = await renderVisual({
      launch,
      input: {
        document: `<style>html,body{margin:0}body{height:320px;background:#eef}</style><script>
      for (let i=0;i<30;i++) console.error('x'.repeat(600));
      parent.postMessage({kind:'ready'}, '*');
      </script>`,
        viewport: { width: 1200 },
      },
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }
    expect(result.value.readyFired).toBe(true);
    expect(result.value.size).toEqual({ width: 1200, height: 320 });
    expect(result.value.consoleErrors).toHaveLength(20);
    expect(
      result.value.consoleErrors.every((message) => message.length <= 500),
    ).toBe(true);
    expect(Buffer.from(result.value.png, "base64").subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  });
  test("a page referencing an external image renders and reports blocked requests", async () => {
    const result = await renderVisual({
      launch,
      input: {
        document: `<body><img src="https://preview.invalid/example.png"><script>parent.postMessage({kind:'ready'}, '*')</script>`,
        viewport: { width: 1200 },
      },
    });
    const output = result.unwrap();
    expect(output.readyFired).toBe(true);
    expect(output.blockedRequests).toBeGreaterThanOrEqual(1);
  });
  test("reports a missing ready signal and caps tall content", async () => {
    const result = await renderVisual({
      launch,
      input: {
        document:
          '<style>body{height:9000px}</style><script>throw new Error("Example exception")</script>',
        viewport: { width: 1200 },
      },
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }
    expect(result.value.readyFired).toBe(false);
    expect(result.value.size.height).toBe(2400);
    expect(result.value.consoleErrors).toContain("Example exception");
  });
  test("settles fonts and two frames when ready is absent", async () => {
    const result = await renderVisual({
      launch,
      input: {
        document: `<style>html,body{margin:0}body{height:100px}</style><script>
      Object.defineProperty(document.fonts, 'ready', {get: () => new Promise(resolve => setTimeout(() => {
        document.body.style.height = '200px';
        requestAnimationFrame(() => requestAnimationFrame(() => {document.body.style.height = '500px';}));
        resolve(document.fonts);
      }, 50))});
    </script>`,
        viewport: { width: 1200 },
      },
    });
    expect(result.unwrap()).toMatchObject({
      readyFired: false,
      size: { width: 1200, height: 500 },
    });
  });
  test("bounds settlement when the guest fonts never resolve", async () => {
    const started = performance.now();
    const result = await renderVisual({
      launch,
      input: {
        document: `<script>Object.defineProperty(document.fonts, 'ready', {value: new Promise(() => {})});</script>`,
        viewport: { width: 1200 },
      },
    });
    expect(Result.isError(result)).toBe(true);
    expect(performance.now() - started).toBeLessThan(15_000);
  }, 15_000);
  test(
    "returns a typed timeout and closes an unresponsive guest browser",
    async () => {
      const browser = await launch();
      const started = performance.now();
      const result = await renderVisual({
        launch: async () => browser,
        input: {
          document: "<script>for(;;){}</script>",
          viewport: { width: 1200 },
        },
      });
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(VisualRenderTimeoutError.is(result.error)).toBe(true);
        if (VisualRenderTimeoutError.is(result.error)) {
          expect(result.error.readyFired).toBe(false);
        }
      }
      expect(performance.now() - started).toBeLessThan(
        VISUAL_PREVIEW_LIMITS.renderTimeoutMs + 2000,
      );
      expect(browser.isConnected()).toBe(false);
      expect(browser.contexts()).toEqual([]);
    },
    VISUAL_PREVIEW_LIMITS.renderTimeoutMs + 3000,
  );
  test("reports browser startup failure without exception details", async () => {
    const result = await renderVisual({
      launch: async () => {
        throw new Error("Private example");
      },
      input: {
        document: "",
        viewport: { width: 1200 },
      },
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(JSON.stringify(result.error)).not.toContain("Private example");
    }
  });
});

// The same document owner supplies the web frame and the preview; the renderer
// receives its finished srcdoc rather than reconstructing its policy/runtime.
test("previews the canonical composed sandbox document unchanged", async () => {
  const { VISUAL_INNER_POLICY } =
    await import("../../api/src/handlers/visual-sandbox/document");
  const { composeVisualDocument } =
    await import("../../api/src/handlers/visual-sandbox/srcdoc");
  const { sanitizeVisualHtml } =
    await import("../../api/src/handlers/visual-sandbox/sanitize");
  const runtime = await import(
    "../../api/src/handlers/visual-sandbox/generated/runtime.js.txt",
    { with: { type: "text" } }
  );
  const html = sanitizeVisualHtml(
    '<h1>Example composed visual</h1><script>parent.postMessage({kind:"ready"},"*")</script>',
  ).unwrap();
  const document = composeVisualDocument({
    html,
    data: {},
    runtime: runtime.default,
    policy: VISUAL_INNER_POLICY,
  });
  const result = await renderVisual({
    launch,
    input: { document, viewport: { width: 1200 } },
  });
  expect(Result.isOk(result)).toBe(true);
  if (Result.isError(result)) {
    return;
  }
  expect(result.value.readyFired).toBe(true);
  expect(result.value.consoleErrors).toEqual([]);
  expect(result.value.blockedRequests).toBe(0);
});
