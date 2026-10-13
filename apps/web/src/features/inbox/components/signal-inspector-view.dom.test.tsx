import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});

const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { workspacesNavigationOptions } =
  await import("@/lib/workspaces/queries");
const { inboxKeys } = await import("@/lib/inbox/queries");
const { featureEnrolmentsOptions } =
  await import("@/queries/feature-enrolments");
const { resetFeatureEnrolmentCache } =
  await import("@/queries/feature-enrolments.logic");
const { SignalInspectorView } = await import("./signal-inspector-view");

const CALLER = { organizationId: "org-a", userId: "member" };
const TAB = {
  id: "inbox-signal:signal-a",
  label: "Signal evidence",
  payload: { signalId: "signal-a" },
};

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const renderInspector = (signals: boolean, enrolled: boolean) => {
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(
        new URL(input instanceof Request ? input.url : String(input)).pathname,
      );
      return Response.json({ message: "unavailable" }, { status: 503 });
    },
    { preconnect: () => undefined },
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(workspacesNavigationOptions(CALLER).queryKey, {
    workspaces: [],
    features: { timeBilling: false, flows: false, signals },
  });
  queryClient.setQueryData(featureEnrolmentsOptions(CALLER).queryKey, {
    features: signals ? [{ featureId: "signals", enrolled }] : [],
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <AuthenticatedUserProvider
          user={{
            id: CALLER.userId,
            activeOrganizationId: CALLER.organizationId,
            email: "member@example.test",
            image: null,
            name: "Member",
            preferredName: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          }}
        >
          <SignalInspectorView tab={TAB} onClose={() => undefined} />
        </AuthenticatedUserProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { queryClient, requests, ...rendered };
};

test.each([false, true])(
  "a restored signal tab stays hidden while deployment admission is off (enrolled %s)",
  async (enrolled) => {
    const { queryClient, requests, container } = renderInspector(
      false,
      enrolled,
    );
    await act(async () => undefined);
    expect(container.textContent).toBe("");
    expect(requests.some((path) => path.includes("/signals/"))).toBe(false);
    expect(
      queryClient.getQueryCache().find({
        queryKey: inboxKeys.detail(
          CALLER.organizationId,
          CALLER.userId,
          TAB.payload.signalId,
        ),
      }),
    ).toBeUndefined();
    queryClient.clear();
  },
);

test("an open signal reader unmounts at opt-out and reconciliation starts no signal read", async () => {
  const { queryClient, requests, container, getByText } = renderInspector(
    true,
    true,
  );
  await waitFor(() => expect(getByText(TAB.label)).toBeDefined());
  await waitFor(() =>
    expect(requests.some((path) => path.includes("/signals/"))).toBe(true),
  );
  const reads = requests.filter((path) => path.includes("/signals/")).length;

  await act(async () => {
    queryClient.setQueryData(featureEnrolmentsOptions(CALLER).queryKey, {
      features: [{ featureId: "signals", enrolled: false }],
    });
  });
  await waitFor(() => expect(container.textContent).toBe(""));
  await act(async () => {
    await resetFeatureEnrolmentCache({
      queryClient,
      featureId: "signals",
      ...CALLER,
    });
  });
  expect(container.textContent).toBe("");
  expect(requests.filter((path) => path.includes("/signals/"))).toHaveLength(
    reads,
  );
  queryClient.clear();
});
