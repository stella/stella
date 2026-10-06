import { expect, test } from "@playwright/test";

import { VISUAL_SANDBOX_PATH } from "@stll/api-contract/visual-sandbox";

import declaration from "../visual-sandbox-network-budgets/frame-shell.json";
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
    const hostUrl = new URL("/__visual-frame-smoke", baseURL).href;
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
    await page.route(
      hostUrl,
      async (route) =>
        await route.fulfill({
          contentType: "text/html",
          body: `<iframe title="Timeline" src="${sandboxUrl}" onload='this.contentWindow.postMessage({type:"render",title:"Timeline",html:"<p id=visual-smoke>Timeline</p>"},${JSON.stringify(new URL(sandboxUrl).origin)})'></iframe>`,
        }),
    );
    try {
      const frameResponse = page.waitForResponse(sandboxUrl);
      await page.goto(hostUrl);
      const response = await frameResponse;
      expect(response.status()).toBe(200);
      expect(response.headers()["cache-control"]).toBe("private, no-store");
      await expect(
        page
          .frameLocator("iframe")
          .frameLocator("iframe")
          .locator("#visual-smoke"),
      ).toHaveText("Timeline");
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
      expect(frameRequests).toEqual(["GET"]);
      errors.assertEmpty(VISUAL_SANDBOX_PATH);
    } finally {
      stopErrors();
      stopTracking();
    }
  });
};
