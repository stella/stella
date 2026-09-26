import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";

import { correspondenceKeys } from "./correspondence";
import {
  correspondenceDropsOptions,
  type CorrespondenceDropsPage,
} from "./correspondence-drops";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("rejected-delivery pagination sends the server cursor, limits every request, and stops on the terminal page", async () => {
  const calls: URL[] = [];
  const cursor = "opaque-cursor+/=";
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(input instanceof Request ? input.url : input);
      calls.push(url);
      return Response.json({
        items: Array.from(
          { length: calls.length === 1 ? 25 : 1 },
          (_, index) => ({
            id: toSafeId<"correspondenceDropLog">(
              `drop-${calls.length}-${index}`,
            ),
            sender: "office@firm.example",
            receivedAt: "2026-09-26T12:00:00.000Z",
            reason: "authentication_failed",
            setupHint: "configure_sender_spf_dkim_dmarc",
          }),
        ),
        limit: 25,
        nextCursor: calls.length === 1 ? cursor : null,
      } satisfies CorrespondenceDropsPage);
    },
    { preconnect: originalFetch.preconnect },
  );
  const queryClient = new QueryClient();
  const options = correspondenceDropsOptions("matter-a");
  const result = await queryClient.fetchInfiniteQuery({ ...options, pages: 3 });
  expect(calls).toHaveLength(2);
  expect(calls.at(0)?.pathname).toBe(
    "/v1/workspaces/matter-a/correspondence/drops",
  );
  expect(calls.at(0)?.searchParams.has("cursor")).toBe(false);
  expect(calls.at(1)?.searchParams.get("cursor")).toBe(cursor);
  expect(calls.map((url) => url.searchParams.get("limit"))).toEqual([
    "25",
    "25",
  ]);
  expect(result.pageParams).toEqual([undefined, cursor]);
  expect(result.pages.at(-1)?.nextCursor).toBeNull();
  expect(result.pages.flatMap((page) => page.items)).toHaveLength(26);
  expect(result.pages.at(0)?.items.at(0)?.reason).toBe("authentication_failed");
  queryClient.clear();
});

test("rejection-page invalidation refreshes its own pages without touching another matter or accepted-mail cache", async () => {
  const queryClient = new QueryClient();
  const own = correspondenceDropsOptions("matter-a").queryKey;
  const other = correspondenceDropsOptions("matter-b").queryKey;
  const accepted = correspondenceKeys.infinite("matter-a", 25);
  expect(own).not.toEqual(accepted);
  for (const queryKey of [own, other, accepted]) {
    queryClient.setQueryData(queryKey, { pages: [], pageParams: [] });
  }
  await queryClient.invalidateQueries({ queryKey: own });
  expect(queryClient.getQueryState(own)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(other)?.isInvalidated).toBe(false);
  expect(queryClient.getQueryState(accepted)?.isInvalidated).toBe(false);
  queryClient.clear();
});
