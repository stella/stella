import { expect, test } from "@playwright/test";

import { VISUAL_SANDBOX_PATH } from "@stll/api-contract/visual-sandbox";

import declaration from "../visual-sandbox-network-budgets/frame-shell.json" with { type: "json" };
import { E2E_API_ORIGIN } from "./api";
import {
  createNetworkCollector,
  diffNetworkBaseline,
  summarizeCapture,
  type NetworkBaselineEntry,
} from "./network";
import { createBrowserErrorCollector } from "./test";

export const declareVisualSandboxSmoke = () => {
  test("visual API frame renders without secondary requests", async ({
    page,
    baseURL,
  }) => {
    expect(baseURL).toBeDefined();
    expect(declaration.route).toBe(VISUAL_SANDBOX_PATH);
    // A real response from the web server gives the host page the same
    // address space as the API, so Chromium loads the frame. A response
    // fulfilled by page.route() does not, and Chromium blocks the frame.
    const hostUrl = new URL("/prepaint-init.js", baseURL).href;
    const sandboxUrl = new URL(VISUAL_SANDBOX_PATH, E2E_API_ORIGIN).href;
    const nonce = crypto.randomUUID();
    const frameUrl = `${sandboxUrl}#n=${nonce}`;
    const collector = createNetworkCollector();
    const stopTracking = collector.trackPage(page);
    const errors = createBrowserErrorCollector();
    const stopErrors = errors.trackPage(page);
    const frameRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url() === sandboxUrl) {
        frameRequests.push(request.method());
      }
    });
    try {
      const hostResponse = await page.goto(hostUrl);
      expect(hostResponse?.ok()).toBe(true);
      const frameResponse = page.waitForResponse(sandboxUrl);
      await page.evaluate(
        ({ frameUrl: shellUrl, nonce: shellNonce }) => {
          const frame = document.createElement("iframe");
          frame.title = "Timeline";
          frame.setAttribute("sandbox", "allow-scripts");
          frame.src = shellUrl;
          addEventListener("message", (event: MessageEvent<unknown>) => {
            const { source, origin, data } = event;
            if (
              source !== frame.contentWindow ||
              origin !== "null" ||
              typeof data !== "object" ||
              data === null ||
              !("kind" in data)
            ) {
              return;
            }
            if (data.kind === "shell-ready") {
              if (!("nonce" in data) || data.nonce !== shellNonce) {
                return;
              }
              frame.contentWindow?.postMessage(
                {
                  type: "render",
                  title: "Timeline",
                  html: "<p id=visual-smoke>Timeline</p>",
                  data: {},
                },
                "*",
              );
              return;
            }
            if (!("height" in data)) {
              return;
            }
            const { kind, height } = data;
            if (
              kind === "resize" &&
              typeof height === "number" &&
              Number.isInteger(height) &&
              height > 0
            ) {
              document.documentElement.dataset["visualResize"] = "received";
            }
          });
          document.body.replaceChildren(frame);
        },
        { frameUrl, nonce },
      );
      const response = await frameResponse;
      expect(response.status()).toBe(200);
      expect(response.headers()["cache-control"]).toBe("private, no-store");
      await expect(
        page
          .frameLocator("iframe")
          .frameLocator("iframe")
          .locator("#visual-smoke"),
      ).toHaveText("Timeline");
      await expect(page.locator("html")).toHaveAttribute(
        "data-visual-resize",
        "received",
      );
      errors.assertEmpty(VISUAL_SANDBOX_PATH);
      await collector.waitForQuiet({
        idleMs: 500,
        minimumObservationMs: 1000,
        timeoutMs: 5000,
      });
      const results = new Map([
        [VISUAL_SANDBOX_PATH, summarizeCapture(await collector.capture())],
      ]);
      expect(
        diffNetworkBaseline(
          { [VISUAL_SANDBOX_PATH]: declaration.budget } satisfies Record<
            typeof VISUAL_SANDBOX_PATH,
            NetworkBaselineEntry
          >,
          results,
          { requireAllRoutes: true },
        ).problems,
        declaration.reason,
      ).toEqual([]);
      expect(page.frames().map((frame) => frame.url())).toEqual([
        hostUrl,
        frameUrl,
        "about:srcdoc",
      ]);
      expect(frameRequests).toEqual(["GET"]);
      errors.assertEmpty(VISUAL_SANDBOX_PATH);
    } finally {
      stopErrors();
      stopTracking();
    }
  });
};
