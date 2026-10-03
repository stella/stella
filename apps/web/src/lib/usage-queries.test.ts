import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test } from "bun:test";

import { env } from "@/env";
import { usageEntitlementOptions, usageLaneOptions } from "@/lib/usage-queries";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const recordRequests = (body: unknown) => {
  const paths: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      paths.push(
        new URL(input instanceof Request ? input.url : input).pathname,
      );
      return Response.json(body);
    },
    { preconnect: originalFetch.preconnect },
  );
  return paths;
};

test("entitlement observers and imperative prefetches respect usage availability", async () => {
  const response = { entitlement: null };
  const paths = recordRequests(response);
  const queryClient = new QueryClient();
  const options = usageEntitlementOptions({ organizationId: "org-a" });
  expect(options.enabled).toBe(env.VITE_FEATURE_USAGE);
  expect(await queryClient.fetchQuery(options)).toEqual(response);
  queryClient.clear();
  await queryClient.prefetchQuery(options);
  const cachedResponse = queryClient.getQueryData(options.queryKey);
  expect(cachedResponse).toEqual(response);
  expect(paths).toEqual(
    env.VITE_FEATURE_USAGE
      ? ["/v1/usage/entitlement", "/v1/usage/entitlement"]
      : [],
  );
  queryClient.clear();
});

test("lane observers and imperative prefetches respect usage availability", async () => {
  const response = { budgets: null };
  const paths = recordRequests(response);
  const queryClient = new QueryClient();
  const options = usageLaneOptions({
    organizationId: "org-a",
    userId: "user-a",
  });
  expect(options.enabled).toBe(env.VITE_FEATURE_USAGE);
  expect(await queryClient.fetchQuery(options)).toEqual(response);
  queryClient.clear();
  await queryClient.prefetchQuery(options);
  const cachedResponse = queryClient.getQueryData(options.queryKey);
  expect(cachedResponse).toEqual(response);
  expect(paths).toEqual(
    env.VITE_FEATURE_USAGE ? ["/v1/usage/lane", "/v1/usage/lane"] : [],
  );
  queryClient.clear();
});
