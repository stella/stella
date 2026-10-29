import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic, Result } from "better-result";
import { afterAll, expect, test } from "bun:test";

import type { ScanEngine } from "@stll/scan-engine/types";
import { ScanEngineError } from "@stll/scan-engine/types";

import { ClientOperationError } from "@/lib/errors/client";
import type { PageViewport } from "@/lib/pdf/pdfjs-loader";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import { runCleanScan } from "./clean-scan-run";
import type { CleanScanFailure } from "./clean-scan-run";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
afterAll(unregisterDomEnvironment);

const viewport = (): PageViewport => ({
  viewBox: [0, 0, 1, 1],
  userUnit: 1,
  scale: 1,
  rotation: 0,
  offsetX: 0,
  offsetY: 0,
  transform: [1, 0, 0, 1, 0, 0],
  width: 1,
  height: 1,
  rawDims: { pageWidth: 1, pageHeight: 1, pageX: 0, pageY: 0 },
  clone: viewport,
  convertToViewportPoint: (x, y) => [x, y],
  convertToPdfPoint: (x, y) => [x, y],
});

const pageProxy = (promise: Promise<void>, onRender: () => void) =>
  ({
    getViewport: viewport,
    render: () => {
      onRender();
      return {
        _internalRenderTask: null,
        onContinue: () => undefined,
        onError: () => undefined,
        promise,
        cancel: () => undefined,
        separateAnnots: false,
        imageCoordinates: {},
      };
    },
  }) satisfies Parameters<typeof runCleanScan>[0]["pages"][number]["proxy"];

test.each([{ abort: false }, { abort: true }])(
  "render completion suppresses outcomes and later pages when aborted: $abort",
  async ({ abort }) => {
    const controller = new AbortController();
    const started = Promise.withResolvers<undefined>();
    const render = Promise.withResolvers<undefined>();
    let renderCount = 0;
    let engineCalls = 0;
    let reviewedCount = 0;
    const failures: CleanScanFailure[] = [];
    const engine = {
      clean: async () => {
        engineCalls += 1;
        return await Promise.resolve(
          Result.ok({ type: "unrecognized", reason: "fixture" } as const),
        );
      },
    } satisfies ScanEngine;
    const proxy = pageProxy(render.promise, () => {
      renderCount += 1;
      started.resolve(undefined);
    });
    const pending = runCleanScan({
      engine,
      options: { output: "grayscale", contentCrop: "off", deskew: "off" },
      pages: [
        { pageId: "first", proxy, rotation: 0 },
        { pageId: "second", proxy, rotation: 0 },
      ],
      signal: controller.signal,
      onFailed: (failure) => {
        failures.push(failure);
      },
      onReviewed: () => {
        reviewedCount += 1;
      },
    });
    await started.promise;
    expect(renderCount).toBe(1);
    if (abort) {
      controller.abort();
    }
    render.reject(
      new ClientOperationError({
        action: "render-fixture",
        message: "Rendering interrupted",
      }),
    );
    await pending;
    expect(engineCalls).toBe(0);
    expect(reviewedCount).toBe(0);
    expect(renderCount).toBe(abort ? 1 : 2);
    expect(failures.map(({ pageId, reason }) => ({ pageId, reason }))).toEqual(
      abort
        ? []
        : [
            { pageId: "first", reason: "render-failure" },
            { pageId: "second", reason: "render-failure" },
          ],
    );
  },
);

test.each([
  { abort: false, fails: false },
  { abort: false, fails: true },
  { abort: true, fails: false },
  { abort: true, fails: true },
])(
  "engine completion suppresses outcomes and later pages when aborted: $abort, failure: $fails",
  async ({ abort, fails }) => {
    const original = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "getContext",
    );
    if (original === undefined) {
      panic("Canvas getContext descriptor is missing");
    }
    const context = {
      getImageData: () => new ImageData(new Uint8ClampedArray(4), 1, 1),
    } satisfies Pick<CanvasRenderingContext2D, "getImageData">;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      ...original,
      value: () => context,
    });
    try {
      const controller = new AbortController();
      const started = Promise.withResolvers<undefined>();
      const answer =
        Promise.withResolvers<Awaited<ReturnType<ScanEngine["clean"]>>>();
      let renderCount = 0;
      let engineCalls = 0;
      const reviewed: string[] = [];
      const failed: string[] = [];
      const proxy = pageProxy(Promise.resolve(), () => {
        renderCount += 1;
      });
      const pending = runCleanScan({
        engine: {
          clean: async () => {
            engineCalls += 1;
            started.resolve(undefined);
            return await answer.promise;
          },
        },
        options: { output: "grayscale", contentCrop: "off", deskew: "off" },
        pages: [
          { pageId: "first", proxy, rotation: 0 },
          { pageId: "second", proxy, rotation: 0 },
        ],
        signal: controller.signal,
        onFailed: ({ pageId }) => {
          failed.push(pageId);
        },
        onReviewed: ({ pageId }) => {
          reviewed.push(pageId);
        },
      });
      await started.promise;
      expect(renderCount).toBe(1);
      expect(engineCalls).toBe(1);
      if (abort) {
        controller.abort();
      }
      answer.resolve(
        fails
          ? Result.err(
              new ScanEngineError({
                type: "engine-failure",
                message: "Engine interrupted",
              }),
            )
          : Result.ok({ type: "unrecognized", reason: "fixture" }),
      );
      await pending;
      expect(engineCalls).toBe(abort ? 1 : 2);
      expect(renderCount).toBe(abort ? 1 : 2);
      expect(failed).toEqual(!abort && fails ? ["first", "second"] : []);
      expect(reviewed).toEqual(!abort && !fails ? ["first", "second"] : []);
    } finally {
      Object.defineProperty(
        HTMLCanvasElement.prototype,
        "getContext",
        original,
      );
    }
  },
);
