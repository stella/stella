import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { CAPABILITY_REQUEST_HEADER } from "@stll/api-contract/capability-request";
import type { OrganizationDataBoxesResponse } from "@stll/api-contract/data-box";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/admin/general" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { roleOptions } = await import("@/lib/auth-queries");
const { allCorrespondenceQueryRoot } =
  await import("@/lib/resource-query-roots.logic");
const { OrganizationDataBoxesCard } = await import("./data-boxes-card");

const USER = {
  activeOrganizationId: "data-box-admin-organization",
  id: "data-box-admin",
  email: "admin@example.test",
  image: null,
  name: "Admin",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const BOXES_PATH = "/v1/organization-settings/correspondence/data-boxes";
const CORRESPONDENCE_KEY = [...allCorrespondenceQueryRoot(), "fixture"];
const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) {
    client.clear();
  }
  globalThis.fetch = originalFetch;
});
afterAll(async () => await unregisterDomEnvironment());

const mount = () => {
  const boxIds = new Set(["abc1234"]);
  const writes: { method: string; path: string; capability: string | null }[] =
    [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(
        input instanceof Request
          ? input
          : new URL(String(input), "http://localhost:3000"),
        init,
      );
      const { pathname } = new URL(request.url);
      if (pathname.endsWith("/auth/get-session")) {
        return Response.json({
          session: {
            userId: USER.id,
            activeOrganizationId: USER.activeOrganizationId,
          },
          user: { id: USER.id, email: USER.email, name: USER.name },
        });
      }
      if (pathname === BOXES_PATH && request.method === "POST") {
        const body: unknown = await request.json();
        if (
          typeof body !== "object" ||
          body === null ||
          !("boxId" in body) ||
          typeof body.boxId !== "string"
        ) {
          return panic("Expected a data-box ID request");
        }
        boxIds.add(body.boxId);
      } else if (
        pathname.startsWith(`${BOXES_PATH}/`) &&
        request.method === "DELETE"
      ) {
        boxIds.delete(pathname.slice(`${BOXES_PATH}/`.length));
      } else if (pathname !== BOXES_PATH || request.method !== "GET") {
        return panic("Unexpected data-box settings request", pathname);
      }
      if (request.method !== "GET") {
        writes.push({
          method: request.method,
          path: pathname,
          capability: request.headers.get(CAPABILITY_REQUEST_HEADER),
        });
      }
      return Response.json({
        boxIds: [...boxIds],
      } satisfies OrganizationDataBoxesResponse);
    },
    { preconnect: () => undefined },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(roleOptions.queryKey, "owner");
  client.setQueryData(CORRESPONDENCE_KEY, { revision: 1 });
  const view = render(
    <QueryClientProvider client={client}>
      <AuthenticatedUserProvider user={USER}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <OrganizationDataBoxesCard />
        </IntlProvider>
      </AuthenticatedUserProvider>
    </QueryClientProvider>,
  );
  return { view, client, writes };
};

test("data-box settings validate IDs and declare writes while refreshing correspondence", async () => {
  const { view, client, writes } = mount();
  expect(await view.findByText("abc1234")).toBeDefined();
  const input = view.getByLabelText(
    messages.contacts.communication.dataBoxPlaceholder,
  );
  const add = view.getByRole("button", { name: messages.common.add });
  fireEvent.change(input, { target: { value: "inv!lid" } });
  fireEvent.click(add);
  expect(
    view.getByText(messages.settings.organization.dataBoxes.invalid),
  ).toBeDefined();
  expect(writes).toEqual([]);
  fireEvent.change(input, { target: { value: "NEWBOX1" } });
  fireEvent.click(add);
  expect(await view.findByText("newbox1")).toBeDefined();
  expect(writes).toEqual([
    {
      method: "POST",
      path: BOXES_PATH,
      capability: "organization-settings.correspondence.data-boxes.create",
    },
  ]);
  await waitFor(() =>
    expect(client.getQueryState(CORRESPONDENCE_KEY)?.isInvalidated).toBe(true),
  );
  client.setQueryData(CORRESPONDENCE_KEY, { revision: 2 });
  fireEvent.click(
    view.getByRole("button", {
      name: messages.settings.organization.dataBoxes.remove.replace(
        "{boxId}",
        "newbox1",
      ),
    }),
  );
  await waitFor(() => expect(view.queryByText("newbox1")).toBeNull());
  expect(writes.at(1)).toEqual({
    method: "DELETE",
    path: `${BOXES_PATH}/newbox1`,
    capability: "organization-settings.correspondence.data-boxes.delete",
  });
  await waitFor(() =>
    expect(client.getQueryState(CORRESPONDENCE_KEY)?.isInvalidated).toBe(true),
  );
});
