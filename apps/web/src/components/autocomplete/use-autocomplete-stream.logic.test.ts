import { expect, test } from "bun:test";

import { requestAutocompleteStream } from "./use-autocomplete-stream.logic";

test("a destroyed editor never starts an autocomplete request", async () => {
  const controller = new AbortController();
  let requestCount = 0;

  const response = await requestAutocompleteStream({
    controller,
    dispatchStart: () => false,
    fetchResponse: async () => {
      requestCount += 1;
      return new Response();
    },
  });

  expect(response).toBeNull();
  expect(controller.signal.aborted).toBeTrue();
  expect(requestCount).toBe(0);
});
