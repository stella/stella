import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json" with { type: "json" };
import type { McpConnectorsResponse } from "@/lib/knowledge/queries";

GlobalRegistrator.register({
  url: "http://localhost:3000/settings/organization/tools",
});
const originalFetch = globalThis.fetch;
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { stellaToast } = await import("@stll/ui/toast");
const { roleOptions, sessionOptions } = await import("@/lib/auth-queries");
const { MEMBER_SESSION } =
  await import("@/lib/account/auth-session.test-fixtures");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { NativeToolsList } = await import("./native-tools-list");

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const OWNER_SESSION = {
  ...MEMBER_SESSION,
  user: {
    ...MEMBER_SESSION.user,
    id: "user",
    email: "owner@example.test",
    name: "Owner",
  },
  session: {
    ...MEMBER_SESSION.session,
    userId: "user",
    activeOrganizationId: "organization-fixture",
  },
} satisfies typeof MEMBER_SESSION;

const mount = async (refuse = false) => {
  let enabled = true;
  let reads = 0;
  const writes: unknown[] = [];
  const response = () =>
    ({
      canManageCustomConnectors: true,
      connectors: [],
      nativeTools: [
        {
          slug: "ares",
          displayName: "Český registr",
          description: "Company registry search",
          enabled,
          iconUrl: null,
          documentationUrl: null,
          isRecommended: true,
          recommendedJurisdictions: ["CZ"],
          url: "https://ares.gov.cz",
        },
      ],
    }) satisfies McpConnectorsResponse;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/auth/get-session")) {
        return Response.json(OWNER_SESSION);
      }
      if (path.endsWith("/auth/organization/get-active-member-role")) {
        return Response.json({ role: "owner" });
      }
      if (path.endsWith("/mcp/connectors")) {
        reads += 1;
        return Response.json(response());
      }
      if (
        request.method === "PATCH" &&
        path.endsWith("/mcp/native-tools/ares")
      ) {
        const body = await request.json();
        writes.push(body);
        if (refuse) {
          return Response.json(
            { code: "forbidden", message: "Permission denied" },
            { status: 403 },
          );
        }
        enabled = false;
        return Response.json({ enabled });
      }
      return Response.json(
        { message: `Unexpected request: ${path}` },
        { status: 500 },
      );
    },
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await queryClient.query(sessionOptions);
  await queryClient.query(roleOptions);
  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId: "organization-fixture",
            email: "owner@example.test",
            id: "user",
            image: null,
            name: "Owner",
            preferredName: null,
            timezoneId: "Europe/Prague",
            wordEditShortcut: null,
          }}
        >
          <NativeToolsList />
        </AuthenticatedUserProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { writes, reads: () => reads };
};

test("native tools read organization state, send toggle PATCH and refresh authoritative state", async () => {
  const server = await mount();
  const toggle = await screen.findByRole("switch", { name: "Český registr" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(toggle.getAttribute("aria-checked")).toBe("false"),
  );
  expect(server.writes).toEqual([{ enabled: false }]);
  expect(server.reads()).toBe(2);
});

test("native tool refusal keeps its server state and surfaces an error", async () => {
  const errorToast = spyOn(stellaToast, "add");
  try {
    const server = await mount(true);
    const toggle = await screen.findByRole("switch", { name: "Český registr" });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        errorToast.mock.calls.some(([toast]) => toast.type === "error"),
      ).toBe(true),
    );
    expect(server.writes).toEqual([{ enabled: false }]);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await waitFor(() =>
      expect(Object.hasOwn(toggle.dataset, "disabled")).toBe(false),
    );
    expect(server.reads()).toBe(1);
  } finally {
    errorToast.mockRestore();
  }
});

test("native tool inventory filters locally without case or accents and clears search", async () => {
  const server = await mount();
  await screen.findByRole("switch", { name: "Český registr" });
  const search = screen.getByRole("searchbox", {
    name: messages.common.search,
  });
  fireEvent.change(search, { target: { value: "CESKY" } });
  expect(screen.getByRole("switch", { name: "Český registr" })).toBeDefined();
  fireEvent.change(search, { target: { value: "unmatched" } });
  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.getByText(messages.common.noResults)).toBeDefined();
  const clearButtons = screen.getAllByRole("button", {
    name: messages.common.clearSearch,
  });
  expect(clearButtons.length).toBe(2);
  const emptyClear = clearButtons.at(-1);
  expect(emptyClear).toBeDefined();
  if (emptyClear) {
    fireEvent.click(emptyClear);
  }
  expect(screen.getByRole("switch", { name: "Český registr" })).toBeDefined();
  expect(server.reads()).toBe(1);
});
