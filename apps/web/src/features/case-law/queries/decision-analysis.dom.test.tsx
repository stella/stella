import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const previousFetch = globalThis.fetch;
const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
const { decisionAnalysisOptions } = await import("./decision-analysis");

afterAll(async () => {
  globalThis.fetch = previousFetch;
  await sleep(50);
  await GlobalRegistrator.unregister();
});

test("an HTTP provider failure stops automatic requests until an explicit retry", async () => {
  let requests = 0;
  globalThis.fetch = Object.assign(
    async () => {
      requests += 1;
      return Response.json(
        { message: "Provider authentication failed" },
        { status: 401 },
      );
    },
    { preconnect: previousFetch.preconnect },
  );
  const client = new QueryClient();
  const observer = new QueryObserver(
    client,
    decisionAnalysisOptions({
      decisionId: "01a02a37-2222-7222-8222-222222222222",
      decisionUpdatedAt: "2026-09-01T10:00:00.000Z",
      organizationId: "test-organization",
    }),
  );
  let reportFailure: () => void = () => undefined;
  const failed = new Promise<void>((resolve) => {
    reportFailure = resolve;
  });
  const unsubscribe = observer.subscribe((result) => {
    if (result.status === "error") {
      reportFailure();
    }
  });
  try {
    await failed;
    await sleep(2200);
    expect(requests).toBe(1);
    await observer.refetch();
    expect(requests).toBe(2);
  } finally {
    unsubscribe();
    observer.destroy();
    client.clear();
  }
});
