import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { CAPABILITY_REQUEST_HEADER } from "@stll/api-contract/capability-request";

import arMessages from "@/i18n/langs/ar.json" with { type: "json" };
import messages from "@/i18n/langs/en.json" with { type: "json" };
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/admin/general" });
const originalFetch = globalThis.fetch;
const { act, cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { OrganizationSlugCard } = await import("./slug-card");

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const mount = (locale: "en" | "ar" = "en", canChange = true) => {
  let completed = 0;
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      }
    >
      <IntlProvider
        locale={locale}
        messages={locale === "ar" ? arMessages : messages}
        timeZone="UTC"
      >
        <div dir={locale === "ar" ? "rtl" : "ltr"}>
          <OrganizationSlugCard
            slug="old-firm"
            canChange={canChange}
            onSuccess={async () => {
              completed += 1;
            }}
          />
        </div>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return () => completed;
};

const requestsWithResponse = (respond: () => Promise<Response>) => {
  const requests: { path: string; body: unknown; capability: string | null }[] =
    [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        path: new URL(request.url).pathname,
        body: await request.json(),
        capability: request.headers.get(CAPABILITY_REQUEST_HEADER),
      });
      return await respond();
    },
  );
  return requests;
};
const openDialog = async (locale: "en" | "ar" = "en") => {
  const catalog = locale === "ar" ? arMessages : messages;
  fireEvent.click(
    screen.getByRole("button", {
      name: catalog.settings.organization.slug.change,
    }),
  );
  return await screen.findByRole("dialog");
};
const changeExplicit = (dialog: HTMLElement) => {
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: "new-firm" },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: messages.common.saveChanges }),
  );
};

test("an explicit slug is submitted and closes the dialog after success", async () => {
  const requests = requestsWithResponse(async () =>
    Response.json({ slug: "new-firm" }),
  );
  const completed = mount();
  const dialog = await openDialog();
  expect(Object.hasOwn(dialog.dataset, "open")).toBe(true);
  changeExplicit(dialog);
  await waitFor(() => expect(completed()).toBe(1));
  await waitFor(() =>
    expect(
      document.querySelector("[data-slot=dialog-popup][data-open]"),
    ).toBeNull(),
  );
  expect(requests).toEqual([
    {
      path: "/v1/organizations/slug",
      capability: "organizations.slug.update",
      body: { type: "explicit", slug: "new-firm" },
    },
  ]);
});

test("the Arabic opaque option sends no explicit slug", async () => {
  const requests = requestsWithResponse(async () =>
    Response.json({ slug: "org-abcdefghij" }),
  );
  const completed = mount("ar");
  const dialog = await openDialog("ar");
  expect(within(dialog).getByRole("textbox").getAttribute("dir")).toBe("ltr");
  await act(async () => {
    fireEvent.click(
      within(dialog).getByRole("checkbox", {
        name: arMessages.settings.organization.slug.opaque,
      }),
    );
  });
  expect(within(dialog).getByRole("textbox")).toHaveProperty("disabled", true);
  fireEvent.click(
    within(dialog).getByRole("button", { name: arMessages.common.saveChanges }),
  );
  await waitFor(() => expect(completed()).toBe(1));
  expect(requests).toEqual([
    {
      path: "/v1/organizations/slug",
      body: { type: "opaque" },
      capability: "organizations.slug.update",
    },
  ]);
});

test("a typed conflict stays visible without completing", async () => {
  requestsWithResponse(async () =>
    Response.json(
      { code: "organization_slug_conflict", message: "Slug already used" },
      { status: 409 },
    ),
  );
  const completed = mount();
  const dialog = await openDialog();
  changeExplicit(dialog);
  await waitFor(() =>
    expect(within(dialog).getByRole("alert").textContent).toBe(
      messages.settings.organization.slug.conflict,
    ),
  );
  expect(completed()).toBe(0);
  expect(screen.getByRole("dialog")).toBeDefined();
});

test("pending changes disable editing, cancellation and duplicate submissions", async () => {
  const { promise, resolve } = Promise.withResolvers<Response>();
  const requests = requestsWithResponse(async () => await promise);
  const completed = mount();
  const dialog = await openDialog();
  changeExplicit(dialog);
  await waitFor(() => expect(requests).toHaveLength(1));
  const save = within(dialog).getByRole("button", {
    name: messages.common.saveChanges,
  });
  expect(save).toHaveProperty("disabled", true);
  expect(within(dialog).getByRole("textbox")).toHaveProperty("disabled", true);
  expect(
    within(dialog).getByRole("checkbox").getAttribute("aria-disabled"),
  ).toBe("true");
  expect(
    within(dialog).getByRole("button", { name: messages.common.cancel }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(save);
  expect(requests).toHaveLength(1);
  resolve(Response.json({ slug: "new-firm" }));
  await waitFor(() => expect(completed()).toBe(1));
});

test("members can read the slug without a change action", () => {
  mount("en", false);
  expect(screen.getByText("old-firm")).toBeDefined();
  expect(
    screen.queryByRole("button", {
      name: messages.settings.organization.slug.change,
    }),
  ).toBeNull();
});
