import { Result, TaggedError } from "better-result";
import type { Browser, LaunchOptions, Page } from "playwright-core";
import * as v from "valibot";

import {
  VISUAL_PREVIEW_LIMITS,
  visualPreviewInputSchema,
  visualPreviewOutputSchema,
  type VisualPreviewInput,
} from "@stll/api-contract/visual-preview";

const PREVIEW_VIEWPORT_HEIGHT = 800;
const PREVIEW_BROWSER_ARGS = [
  "--host-resolver-rules=MAP * ~NOTFOUND",
  "--disable-background-networking",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
] as const;

export class VisualRenderError extends TaggedError("VisualRenderError")<{
  message: string;
  cause?: unknown;
}> {}

export class VisualRenderTimeoutError extends TaggedError(
  "VisualRenderTimeoutError",
)<{
  message: string;
  readyFired: false;
}> {}

export type VisualPreviewLaunchOptions = Required<Pick<LaunchOptions, "args">>;

type RenderVisualOptions = {
  input: VisualPreviewInput;
  launch: (options: VisualPreviewLaunchOptions) => Promise<Browser>;
};

const MAX_RESIZE_ATTEMPTS = 4;

const measureContentHeight = () => {
  // document.body is typed as always present; a bodyless document has none.
  const body = document.querySelector("body");
  if (body === null) {
    return null;
  }
  return Math.max(body.scrollHeight, document.documentElement.scrollHeight);
};

const settleLayout = async () => {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
};

const resizePreview = async (page: Page, height: number) => {
  await page.setViewportSize({ width: VISUAL_PREVIEW_LIMITS.width, height });
  await page.locator("iframe").evaluate((iframe, size) => {
    iframe.style.height = `${size}px`;
  }, height);
};

export const renderVisual = async ({ input, launch }: RenderVisualOptions) => {
  const parsed = v.safeParse(visualPreviewInputSchema, input);
  if (!parsed.success) {
    return Result.err(
      new VisualRenderError({ message: "Invalid preview input" }),
    );
  }
  const launched = await Result.tryPromise({
    try: async () => launch({ args: [...PREVIEW_BROWSER_ARGS] }),
    catch: () =>
      new VisualRenderError({ message: "Preview browser unavailable" }),
  });
  if (Result.isError(launched)) {
    return Result.err(launched.error);
  }
  const browser = launched.value;
  const renderDeadline =
    performance.now() + VISUAL_PREVIEW_LIMITS.renderTimeoutMs;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(
      () =>
        reject(
          new VisualRenderTimeoutError({
            message: "Preview rendering timed out",
            readyFired: false,
          }),
        ),
      VISUAL_PREVIEW_LIMITS.renderTimeoutMs,
    );
  });
  // One Node-side deadline covers the entire browser pipeline, including
  // every evaluation and screenshot when the guest event loop is blocked.
  const render = async () => {
    const viewport = {
      width: input.viewport.width,
      height: PREVIEW_VIEWPORT_HEIGHT,
    };
    // A fresh context and browser per invocation prevents state sharing.
    const context = await browser.newContext({
      viewport,
      serviceWorkers: "block",
      acceptDownloads: false,
      permissions: [],
    });
    let blockedRequests = 0;
    const consoleErrors: string[] = [];
    const recordError = (message: string) => {
      if (consoleErrors.length >= VISUAL_PREVIEW_LIMITS.consoleErrors) {
        return;
      }
      consoleErrors.push(message.slice(0, VISUAL_PREVIEW_LIMITS.errorChars));
    };
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (url.startsWith("about:") || url.startsWith("data:")) {
        await route.continue();
        return;
      }
      blockedRequests += 1;
      await route.abort("blockedbyclient");
    });
    await context.routeWebSocket(/.*/u, (socket) => {
      blockedRequests += 1;
      void socket
        .close()
        .catch(() => recordError("Preview socket cleanup failed"));
    });
    const page = await context.newPage();
    page.setDefaultTimeout(VISUAL_PREVIEW_LIMITS.renderTimeoutMs);
    page.on("console", (message) => {
      if (message.type() === "error") {
        recordError(message.text());
      }
    });
    page.on("pageerror", (error) => recordError(error.message));
    await page.setContent(
      `<!doctype html><style>html,body{margin:0}iframe{display:block;border:0;width:${viewport.width}px;height:${viewport.height}px}</style><iframe sandbox="allow-scripts"></iframe>`,
    );
    // This listener belongs to the trusted parent; the composed document is
    // loaded unchanged in the same opaque-origin sandbox as the web UI.
    const initialized = await page.evaluate((document) => {
      const iframe = globalThis.document.querySelector("iframe");
      if (!iframe) {
        return false;
      }
      globalThis.document.documentElement.dataset["ready"] = "false";
      globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (event.source !== iframe.contentWindow) {
          return;
        }
        if (
          typeof event.data !== "object" ||
          event.data === null ||
          !("kind" in event.data)
        ) {
          return;
        }
        if (event.data.kind === "ready") {
          globalThis.document.documentElement.dataset["ready"] = "true";
        }
      });
      // safe-html: composed visual HTML is confined to this opaque-origin allow-scripts frame with network interception.
      iframe.srcdoc = document;
      return true;
    }, input.document);
    if (!initialized) {
      return Result.err(
        new VisualRenderError({ message: "Preview frame missing" }),
      );
    }
    const frameElement = await page.locator("iframe").elementHandle();
    const frame = await frameElement.contentFrame();
    if (!frame) {
      return Result.err(
        new VisualRenderError({ message: "Preview frame unavailable" }),
      );
    }
    await frame.waitForURL("about:srcdoc");
    await frame.waitForLoadState("load");
    const ready = await Result.tryPromise(async () =>
      page.waitForFunction(
        () => document.documentElement.dataset["ready"] === "true",
        undefined,
        { timeout: VISUAL_PREVIEW_LIMITS.readyTimeoutMs },
      ),
    );
    if (Result.isError(ready)) {
      await frame.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => resolve());
          });
        });
      });
    }
    const contentHeight = await frame.evaluate(measureContentHeight);
    if (contentHeight === null) {
      return Result.err(
        new VisualRenderError({ message: "Preview document has no body" }),
      );
    }
    const clampHeight = (measured: number) =>
      Math.min(VISUAL_PREVIEW_LIMITS.height, Math.max(1, Math.ceil(measured)));
    // Content may change height each time the viewport does, so resize,
    // settle and measure until it is stable, a bounded number of times.
    let height = clampHeight(contentHeight);
    let stable = false;
    for (
      let attempt = 0;
      attempt < MAX_RESIZE_ATTEMPTS && !stable;
      attempt += 1
    ) {
      await resizePreview(page, height);
      await frame.evaluate(settleLayout);
      const measured = await frame.evaluate(measureContentHeight);
      if (measured === null) {
        return Result.err(
          new VisualRenderError({ message: "Preview document has no body" }),
        );
      }
      const next = clampHeight(measured);
      stable = next === height;
      height = next;
    }
    if (!stable) {
      await resizePreview(page, height);
      await frame.evaluate(settleLayout);
    }
    const png = await page.screenshot({
      type: "png",
      animations: "disabled",
      timeout: Math.max(1, renderDeadline - performance.now()),
    });
    const output = v.safeParse(visualPreviewOutputSchema, {
      png: png.toString("base64"),
      consoleErrors,
      blockedRequests,
      size: { width: VISUAL_PREVIEW_LIMITS.width, height },
      readyFired: Result.isOk(ready),
    });
    if (!output.success) {
      return Result.err(
        new VisualRenderError({ message: "Preview output exceeds its bounds" }),
      );
    }
    return Result.ok(output.output);
  };
  const rendered = await Result.tryPromise({
    try: async () => Promise.race([render(), expired]),
    catch: (error) =>
      VisualRenderTimeoutError.is(error)
        ? error
        : new VisualRenderError({ message: "Preview rendering failed" }),
  });
  clearTimeout(deadline);
  const closed = await Result.tryPromise({
    try: async () => browser.close(),
    catch: () =>
      new VisualRenderError({ message: "Preview browser cleanup failed" }),
  });
  if (Result.isError(closed)) {
    return Result.err(closed.error);
  }
  return Result.isError(rendered) ? Result.err(rendered.error) : rendered.value;
};
