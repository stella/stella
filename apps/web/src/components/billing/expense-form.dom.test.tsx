import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/billing" });

const { act } = await import("react");
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { entitySummariesOptions } =
  await import("@/lib/workspaces/queries/entities");
const { ExpenseForm } = await import("./expense-form");

const WORKSPACE_ID = "workspace-1";
const SUBMIT_LABEL = "Record expense";

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const mount = () => {
  const submitted: unknown[] = [];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(entitySummariesOptions(WORKSPACE_ID).queryKey, [
    { id: "matter-1", name: "Matter one" },
  ]);
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <ExpenseForm
            defaultValues={{
              matterId: "matter-1",
              currency: "EUR",
              amount: 1000,
            }}
            onSubmit={(values) => {
              submitted.push(values);
            }}
            submitLabel={SUBMIT_LABEL}
            workspaceId={WORKSPACE_ID}
          />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { client, submitted };
};

const submit = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: SUBMIT_LABEL }));
  });
};

describe("ExpenseForm currency", () => {
  test("shows the currency error beside the field and does not submit", async () => {
    const { client, submitted } = mount();
    fireEvent.change(screen.getByDisplayValue("EUR"), {
      target: { value: "12" },
    });
    await submit();

    const error = await screen.findByText(
      messages.billing.sellerProfiles.invalidCurrency,
    );
    expect(error.closest("[data-slot='field']")).not.toBeNull();
    expect(
      error
        .closest("[data-slot='field']")
        ?.querySelector("input[maxlength='3']"),
    ).not.toBeNull();
    expect(submitted).toEqual([]);
    client.clear();
  });

  test("submits a valid three-letter code", async () => {
    const { client, submitted } = mount();
    await submit();

    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted.at(0)).toMatchObject({ currency: "EUR", amount: 1000 });
    expect(
      screen.queryByText(messages.billing.sellerProfiles.invalidCurrency),
    ).toBeNull();
    client.clear();
  });
});
