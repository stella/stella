import { useState } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, expect, test } from "bun:test";

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

GlobalRegistrator.register({ url: "http://localhost:3000/contacts" });
const { act, cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
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
        onDeleted={() => setSelected([])}
        organizationId="organization-one"
      />
    </>
  );
}

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
