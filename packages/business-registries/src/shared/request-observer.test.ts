import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { performRegistryRequest } from "./http";
import { observeRegistryRequest } from "./request-observer";

test("explicit observations report callback failures and leave outbound attempts intact", async () => {
  const originalFetch = globalThis.fetch;
  let outbound = 0;
  let observed = 0;
  const failures: unknown[] = [];
  const cause = new TypeError("fixture observer failure");
  const observer = {
    onRequest: () => {
      observed += 1;
      throw cause;
    },
    onError: (error: unknown) => {
      failures.push(error);
      throw new TypeError("fixture reporter failure");
    },
  };
  globalThis.fetch = Object.assign(
    async () => {
      outbound += 1;
      return new Response("fixture response");
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await performRegistryRequest({
        observer,
        url: "https://fixture.invalid",
        wrapRequestError: (error) =>
          new TypeError("fixture transport failure", { cause: error }),
      });
      expect(await response.text()).toBe("fixture response");
    }
    expect(outbound).toBe(3);
    expect(observed).toBe(outbound);
    expect(failures).toEqual([cause, cause, cause]);
    observeRegistryRequest("unobserved");
    expect(observed).toBe(3);
    const controller = new AbortController();
    controller.abort(new TypeError("fixture abort"));
    expect(
      await rejectionOf(
        performRegistryRequest({
          observer,
          signal: controller.signal,
          url: "https://fixture.invalid",
          wrapRequestError: (error) =>
            new TypeError("fixture transport failure", { cause: error }),
        }),
      ),
    ).toHaveProperty("message", expect.stringContaining("fixture abort"));
    expect(outbound).toBe(3);
    expect(observed).toBe(3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
