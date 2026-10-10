import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, expect, test } from "bun:test";

import { deepLAvailabilityOptions } from "./queries";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("keeps closed translation dialogs idle", async () => {
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls += 1;
      return Response.json({ configured: true });
    },
    { preconnect: () => undefined },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const observer = new QueryObserver(
    client,
    deepLAvailabilityOptions({
      organizationId: "organization-a",
      open: false,
    }),
  );
  const stop = observer.subscribe(() => undefined);
  await Promise.resolve();
  await Promise.resolve();
  expect(observer.getCurrentResult().fetchStatus).toBe("idle");
  expect(calls).toBe(0);
  stop();
  client.clear();
});

test("shares one availability transport across open close and remount", async () => {
  const started = Promise.withResolvers<undefined>();
  const response = Promise.withResolvers<Response>();
  let calls = 0;
  let aborts = 0;
  globalThis.fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      init?.signal?.addEventListener("abort", () => {
        aborts += 1;
      });
      started.resolve(undefined);
      return response.promise;
    },
    { preconnect: () => undefined },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const options = (open: boolean) =>
    deepLAvailabilityOptions({
      organizationId: "organization-a",
      open,
    });
  const first = new QueryObserver(client, options(true));
  const stopFirst = first.subscribe(() => undefined);
  await started.promise;
  first.setOptions(options(false));
  stopFirst();
  expect(aborts).toBe(0);

  const remounted = new QueryObserver(client, options(true));
  const success = Promise.withResolvers<undefined>();
  const stopRemounted = remounted.subscribe((result) => {
    if (result.isSuccess) {
      success.resolve(undefined);
    }
  });
  const secondConsumer = new QueryObserver(client, options(true));
  const stopSecond = secondConsumer.subscribe(() => undefined);
  response.resolve(Response.json({ configured: true }));
  await success.promise;
  expect(calls).toBe(1);
  expect(remounted.getCurrentResult().data).toEqual({ configured: true });
  expect(secondConsumer.getCurrentResult().data).toEqual({ configured: true });
  stopRemounted();
  stopSecond();

  const reopened = new QueryObserver(client, options(true));
  const stopReopened = reopened.subscribe(() => undefined);
  expect(reopened.getCurrentResult().data).toEqual({ configured: true });
  expect(reopened.getCurrentResult().fetchStatus).toBe("idle");
  expect(calls).toBe(1);
  expect(aborts).toBe(0);
  stopReopened();
  client.clear();
});
