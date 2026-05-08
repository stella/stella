import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { RequestListener } from "node:http";

import {
  fetchStreamWithResolvedAddress,
  fetchWithResolvedAddress,
} from "@/api/lib/safe-outbound-fetch";

describe("fetchWithResolvedAddress", () => {
  test("connects to the pre-resolved address while preserving the URL host", async () => {
    await withHttpServer(
      (request, response) => {
        response.end(request.headers.host ?? "");
      },
      async (port) => {
        const result = await fetchWithResolvedAddress({
          addresses: [{ address: "127.0.0.1", family: 4 }],
          maxBytes: 1024,
          timeoutMs: 1000,
          url: new URL(`http://example.test:${port}/probe`),
        });

        expect(Result.isOk(result)).toBe(true);
        if (Result.isError(result)) {
          throw result.error;
        }

        expect(new TextDecoder().decode(result.value.body)).toBe(
          `example.test:${port}`,
        );
      },
    );
  });

  test("stops reading when the response exceeds the byte cap", async () => {
    await withHttpServer(
      (_request, response) => {
        response.end("0123456789");
      },
      async (port) => {
        const result = await fetchWithResolvedAddress({
          addresses: [{ address: "127.0.0.1", family: 4 }],
          maxBytes: 4,
          timeoutMs: 1000,
          url: new URL(`http://example.test:${port}/large`),
        });

        expect(Result.isError(result)).toBe(true);
      },
    );
  });

  test("returns streaming responses before the server closes the body", async () => {
    await withHttpServer(
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write("event: ping\ndata: ready\n\n");
      },
      async (port) => {
        const result = await fetchStreamWithResolvedAddress({
          addresses: [{ address: "127.0.0.1", family: 4 }],
          maxBytes: 1024,
          timeoutMs: 1000,
          url: new URL(`http://example.test:${port}/events`),
        });

        expect(Result.isOk(result)).toBe(true);
        if (Result.isError(result)) {
          throw result.error;
        }

        const reader = result.value.body.getReader();
        const firstChunk = await reader.read();
        await reader.cancel();

        expect(firstChunk.done).toBe(false);
        expect(new TextDecoder().decode(firstChunk.value)).toContain(
          "data: ready",
        );
      },
    );
  });
});

const withHttpServer = async (
  handler: RequestListener,
  callback: (port: number) => Promise<void>,
): Promise<void> => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }

    await callback(address.port);
  } finally {
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
};
