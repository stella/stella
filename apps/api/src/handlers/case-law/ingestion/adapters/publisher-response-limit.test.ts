import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  limitPublisherResponse,
  PublisherResponseTooLargeError,
} from "./publisher-response-limit";

describe("publisher response limit", () => {
  test("preserves response metadata and a body within the limit", async () => {
    const response = new Response("body", {
      headers: { "content-type": "text/plain" },
      status: 202,
      statusText: "Accepted",
    });
    const limited = limitPublisherResponse(response, 4);

    expect(limited.status).toBe(202);
    expect(limited.statusText).toBe("Accepted");
    expect(limited.headers.get("content-type")).toBe("text/plain");
    expect(await limited.text()).toBe("body");
  });

  test("stops every whole-body consumer at the decoded-byte ceiling", async () => {
    let pulls = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
      }),
    );

    const rejection = await rejectionOf(
      limitPublisherResponse(response, 4).arrayBuffer(),
    );
    expect(rejection).toBeInstanceOf(PublisherResponseTooLargeError);
    expect(pulls).toBeLessThanOrEqual(3);
  });
});
