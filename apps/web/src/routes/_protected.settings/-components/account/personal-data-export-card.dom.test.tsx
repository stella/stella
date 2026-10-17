import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import type { AccountDataExportStatus } from "@/lib/account/account-data-export-queries";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({
  url: "http://localhost:3000/settings/account/profile",
});
const originalFetch = globalThis.fetch;
const { act, cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { PersonalDataExportCard } = await import("./personal-data-export-card");

let latestExport: AccountDataExportStatus | null = null;
const requestedPaths: string[] = [];

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
      return Response.json({ latest: latestExport });
    }
    if (url.pathname === "/v1/me/data-exports" && method === "POST") {
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
  requestedPaths.length = 0;
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
};

test("a person requests, waits for, and downloads their account export", async () => {
  renderAccountCard();

  fireEvent.click(
    await screen.findByRole("button", { name: "Request export" }),
  );
  expect(await screen.findByText("Preparing your export…")).toBeTruthy();
  expect(requestedPaths).toContain("POST /v1/me/data-exports");

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
