import { type BrowserContext, chromium, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
} from "@stll/api-contract/browser-control";

// The e2e build is the only one that trusts the loopback stella pages below.
const extensionPath = path.join(
  import.meta.dirname,
  "../.output/chrome-mv3-e2e",
);

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

const close = async (server: Server): Promise<void> => {
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
};

const serveStellaPage = (): Server =>
  createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body>stella bridge test</body></html>");
  });

/** Opens a stella page that records every extension response by request id. */
const openStellaPage = async (context: BrowserContext, url: string) => {
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
      if (
        typeof data !== "object" ||
        data === null ||
        !("source" in data) ||
        data.source !== "stella-browser-extension" ||
        !("requestId" in data) ||
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
  await page.goto(url);
  await expect
    .poll(
      async () =>
        await page
          .locator("html")
          .getAttribute("data-extension-response-extension-ready"),
    )
    .not.toBeNull();

  const response = async (requestId: string): Promise<unknown> => {
    let raw: string | null = null;
    await expect
      .poll(async () => {
        raw = await page
          .locator("html")
          .getAttribute(`data-extension-response-${requestId}`);
        return raw;
      })
      .not.toBeNull();
    return raw === null ? null : JSON.parse(raw);
  };

  const post = async (message: Record<string, unknown>): Promise<void> => {
    await page.evaluate(
      ({ envelope }) => {
        window.postMessage(envelope, window.location.origin);
      },
      {
        envelope: {
          ...message,
          protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
          source: BROWSER_EXTENSION_MESSAGE_SOURCE.web,
        },
      },
    );
  };

  return {
    /** The controller id the extension reports to this page. */
    async controllerId(requestId: string): Promise<unknown> {
      await post({ requestId, type: "ping" });
      const pong = await response(requestId);
      return typeof pong === "object" && pong !== null && "controllerId" in pong
        ? pong.controllerId
        : undefined;
    },
    /** The error code of an `open` command sent under `controllerId`. */
    async commandCode(
      requestId: string,
      controllerId: string,
    ): Promise<unknown> {
      await post({
        command: { action: "open", url: "https://example.com/" },
        controllerId,
        observedTab: null,
        requestId,
        toolCallId: `tool-call-${requestId}`,
        turnId: "turn-1",
        type: "command",
      });
      const result: unknown = await response(requestId);
      if (
        typeof result !== "object" ||
        result === null ||
        !("result" in result) ||
        typeof result.result !== "object" ||
        result.result === null ||
        !("code" in result.result)
      ) {
        return undefined;
      }
      return result.result.code;
    },
  };
};

test("an unpaired page cannot forge browser commands and a connection covers its origin only", async () => {
  const server = serveStellaPage();
  const otherServer = serveStellaPage();
  const port = await listen(server);
  // Another port is another origin, so another stella the extension trusts.
  const otherPort = await listen(otherServer);
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
    const pageUrl = `http://127.0.0.1:${port}/chat`;
    const page = await openStellaPage(context, pageUrl);
    expect(await page.commandCode("forged-command", "forged-controller")).toBe(
      BROWSER_CONTROL_ERROR_CODE.staleController,
    );

    const worker =
      context.serviceWorkers().at(0) ??
      (await context.waitForEvent("serviceworker"));
    await worker.evaluate(
      async ({ origin }) => {
        await chrome.storage.session.set({
          browserController: { controllerId: "controller-1", origin },
        });
      },
      { origin: new URL(pageUrl).origin },
    );

    // A second stella tab on the connected origin shares the connection
    // without being connected again: it is told the controller, and its
    // command passes the controller check (and stops at website access,
    // which this unmodified build was never granted).
    const secondPage = await openStellaPage(
      context,
      `http://127.0.0.1:${port}/matters`,
    );
    expect(await secondPage.controllerId("second-tab")).toBe("controller-1");
    expect(await secondPage.commandCode("second-command", "controller-1")).toBe(
      BROWSER_CONTROL_ERROR_CODE.permissionDenied,
    );

    // A stella tab on another origin is not connected and cannot use the id.
    const otherPage = await openStellaPage(
      context,
      `http://127.0.0.1:${otherPort}/chat`,
    );
    expect(await otherPage.controllerId("other-origin")).toBeNull();
    expect(await otherPage.commandCode("other-command", "controller-1")).toBe(
      BROWSER_CONTROL_ERROR_CODE.staleController,
    );
  } finally {
    await context.close();
    await close(server);
    await close(otherServer);
    await rm(profilePath, { force: true, recursive: true });
  }
});
