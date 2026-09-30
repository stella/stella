import { expect, test } from "bun:test";

import {
  notifyRegistryRequest,
  observeRegistryRequests,
} from "./request-observer";

test("each actual request is observed and callback failure reaches its error reporter", () => {
  let attempts = 0;
  const failures: unknown[] = [];
  const unsubscribe = observeRegistryRequests({
    onRequest: () => {
      attempts += 1;
      throw new TypeError("fixture observer failure");
    },
    onError: (error) => {
      failures.push(error);
    },
  });
  try {
    notifyRegistryRequest();
    notifyRegistryRequest();
    expect(attempts).toBe(2);
    expect(failures).toHaveLength(2);
    expect(failures.every((error) => error instanceof TypeError)).toBe(true);
  } finally {
    unsubscribe();
  }
  notifyRegistryRequest();
  expect(attempts).toBe(2);
});

test("observation failures leave actual outbound attempts and responses intact", async () => {
  const { performRegistryRequest } = await import("./http");
  const originalFetch = globalThis.fetch;
  let outbound = 0;
  let observed = 0;
  let reported = 0;
  globalThis.fetch = Object.assign(
    async () => {
      outbound += 1;
      return new Response("fixture response");
    },
    { preconnect: originalFetch.preconnect },
  );
  const unsubscribe = observeRegistryRequests({
    onRequest: () => {
      observed += 1;
      throw new TypeError("fixture observer failure");
    },
    onError: () => {
      reported += 1;
    },
  });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await performRegistryRequest({
        url: "https://fixture.invalid",
        wrapRequestError: (cause) =>
          new TypeError("fixture transport failure", { cause }),
      });
      expect(await response.text()).toBe("fixture response");
    }
    expect(outbound).toBe(2);
    expect(observed).toBe(outbound);
    expect(reported).toBe(outbound);
    const controller = new AbortController();
    controller.abort(new TypeError("fixture abort"));
    const aborted = await performRegistryRequest({
      url: "https://fixture.invalid",
      signal: controller.signal,
      wrapRequestError: (cause) =>
        new TypeError("fixture transport failure", { cause }),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(aborted).toMatchObject({ message: "fixture abort" });
    expect(outbound).toBe(2);
    expect(observed).toBe(2);
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
  }
});
