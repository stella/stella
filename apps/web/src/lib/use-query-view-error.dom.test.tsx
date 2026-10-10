import type { PropsWithChildren } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

GlobalRegistrator.register();

const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
const { cleanup, renderHook } = await import("@testing-library/react");
const { AnalyticsContext } = await import("./analytics/provider");
const { noopAnalytics } = await import("./analytics/noop");
const { queryView } = await import("./query-view.logic");
const { useQueryViewErrors } = await import("./use-query-view");

afterEach(cleanup);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("optional batches report a shared failure once until it clears", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const failure = new Error("refresh failed");
  client.setQueryData(["optional-batch"], [1]);
  const read = mock(async () => [1])
    .mockRejectedValueOnce(failure)
    .mockResolvedValue([1]);
  const observer = new QueryObserver(client, {
    queryKey: ["optional-batch"],
    queryFn: read,
    enabled: false,
  });
  const failed = queryView(await observer.refetch());
  const captureError = mock((error: unknown) => error);
  const analytics = { ...noopAnalytics, captureError };
  const Wrapper = ({ children }: PropsWithChildren) => (
    <AnalyticsContext value={analytics}>{children}</AnalyticsContext>
  );
  const { rerender } = renderHook(({ views }) => useQueryViewErrors(views), {
    initialProps: { views: [failed, failed] },
    wrapper: Wrapper,
  });
  expect(captureError).toHaveBeenCalledTimes(1);
  expect(captureError).toHaveBeenCalledWith(failure);
  rerender({ views: [failed, failed] });
  expect(captureError).toHaveBeenCalledTimes(1);

  rerender({ views: [queryView(await observer.refetch())] });
  expect(captureError).toHaveBeenCalledTimes(1);
  rerender({ views: [failed] });
  expect(captureError).toHaveBeenCalledTimes(2);
  observer.destroy();
  client.clear();
});
