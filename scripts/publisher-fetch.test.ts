import { Result } from "better-result";
import { expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";

import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";

import { createPublisherFetch } from "./publisher-fetch";

test("publisher fetch keeps the validated address pinned through connection", async () => {
  const requestedPaths: string[] = [];
  const server = createServer((request, response) => {
    requestedPaths.push(request.url ?? "");
    if (request.url === "/robots.txt") {
      response.writeHead(404).end();
      return;
    }
    response.end("loopback response");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }

  const originalFetch = globalThis.fetch;
  const rebindingFetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        url.hostname = "127.0.0.1";
        return await originalFetch(url, init);
      },
      { preconnect: originalFetch.preconnect },
    ),
  );

  try {
    const request = createPublisherFetch({
      permit: grantThirdPartyOutboundPermit(),
      resolveAddresses: async (hostname) => {
        expect(hostname).toBe("publisher-rebinding.test");
        return Result.ok([{ address: "93.184.216.34", family: 4 }]);
      },
      headerTimeoutMs: 50,
    });
    const outcome = await request(
      `http://publisher-rebinding.test:${address.port}/resource`,
    );

    expect(outcome.isErr()).toBe(true);
    expect(requestedPaths).toEqual([]);
    expect(rebindingFetch).not.toHaveBeenCalled();
  } finally {
    rebindingFetch.mockRestore();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});
