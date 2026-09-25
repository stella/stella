import { expect, test } from "bun:test";

import {
  requestAutocompleteStream,
  runAutocompleteRequest,
} from "./use-autocomplete-stream.logic";

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

const recordRun = () => {
  const events: { cleared: number; reported: unknown[] } = {
    cleared: 0,
    reported: [],
  };
  return {
    events,
    clear: () => {
      events.cleared += 1;
    },
    reportError: (error: unknown) => {
      events.reported.push(error);
    },
  };
};

test("reports a request that fails and clears the suggestion", async () => {
  const { events, clear, reportError } = recordRun();
  const failure = new TypeError("Failed to fetch");

  await runAutocompleteRequest({
    controller: new AbortController(),
    dispatchStart: () => true,
    fetchResponse: async () => {
      throw failure;
    },
    consume: async () => {},
    clear,
    reportError,
  });

  expect(events).toEqual({ cleared: 1, reported: [failure] });
});

test("reports a stream that fails while it is read", async () => {
  const { events, clear, reportError } = recordRun();
  const failure = new TypeError("network error");

  await runAutocompleteRequest({
    controller: new AbortController(),
    dispatchStart: () => true,
    fetchResponse: async () => new Response("data: {}\n\n"),
    consume: async () => {
      throw failure;
    },
    clear,
    reportError,
  });

  expect(events).toEqual({ cleared: 1, reported: [failure] });
});

test("clears the suggestion of a request that times out without reporting it", async () => {
  const { events, clear, reportError } = recordRun();

  await runAutocompleteRequest({
    controller: new AbortController(),
    dispatchStart: () => true,
    fetchResponse: async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    },
    consume: async () => {},
    clear,
    reportError,
  });

  expect(events).toEqual({ cleared: 1, reported: [] });
});

test("does not report a request cancelled by a newer edit", async () => {
  const { events, clear, reportError } = recordRun();
  const controller = new AbortController();

  await runAutocompleteRequest({
    controller,
    dispatchStart: () => true,
    fetchResponse: async () => {
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    },
    consume: async () => {},
    clear,
    reportError,
  });

  expect(events).toEqual({ cleared: 0, reported: [] });
});

test("clears the suggestion on an error response without reporting it", async () => {
  const { events, clear, reportError } = recordRun();
  let consumed = false;

  await runAutocompleteRequest({
    controller: new AbortController(),
    dispatchStart: () => true,
    fetchResponse: async () => new Response(null, { status: 503 }),
    consume: async () => {
      consumed = true;
    },
    clear,
    reportError,
  });

  expect(consumed).toBeFalse();
  expect(events).toEqual({ cleared: 1, reported: [] });
});
