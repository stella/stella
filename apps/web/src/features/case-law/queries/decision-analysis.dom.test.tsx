import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { ANALYSIS_REQUEST_MODE } from "@stll/api-contract/case-law-analysis";
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

test("an HTTP provider failure stops automatic requests and query refetch remains a poll", async () => {
  const modes: (string | null)[] = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      modes.push(
        new URL(new Request(input, init).url).searchParams.get("mode"),
      );
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
    expect(modes).toEqual([ANALYSIS_REQUEST_MODE.poll]);
    await observer.refetch();
    expect(modes).toEqual([
      ANALYSIS_REQUEST_MODE.poll,
      ANALYSIS_REQUEST_MODE.poll,
    ]);
  } finally {
    unsubscribe();
    observer.destroy();
    client.clear();
  }
});
