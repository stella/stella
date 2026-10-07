import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import type { Browser } from "playwright-core";

import { VISUAL_PREVIEW_LIMITS } from "@stll/api-contract/visual-preview";

import {
  renderVisual,
  VisualRenderError,
  VisualRenderTimeoutError,
} from "../src/render";
import { launchPreviewBrowser as launch } from "./launch";

describe("composed visual preview", () => {
  test("reports a typed result when the document has no body", async () => {
    const result = await renderVisual({
      launch,
      input: {
        document: `<script>addEventListener('load', () => {
          document.body.remove();
          parent.postMessage({kind:'ready'}, '*');
        });</script>`,
        viewport: { width: 1200 },
      },
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(VisualRenderError.is(result.error)).toBe(true);
      expect(result.error.message).toBe("Preview document has no body");
    }
  });
  test("reports that network is unavailable for WebSocket connections", async () => {
    const result = await renderVisual({
      launch,
      input: {
        document: `<script>
          const socket = new WebSocket('wss://preview.invalid/example');
          socket.addEventListener('close', () => parent.postMessage({kind:'ready'}, '*'));
        </script>`,
        viewport: { width: 1200 },
      },
    });
    expect(result.unwrap()).toMatchObject({
      blockedRequests: 1,
      readyFired: true,
    });
  });
  test("reports content height after the viewport resizes", async () => {
    const result = await renderVisual({
      launch,
      input: {
        document: `<style>html,body{margin:0}body{height:900px}</style><script>
          addEventListener('resize', () => {document.body.style.height = '1100px'});
          parent.postMessage({kind:'ready'}, '*');
        </script>`,
        viewport: { width: 1200 },
      },
    });
    const output = result.unwrap();
    expect(output.size.height).toBe(1100);
    expect(Buffer.from(output.png, "base64").readUInt32BE(20)).toBe(1100);
  });
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
    expect(result.value.size).toEqual({ width: 1200, height: 800 });
    expect(result.value.consoleErrors).toHaveLength(20);
    expect(
      result.value.consoleErrors.every((message) => message.length <= 500),
    ).toBe(true);
    expect(Buffer.from(result.value.png, "base64").subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  });
  test.each(["", "<!doctype html>"])(
    "renders viewport-height content from a full guest viewport (%s)",
    async (doctype) => {
      const result = await renderVisual({
        launch,
        input: {
          document: `${doctype}<style>html,body{margin:0;height:100vh;background:#eef}</style><script>parent.postMessage({kind:'ready'}, '*')</script>`,
          viewport: { width: 1200 },
        },
      });
      const output = result.unwrap();
      expect(output.readyFired).toBe(true);
      expect(output.size.height).toBeGreaterThanOrEqual(800);
      expect(output.size.height).toBeLessThanOrEqual(
        VISUAL_PREVIEW_LIMITS.height,
      );
      const png = Buffer.from(output.png, "base64");
      expect(png.readUInt32BE(16)).toBe(1200);
      expect(png.readUInt32BE(20)).toBe(output.size.height);
    },
  );
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
        requestAnimationFrame(() => requestAnimationFrame(() => {document.body.style.height = '900px';}));
        resolve(document.fonts);
      }, 50))});
    </script>`,
        viewport: { width: 1200 },
      },
    });
    expect(result.unwrap()).toMatchObject({
      readyFired: false,
      size: { width: 1200, height: 900 },
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
      const browsers: Browser[] = [];
      const timing = { started: 0 };
      const result = await renderVisual({
        launch: async (options) => {
          const browser = await launch(options);
          browsers.push(browser);
          timing.started = performance.now();
          return browser;
        },
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
      expect(performance.now() - timing.started).toBeLessThan(
        VISUAL_PREVIEW_LIMITS.renderTimeoutMs + 2000,
      );
      const browser = browsers.at(0);
      if (browser === undefined) {
        throw new TypeError("Preview timeout requires a launched browser");
      }
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
        document: "<body>Example</body>",
        viewport: { width: 1200 },
      },
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(JSON.stringify(result.error)).not.toContain("Private example");
    }
  });
});
