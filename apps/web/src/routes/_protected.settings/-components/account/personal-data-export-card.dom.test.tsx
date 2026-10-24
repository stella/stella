import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { CAPABILITY_REQUEST_HEADER } from "@stll/api-contract/capability-request";

import messages from "@/i18n/langs/en.json";
import type { AccountDataExportStatus } from "@/lib/account/account-data-export-queries";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({
  url: "http://localhost:3000/settings/account/profile",
});
const originalFetch = globalThis.fetch;
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { PersonalDataExportCard } = await import("./personal-data-export-card");

let latestExport: AccountDataExportStatus | null = null;
let deferredLatestExportResponse: Promise<Response> | null = null;
let deferredPostResponse: Promise<Response> | null = null;
const requestedPaths: string[] = [];
const declaredExportCapabilities: (string | null)[] = [];
const latestGetSignals: AbortSignal[] = [];

const requestUrl = (input: RequestInfo | URL): string => {
  if (input instanceof Request) {
    return input.url;
  }
  return input instanceof URL ? input.href : input;
};

globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(requestUrl(input));
    const method = init?.method ?? request?.method ?? "GET";
    requestedPaths.push(`${method} ${url.pathname}`);

    if (url.pathname === "/v1/me/data-exports" && method === "GET") {
      const signal = init?.signal ?? request?.signal;
      if (signal) {
        latestGetSignals.push(signal);
      }
      if (deferredLatestExportResponse) {
        const response = deferredLatestExportResponse;
        deferredLatestExportResponse = null;
        return response;
      }
      return Response.json({ latest: latestExport });
    }
    if (url.pathname === "/v1/me/data-exports" && method === "POST") {
      declaredExportCapabilities.push(
        new Headers(init?.headers ?? request?.headers).get(
          CAPABILITY_REQUEST_HEADER,
        ),
      );
      if (deferredPostResponse) {
        const response = deferredPostResponse;
        deferredPostResponse = null;
        return response;
      }
      latestExport = {
        id: "0199d851-071b-7000-8000-000000000001",
        status: "requested",
      };
      return Response.json(latestExport);
    }
    return Response.json(
      { message: "Unexpected account export request" },
      { status: 404 },
    );
  },
  { preconnect: originalFetch.preconnect },
);

const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(async () => {
  await act(async () => cleanup());
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  latestExport = null;
  deferredLatestExportResponse = null;
  deferredPostResponse = null;
  requestedPaths.length = 0;
  declaredExportCapabilities.length = 0;
  latestGetSignals.length = 0;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const renderAccountCard = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  clients.push(client);

  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId: "organization",
            email: "member@example.test",
            id: "user",
            image: null,
            name: "Member",
            preferredName: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          }}
        >
          <PersonalDataExportCard />
        </AuthenticatedUserProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

  return client;
};

test("a person requests, waits for, and downloads their account export", async () => {
  renderAccountCard();

  fireEvent.click(
    await screen.findByRole("button", { name: "Request export" }),
  );
  expect(await screen.findByText("Preparing your export…")).toBeTruthy();
  expect(requestedPaths).toContain("POST /v1/me/data-exports");
  expect(declaredExportCapabilities).toEqual(["account-exports.create"]);

  latestExport = {
    id: "0199d851-071b-7000-8000-000000000001",
    status: "ready",
    expiresAt: "2099-01-01T12:00:00.000Z",
  };
  expect(
    await screen.findByText("Your export is ready.", {}, { timeout: 5000 }),
  ).toBeTruthy();
  expect(screen.getByText(/Available until/u)).toBeTruthy();

  const downloadLink = screen.getByRole("link", { name: "Download" });
  expect(downloadLink.getAttribute("href")).toContain(
    "/v1/me/data-exports/0199d851-071b-7000-8000-000000000001/download",
  );
  expect(downloadLink.getAttribute("download")).not.toBeNull();
  expect(requestedPaths).not.toContain(
    "GET /v1/me/data-exports/0199d851-071b-7000-8000-000000000001/download",
  );
});

test("a failed export offers a replacement request", async () => {
  latestExport = {
    id: "0199d851-071b-7000-8000-000000000002",
    status: "failed",
  };
  renderAccountCard();

  const failure = await screen.findByRole("alert");
  expect(failure.textContent).toBe("Your export could not be prepared.");
  fireEvent.click(screen.getByRole("button", { name: "Request a new export" }));
  expect(await screen.findByText("Preparing your export…")).toBeTruthy();
  expect(requestedPaths).toContain("POST /v1/me/data-exports");
});

test("an expired export offers a replacement request", async () => {
  latestExport = {
    id: "0199d851-071b-7000-8000-000000000003",
    status: "expired",
  };
  renderAccountCard();

  expect(await screen.findByText("This export has expired.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Request a new export" }));
  expect(await screen.findByText("Preparing your export…")).toBeTruthy();
  expect(requestedPaths).toContain("POST /v1/me/data-exports");
});

test("a replacement request supersedes an older in-flight status read", async () => {
  const oldExport = {
    id: "0199d851-071b-7000-8000-000000000004",
    status: "failed",
  } as const satisfies AccountDataExportStatus;
  latestExport = oldExport;
  const client = renderAccountCard();

  expect(await screen.findByRole("alert")).toBeTruthy();

  const deferredGet = Promise.withResolvers<Response>();
  deferredLatestExportResponse = deferredGet.promise;
  void client.invalidateQueries();
  await waitFor(() => {
    expect(
      requestedPaths.filter((path) => path === "GET /v1/me/data-exports"),
    ).toHaveLength(2);
  });
  const staleGetSignal = latestGetSignals.at(-1);
  expect(staleGetSignal?.aborted).toBe(false);

  const deferredPost = Promise.withResolvers<Response>();
  deferredPostResponse = deferredPost.promise;
  fireEvent.click(screen.getByRole("button", { name: "Request a new export" }));
  await waitFor(() => expect(staleGetSignal?.aborted).toBe(true));

  latestExport = {
    id: "0199d851-071b-7000-8000-000000000005",
    status: "requested",
  };
  deferredPost.resolve(Response.json(latestExport));
  expect(await screen.findByText("Preparing your export…")).toBeTruthy();

  const deferredPoll = Promise.withResolvers<Response>();
  deferredLatestExportResponse = deferredPoll.promise;
  deferredGet.resolve(Response.json({ latest: oldExport }));
  await act(async () => {
    await deferredGet.promise;
  });

  await waitFor(() => {
    expect(
      requestedPaths.filter((path) => path === "GET /v1/me/data-exports")
        .length,
    ).toBeGreaterThanOrEqual(3);
  });
  expect(screen.getByText("Preparing your export…")).toBeTruthy();
  deferredPoll.resolve(Response.json({ latest: latestExport }));
  await waitFor(
    () => {
      expect(
        requestedPaths.filter((path) => path === "GET /v1/me/data-exports")
          .length,
      ).toBeGreaterThanOrEqual(4);
    },
    { timeout: 5000 },
  );
});
