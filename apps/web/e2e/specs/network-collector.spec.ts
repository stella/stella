import { expect, test } from "@playwright/test";
import { panic } from "better-result";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";

import { sleep } from "@stll/concurrency/sleep";

import { createNetworkCollector, summarizeCapture } from "../helpers/network";

test.use({
  storageState: { cookies: [], origins: [] },
  screenshot: "off",
  trace: "off",
  video: "off",
  launchOptions: { args: ["--site-per-process"] },
});

const BODY_PREFIX = "first chunk; ";
const BODY_SUFFIX = "last chunk";

const startBodyServer = async ({
  contentType = "text/plain",
  port = 0,
}: {
  contentType?: string;
  port?: number;
} = {}) => {
  const pending = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    if (request.url === "/redirect-page") {
      response.setHeader("content-type", "text/html");
      response.end(
        '<script>fetch("/redirect-one").then(response => response.text())</script>',
      );
      return;
    }
    if (request.url === "/redirect-one" || request.url === "/redirect-two") {
      const first = request.url === "/redirect-one";
      response.writeHead(first ? 302 : 307, {
        location: first ? "/redirect-two" : "/redirect-final",
        "x-db-queries": first ? "3" : "5",
      });
      response.end();
      return;
    }
    if (request.url === "/redirect-final") {
      response.writeHead(200, {
        "x-db-queries": "7",
        "content-type": "text/plain",
      });
      response.end("done");
      return;
    }
    if (request.url === "/iframe") {
      const address = server.address();
      if (address === null || typeof address === "string") {
        panic("Iframe fixture server did not bind a TCP port");
      }
      response.setHeader("content-type", "text/html");
      response.end(
        `<iframe src="http://localhost:${address.port}/frame"></iframe>`,
      );
      return;
    }
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    return panic("Body fixture server did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
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
    const server = await startBodyServer({ contentType });
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

test("a failed Network.enable detaches its CDP session", async ({ page }) => {
  const context = page.context();
  const newCDPSession = context.newCDPSession.bind(context);
  let detachments = 0;
  context.newCDPSession = async (target) => {
    const session = await newCDPSession(target);
    const detach = session.detach.bind(session);
    session.send = async () => {
      throw new TypeError("Network.enable fixture failure");
    };
    session.detach = async () => {
      detachments += 1;
      await detach();
    };
    return session;
  };
  const network = createNetworkCollector();
  await expect(network.trackPage(page)).rejects.toThrow(
    "Network.enable fixture failure",
  );
  expect(detachments).toBe(1);
  expect((await network.capture()).requests).toEqual([]);
});

test("API requests in an out-of-process iframe remain explicitly unmeasured", async ({
  page,
}) => {
  const server = await startBodyServer();
  const iframeOrigin = server.url.replace("127.0.0.1", "localhost");
  const network = createNetworkCollector({
    apiOrigin: iframeOrigin,
    responseSizeBudgetKeys: new Set(["GET /slow"]),
  });
  const detach = await network.trackPage(page);
  try {
    const headers = page.waitForResponse(`${iframeOrigin}/slow`);
    await page.goto(`${server.url}/iframe`, { waitUntil: "domcontentloaded" });
    await headers;
    server.finishBody();
    const frame = page
      .frames()
      .find((entry) => entry.url() === `${iframeOrigin}/frame`);
    if (frame === undefined) {
      panic("OOPIF fixture did not load its child frame");
    }
    const iframeSession = await page.context().newCDPSession(frame);
    try {
      const { targetInfo } = await iframeSession.send("Target.getTargetInfo");
      expect(targetInfo.type).toBe("iframe");
    } finally {
      await iframeSession.detach();
    }
    const result = await network.capture();
    expect(result.requests).toHaveLength(1);
    expect(result.requests.at(0)?.responseSize).toEqual({
      status: "unreadable",
      error:
        "CDP Network events were not observed; the request may belong to an out-of-process iframe",
    });
  } finally {
    await detach();
    await server.close();
  }
});

test("fixture setup rejects when its listening port is occupied", async () => {
  const server = await startBodyServer();
  try {
    await expect(startBodyServer({ port: server.port })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  } finally {
    await server.close();
  }
});

test("redirect hops retain individual request counts and database query headers", async ({
  page,
}) => {
  const server = await startBodyServer();
  const network = createNetworkCollector({
    apiOrigin: server.url,
    responseSizeBudgetKeys: new Set([
      "GET /redirect-one",
      "GET /redirect-two",
      "GET /redirect-final",
    ]),
  });
  const detach = await network.trackPage(page);
  try {
    const finalResponse = page.waitForResponse(`${server.url}/redirect-final`);
    await page.goto(`${server.url}/redirect-page`, {
      waitUntil: "domcontentloaded",
    });
    await finalResponse;
    const result = summarizeCapture(await network.capture());
    expect(result.requestCounts).toEqual({
      "GET /redirect-one": 1,
      "GET /redirect-two": 1,
      "GET /redirect-final": 1,
    });
    expect(result.dbQueries).toEqual({
      "GET /redirect-one": 3,
      "GET /redirect-two": 5,
      "GET /redirect-final": 7,
    });
    expect(result.missingDbQueryCounts).toEqual({});
    expect(result.responseSizeFailures).toEqual({});
  } finally {
    await detach();
    await server.close();
  }
});
