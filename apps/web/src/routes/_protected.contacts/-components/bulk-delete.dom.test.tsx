import { useState } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, expect, test } from "bun:test";

import { CONTACT_BULK_DELETE_LIMIT } from "@stll/api-contract";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

const receivedBatches: string[][] = [];
const deleteContacts = async (contactIds: readonly string[]) => {
  receivedBatches.push([...contactIds]);
  return contactIds.map((contactId) => ({
    contactId,
    status: "deleted" as const,
  }));
};
const deleteContactsPartially = async (contactIds: readonly string[]) => {
  receivedBatches.push([...contactIds]);
  return [
    { contactId: "contact-one", status: "deleted" as const },
    { contactId: "contact-two", status: "blocked" as const },
    { contactId: "contact-three", status: "not_found" as const },
  ];
};

GlobalRegistrator.register({ url: "http://localhost:3000/contacts" });
const { act, cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ToastProvider } = await import("@stll/ui/toast");
const { BulkDeleteContacts } = await import("./bulk-delete");

afterEach(async () => {
  receivedBatches.length = 0;
  await act(async () => cleanup());
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

function Fixture() {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const ids = ["contact-one", "contact-two", "contact-three"];
  return (
    <>
      {ids.map((id) => (
        <label key={id}>
          <input
            aria-label={`Select ${id}`}
            checked={selected.includes(id)}
            onChange={(event) =>
              setSelected((current) =>
                event.target.checked
                  ? [...current, id]
                  : current.filter((selectedId) => selectedId !== id),
              )
            }
            type="checkbox"
          />
          {id}
        </label>
      ))}
      <BulkDeleteContacts
        contactIds={selected}
        deleteContacts={deleteContacts}
        onResolved={() => setSelected([])}
        organizationId="organization-one"
      />
    </>
  );
}

function PartialFixture() {
  const [selected, setSelected] = useState([
    "contact-one",
    "contact-two",
    "contact-three",
  ]);
  return (
    <>
      <BulkDeleteContacts
        contactIds={selected}
        deleteContacts={deleteContactsPartially}
        onResolved={(deletedIds) =>
          setSelected((currentIds) =>
            currentIds.filter((contactId) => !deletedIds.includes(contactId)),
          )
        }
        organizationId="organization-one"
      />
      <output>{selected.join(",")}</output>
      <ToastProvider />
    </>
  );
}

function LimitFixture({ count }: { count: number }) {
  return (
    <BulkDeleteContacts
      contactIds={Array.from(
        { length: count },
        (_, index) => `contact-${index}`,
      )}
      deleteContacts={deleteContacts}
      onResolved={() => undefined}
      organizationId="organization-one"
    />
  );
}

test("disables deletion above the API limit without sending a request", async () => {
  const queryClient = new QueryClient();
  await act(async () => {
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <QueryClientProvider client={queryClient}>
          <LimitFixture count={CONTACT_BULK_DELETE_LIMIT + 1} />
        </QueryClientProvider>
      </IntlProvider>,
    );
  });

  const action = screen.getByRole("button", { name: "Delete 501 contacts" });
  expect(action.hasAttribute("disabled")).toBe(true);
  expect(
    screen.getByText("Select no more than 500 contacts to delete at once."),
  ).toBeTruthy();
  await act(async () => fireEvent.click(action));
  expect(receivedBatches).toEqual([]);
});

test("enables deletion at the API limit", async () => {
  const queryClient = new QueryClient();
  await act(async () => {
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <QueryClientProvider client={queryClient}>
          <LimitFixture count={CONTACT_BULK_DELETE_LIMIT} />
        </QueryClientProvider>
      </IntlProvider>,
    );
  });

  expect(
    screen
      .getByRole("button", { name: "Delete 500 contacts" })
      .hasAttribute("disabled"),
  ).toBe(false);
  expect(
    screen.queryByText("Select no more than 500 contacts to delete at once."),
  ).toBeNull();
});

test("selects three contacts and confirms one bulk request", async () => {
  const queryClient = new QueryClient();
  await act(async () => {
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <QueryClientProvider client={queryClient}>
          <Fixture />
        </QueryClientProvider>
      </IntlProvider>,
    );
  });

  for (const id of ["contact-one", "contact-two", "contact-three"]) {
    await act(async () =>
      fireEvent.click(screen.getByLabelText(`Select ${id}`)),
    );
  }
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Delete 3 contacts" })),
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Delete" })),
  );

  expect(receivedBatches).toEqual([
    ["contact-one", "contact-two", "contact-three"],
  ]);
});

test("keeps blocked contacts selected and resolves deleted or missing contacts", async () => {
  const queryClient = new QueryClient();
  await act(async () => {
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <QueryClientProvider client={queryClient}>
          <PartialFixture />
        </QueryClientProvider>
      </IntlProvider>,
    );
  });

  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Delete 3 contacts" })),
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Delete" })),
  );

  expect(await screen.findByText("Contacts not removed: 2")).toBeTruthy();
  expect(screen.getByText("contact-two")).toBeTruthy();
  expect(screen.queryByText("Deleted 1 contact")).toBeNull();
});
