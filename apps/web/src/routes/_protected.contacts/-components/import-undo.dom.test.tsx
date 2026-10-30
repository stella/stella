import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

const receivedBatches: string[][] = [];
const deleteContacts = async (contactIds: readonly string[]) => {
  receivedBatches.push([...contactIds]);
  if (receivedBatches.length === 1) {
    return [
      { contactId: "contact-one", status: "deleted" as const },
      { contactId: "contact-two", status: "blocked" as const },
    ];
  }
  return [{ contactId: "contact-two", status: "deleted" as const }];
};

GlobalRegistrator.register({ url: "http://localhost:3000/contacts/import" });
const { act, cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { ToastProvider } = await import("@stll/ui/toast");
const { IntlProvider } = await import("use-intl");
const { ImportUndoContacts } = await import("./bulk-delete");

afterEach(async () => {
  receivedBatches.length = 0;
  await act(async () => cleanup());
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

test("keeps blocked imported contacts available for a focused retry", async () => {
  const queryClient = new QueryClient();
  await act(async () => {
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <QueryClientProvider client={queryClient}>
          <ImportUndoContacts
            contactIds={["contact-one", "contact-two"]}
            deleteContacts={deleteContacts}
            organizationId="organization-one"
          />
          <ToastProvider />
        </QueryClientProvider>
      </IntlProvider>,
    );
  });

  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Undo import (2)" })),
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Delete" })),
  );

  expect(await screen.findByText("Contacts not removed: 1")).toBeTruthy();
  expect(
    screen.getByText(
      "This contact is still assigned as a client on matters. Reassign or delete those matters before deleting the contact.",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Undo import (1)" })).toBeTruthy();

  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Undo import (1)" })),
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Delete" })),
  );

  expect(receivedBatches).toEqual([
    ["contact-one", "contact-two"],
    ["contact-two"],
  ]);
});
