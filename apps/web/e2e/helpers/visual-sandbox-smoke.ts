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
    const hostDocument = `<script>addEventListener("message",({source,data})=>{const frame=document.querySelector("iframe");if(source===frame.contentWindow&&data.type==="resize"&&Number.isInteger(data.height)&&data.height>0)document.documentElement.dataset.visualResize="received"})</script><iframe title="Timeline" src="${sandboxUrl}" onload='this.contentWindow.postMessage({type:"render",title:"Timeline",html:"<p id=visual-smoke>Timeline</p>"},${JSON.stringify(new URL(sandboxUrl).origin)})'></iframe>`;
    try {
      const hostResponse = await page.goto(hostUrl);
      expect(hostResponse?.ok()).toBe(true);
      const frameResponse = page.waitForResponse(sandboxUrl);
      await page.evaluate((markup) => {
        document.open();
        // safe-html: hostDocument is a constant test fixture defined above.
        document.write(markup);
        document.close();
      }, hostDocument);
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
        sandboxUrl,
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
