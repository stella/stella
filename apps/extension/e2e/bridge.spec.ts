import { chromium, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
} from "@stll/api-contract/browser-control";

const extensionPath = path.join(import.meta.dirname, "../.output/chrome-mv3");

const listen = async (server: Server): Promise<number> =>
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new TypeError("Test server did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });

test("an unpaired page cannot forge browser commands and a lease stays tab-bound", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body>stella bridge test</body></html>");
  });
  const port = await listen(server);
  const profilePath = await mkdtemp(
    path.join(tmpdir(), "stella-extension-e2e-"),
  );
  const context = await chromium.launchPersistentContext(profilePath, {
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    channel: "chromium",
    headless: true,
  });

  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.addEventListener("message", ({ data }) => {
        if (
          typeof data !== "object" ||
          data === null ||
          data.source !== "stella-browser-extension" ||
          typeof data.requestId !== "string"
        ) {
          return;
        }
        document.documentElement.setAttribute(
          `data-extension-response-${data.requestId}`,
          JSON.stringify(data),
        );
      });
    });
    const pageUrl = `http://127.0.0.1:${port}/chat`;
    await page.goto(pageUrl);
    await expect
      .poll(
        async () =>
          await page
            .locator("html")
            .getAttribute("data-extension-response-extension-ready"),
      )
      .not.toBeNull();

    await page.evaluate(
      ({ protocolVersion, source }) => {
        window.postMessage(
          {
            command: { action: "open", url: "https://example.com/" },
            controllerId: "forged-controller",
            protocolVersion,
            requestId: "forged-command",
            source,
            toolCallId: "tool-call-1",
            type: "command",
          },
          window.location.origin,
        );
      },
      {
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        source: BROWSER_EXTENSION_MESSAGE_SOURCE.web,
      },
    );
    await expect
      .poll(async () => {
        const raw = await page
          .locator("html")
          .getAttribute("data-extension-response-forged-command");
        return raw ? JSON.parse(raw).result?.code : null;
      })
      .toBe(BROWSER_CONTROL_ERROR_CODE.staleController);

    const worker =
      context.serviceWorkers().at(0) ??
      (await context.waitForEvent("serviceworker"));
    await worker.evaluate(
      async ({ origin }) => {
        const tab = (
          await chrome.tabs.query({ active: true, currentWindow: true })
        ).at(0);
        if (tab?.id === undefined) {
          throw new TypeError("Could not find the stella test tab");
        }
        await chrome.storage.session.set({
          browserController: {
            controllerId: "controller-1",
            origin,
            tabId: tab.id,
          },
        });
      },
      { origin: new URL(pageUrl).origin },
    );

    const secondPage = await context.newPage();
    await secondPage.addInitScript(() => {
      window.addEventListener("message", ({ data }) => {
        if (
          typeof data === "object" &&
          data !== null &&
          data.source === "stella-browser-extension" &&
          data.type === "pong"
        ) {
          document.documentElement.dataset["controllerId"] =
            data.controllerId ?? "none";
        }
      });
    });
    await secondPage.goto(pageUrl);
    await secondPage.evaluate(
      ({ protocolVersion, source }) => {
        window.postMessage(
          {
            protocolVersion,
            requestId: "lease-check",
            source,
            type: "ping",
          },
          window.location.origin,
        );
      },
      {
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        source: BROWSER_EXTENSION_MESSAGE_SOURCE.web,
      },
    );
    await expect
      .poll(
        async () =>
          await secondPage.locator("html").getAttribute("data-controller-id"),
      )
      .toBe("none");
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(
            new Error("Could not close the extension test server", {
              cause: error,
            }),
          );
          return;
        }
        resolve();
      });
    });
    await rm(profilePath, { force: true, recursive: true });
  }
});
