import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";

const CONTACT_ONE = "00000000-0000-4000-8000-000000000001";
const CONTACT_TWO = "00000000-0000-4000-8000-000000000002";

const receivedBatches: string[][] = [];
const deleteContacts = async (contactIds: readonly string[]) => {
  receivedBatches.push([...contactIds]);
  if (receivedBatches.length === 1) {
    return [
      { contactId: CONTACT_ONE, status: "deleted" as const },
      { contactId: CONTACT_TWO, status: "blocked" as const },
    ];
  }
  return [{ contactId: CONTACT_TWO, status: "deleted" as const }];
};

const deleteContactsWithMissing = async (contactIds: readonly string[]) => {
  receivedBatches.push([...contactIds]);
  return [
    { contactId: CONTACT_ONE, status: "deleted" as const },
    { contactId: CONTACT_TWO, status: "not_found" as const },
  ];
};

GlobalRegistrator.register({ url: "http://localhost:3000/contacts/import" });
const { act, cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const router = await import("@tanstack/react-router");
const { ToastProvider } = await import("@stll/ui/toast");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { ImportDoneStep } = await import("./import-done-step");

afterEach(async () => {
  receivedBatches.length = 0;
  await act(async () => cleanup());
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const RESULTS = [
  {
    rowNumber: 1,
    displayName: "Ada Novak",
    status: "created" as const,
    contactId: toSafeId<"contact">(CONTACT_ONE),
  },
  {
    rowNumber: 2,
    displayName: "Bo Svoboda",
    status: "created" as const,
    contactId: toSafeId<"contact">(CONTACT_TWO),
  },
  {
    rowNumber: 3,
    displayName: "Cy Dvorak",
    status: "skipped" as const,
    reason: "duplicate_tax_id" as const,
  },
];

const renderDoneStep = async (
  remove: typeof deleteContacts | typeof deleteContactsWithMissing,
) => {
  const queryClient = new QueryClient();
  const root = router.createRootRoute({
    component: () => (
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <QueryClientProvider client={queryClient}>
            <ImportDoneStep
              activeOrganizationId="organization-one"
              deleteContacts={remove}
              onRestart={() => undefined}
              results={RESULTS}
              stepHeadingRef={{ current: null }}
            />
            <ToastProvider />
          </QueryClientProvider>
        </FormattingProvider>
      </IntlProvider>
    ),
  });
  const appRouter = router.createRouter({
    routeTree: root.addChildren([
      router.createRoute({
        getParentRoute: () => root,
        path: "/contacts/import",
      }),
      router.createRoute({
        getParentRoute: () => root,
        path: "/contacts/$contactId",
      }),
      router.createRoute({ getParentRoute: () => root, path: "/contacts" }),
    ]),
    history: router.createMemoryHistory({
      initialEntries: ["/contacts/import"],
    }),
    isServer: false,
  });
  await act(async () => {
    render(<router.RouterProvider router={appRouter} />);
  });
  await screen.findByText("Import complete: 2 created; 1 skipped");
};

const confirmUndo = async (count: number) => {
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: `Undo import (${count})` }),
    ),
  );
  expect(screen.getByText("Undo this import?")).toBeTruthy();
  expect(
    screen.getByText(
      `Permanently delete the ${count === 1 ? "contact" : `${count} contacts`} this import created? This action cannot be undone.`,
    ),
  ).toBeTruthy();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Delete" })),
  );
};

test("the receipt shows what undo removed and keeps blocked contacts for a retry", async () => {
  await renderDoneStep(deleteContacts);

  await confirmUndo(2);

  expect(await screen.findByText("Contacts not removed: 1")).toBeTruthy();
  expect(
    screen.getByText("Undo removed 1 contact created by this import."),
  ).toBeTruthy();
  expect(screen.getAllByText("Removed by undo")).toHaveLength(1);
  expect(screen.queryByRole("link", { name: "Ada Novak" })).toBeNull();
  expect(screen.getByRole("link", { name: "Bo Svoboda" })).toBeTruthy();

  await confirmUndo(1);

  expect(
    await screen.findByText("Import undone: 1 contact deleted"),
  ).toBeTruthy();
  expect(
    screen.getByText("Undo removed 2 contacts created by this import."),
  ).toBeTruthy();
  expect(screen.getAllByText("Removed by undo")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /Undo import/u })).toBeNull();
  expect(receivedBatches).toEqual([[CONTACT_ONE, CONTACT_TWO], [CONTACT_TWO]]);
});

test("contacts already missing count as removed, and undo disappears", async () => {
  await renderDoneStep(deleteContactsWithMissing);

  await confirmUndo(2);

  expect(await screen.findByText("Contacts not removed: 1")).toBeTruthy();
  expect(
    screen.getByText("Undo removed 2 contacts created by this import."),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Undo import/u })).toBeNull();
  expect(receivedBatches).toEqual([[CONTACT_ONE, CONTACT_TWO]]);
});
