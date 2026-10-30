import { expect, test } from "@playwright/test";
import { panic } from "better-result";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";

import { sleep } from "@stll/concurrency/sleep";

import { createNetworkCollector } from "../helpers/network";

test.use({
  storageState: { cookies: [], origins: [] },
  screenshot: "off",
  trace: "off",
  video: "off",
});

const BODY_PREFIX = "first chunk; ";
const BODY_SUFFIX = "last chunk";

const startBodyServer = async (contentType = "text/plain") => {
  const pending = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    if (request.url !== "/slow") {
      response.setHeader("content-type", "text/html");
      response.end(
        '<script>fetch("/slow").then(response => response.text()).catch(() => undefined)</script>',
      );
      return;
    }
    response.writeHead(200, {
      "content-type": contentType,
      ...(contentType === "text/event-stream"
        ? {}
        : { "content-length": Buffer.byteLength(BODY_PREFIX + BODY_SUFFIX) }),
    });
    response.write(
      contentType === "text/event-stream"
        ? "data: first event\n\n"
        : BODY_PREFIX,
    );
    pending.add(response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    return panic("Body fixture server did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    finishBody: () => {
      for (const response of pending) {
        response.end(BODY_SUFFIX);
      }
      pending.clear();
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
};

test("capture waits for a body that outlasts the quiet window", async ({
  page,
}) => {
  const server = await startBodyServer();
  const network = createNetworkCollector({
    apiOrigin: server.url,
    bodyCompletionTimeoutMs: 5000,
    responseSizeBudgetKeys: new Set(["GET /slow"]),
  });
  const detach = await network.trackPage(page);
  try {
    const headers = page.waitForResponse(`${server.url}/slow`);
    await page.goto(server.url, { waitUntil: "domcontentloaded" });
    await headers;
    expect(
      await network.waitForQuiet({
        idleMs: 20,
        minimumObservationMs: 20,
        timeoutMs: 500,
      }),
    ).toBe("idle");

    const capture = network.capture();
    // real-time: hold the body open beyond the collector's real quiet window.
    await sleep(40);
    server.finishBody();
    const result = await capture;
    expect(result.requests).toHaveLength(1);
    expect(result.requests.at(0)?.responseSize).toEqual({
      status: "measured",
      bytes: Buffer.byteLength(BODY_PREFIX + BODY_SUFFIX),
    });
  } finally {
    await detach();
    await server.close();
  }
});

test("capture reports an unreadable body when completion exceeds its bound", async ({
  page,
}) => {
  const server = await startBodyServer();
  const network = createNetworkCollector({
    apiOrigin: server.url,
    bodyCompletionTimeoutMs: 50,
    responseSizeBudgetKeys: new Set(["GET /slow"]),
  });
  const detach = await network.trackPage(page);
  try {
    const headers = page.waitForResponse(`${server.url}/slow`);
    await page.goto(server.url, { waitUntil: "domcontentloaded" });
    await headers;
    const result = await network.capture();
    expect(result.requests).toHaveLength(1);
    expect(result.requests.at(0)?.responseSize).toEqual({
      status: "unreadable",
      error: "body incomplete after 50ms",
    });
  } finally {
    await detach();
    await server.close();
  }
});

for (const contentType of ["text/event-stream", "text/plain"]) {
  test(`capture promptly excludes an unfinished ${contentType} response without waiting for its body`, async ({
    page,
  }) => {
    const server = await startBodyServer(contentType);
    const network = createNetworkCollector({
      apiOrigin: server.url,
      bodyCompletionTimeoutMs: 5000,
      responseSizeBudgetKeys: new Set(
        contentType === "text/event-stream" ? ["GET /slow"] : [],
      ),
    });
    const detach = await network.trackPage(page);
    try {
      const headers = page.waitForResponse(`${server.url}/slow`);
      await page.goto(server.url, { waitUntil: "domcontentloaded" });
      await headers;
      const startedAt = Date.now();
      const result = await network.capture();
      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(result.requests).toHaveLength(1);
      expect(result.requests.at(0)?.responseSize.status).toBe(
        contentType === "text/event-stream" ? "streamed" : "unreadable",
      );
    } finally {
      await detach();
      await server.close();
    }
  });
}
