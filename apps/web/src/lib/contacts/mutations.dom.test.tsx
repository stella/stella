import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { posthog } from "posthog-js";

import { rejectionOf } from "@stll/property-testing/rejection";
import { stellaToast } from "@stll/ui/toast";

import englishMessages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
Object.defineProperty(globalThis, "__APP_VERSION__", {
  configurable: true,
  value: "test",
});
Object.defineProperty(globalThis, "__APP_COMMIT_SHA__", {
  configurable: true,
  value: "abc123",
});
const originalFetch = globalThis.fetch;
let transportFailure: Error = new DOMException("Cancelled", "AbortError");
globalThis.fetch = Object.assign(
  async () => await Promise.reject(transportFailure),
  { preconnect: originalFetch.preconnect },
);

const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { noopAnalytics } = await import("@/lib/analytics/noop");
const { createPostHogAnalytics } = await import("@/lib/analytics/posthog");
const { useCreateContact } = await import("./mutations");

const createAnalytics = () => {
  spyOn(posthog, "init").mockReturnValue(posthog);
  return createPostHogAnalytics({
    host: "https://posthog.test",
    key: "phc_test",
  }).analytics;
};

const renderCreateContact = () => {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const analytics = createAnalytics();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AnalyticsContext value={{ ...noopAnalytics, ...analytics }}>
        <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
          {children}
        </IntlProvider>
      </AnalyticsContext>
    </QueryClientProvider>
  );
  return renderHook(useCreateContact, { wrapper });
};

const createContact = async (
  hook: ReturnType<typeof renderCreateContact>,
): Promise<void> => {
  await act(async () => {
    const error = await rejectionOf(
      hook.result.current.mutateAsync({
        type: "person",
        displayName: "Test contact",
      }),
    );
    expect(error).toBeInstanceOf(Error);
  });
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
};

afterEach(async () => {
  await act(async () => cleanup());
  mock.restore();
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

test("an aborted contact creation reaches neither analytics nor toast", async () => {
  transportFailure = new DOMException("Cancelled", "AbortError");
  const captureException = spyOn(posthog, "captureException");
  const addToast = spyOn(stellaToast, "add");
  const hook = renderCreateContact();

  await createContact(hook);

  expect(captureException).not.toHaveBeenCalled();
  expect(addToast).not.toHaveBeenCalled();
});

test("a contact creation network failure is captured and shown", async () => {
  transportFailure = new TypeError("Failed to fetch");
  const captureException = spyOn(posthog, "captureException");
  const addToast = spyOn(stellaToast, "add").mockReturnValue("failure-toast");
  const hook = renderCreateContact();

  await createContact(hook);

  expect(captureException).toHaveBeenCalledTimes(1);
  expect(addToast).toHaveBeenCalledTimes(1);
});
