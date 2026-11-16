import { CancelledError, QueryClient } from "@tanstack/react-query";
import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

import { workspaceMemberPreviewsOptions } from "./workspace-member-previews";

const workspaceA = "00000000-0000-4000-8000-000000000001";
const workspaceB = "00000000-0000-4000-8000-000000000002";

test("preview identity retains organization, user and sorted batch without changing caller order", () => {
  const workspaceIds = [workspaceB, workspaceA];
  const options = workspaceMemberPreviewsOptions({
    organizationId: "organization",
    userId: "user",
    workspaceIds,
  });
  expect(options.queryKey).toEqual([
    "workspace-member-previews",
    "organization",
    "user",
    [workspaceA, workspaceB],
  ]);
  expect(workspaceIds).toEqual([workspaceB, workspaceA]);
  expect(options.enabled).toBe(true);
  expect(options.staleTime).toBe(ROUTE_QUERY_STALE_TIME_MS);
  expect(
    workspaceMemberPreviewsOptions({
      organizationId: "organization",
      userId: "user",
      workspaceIds: [],
    }).enabled,
  ).toBe(false);
});

test("preview request keeps sorted IDs and cancels its transport with the query", async () => {
  const originalFetch = globalThis.fetch;
  const reached = Promise.withResolvers<Request>();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (
        !new URL(request.url).pathname.endsWith("/workspaces/member-previews")
      ) {
        throw new Error("Unexpected preview transport");
      }
      return await new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        );
        reached.resolve(request);
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const options = workspaceMemberPreviewsOptions({
      organizationId: "organization",
      userId: "user",
      workspaceIds: [workspaceB, workspaceA],
    });
    const failure = rejectionOf(client.query(options));
    const request = await reached.promise;
    expect(new URL(request.url).searchParams.getAll("workspaceIds")).toEqual([
      workspaceA,
      workspaceB,
    ]);
    await client.cancelQueries({ queryKey: options.queryKey });
    expect(await failure).toBeInstanceOf(CancelledError);
    expect(request.signal.aborted).toBe(true);
  } finally {
    await client.cancelQueries();
    client.clear();
    globalThis.fetch = originalFetch;
  }
});
