import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic, Result } from "better-result";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import type { TimeEntryFormValues } from "./time-entry-form";
import type { TimeEntryPricingSelection } from "./time-entry-pricing.logic";

GlobalRegistrator.register({ url: "http://localhost:3000/billing" });

const { act } = await import("react");
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { entitySummariesOptions } =
  await import("@/lib/workspaces/queries/entities");
const { billingCodesOptions } =
  await import("@/lib/workspaces/queries/billing-codes");
const { resolvedRateOptions } = await import("@/lib/workspaces/queries/rates");
const { toSafeId } = await import("@/lib/safe-id");
const { DEFAULT_CURRENCY, formatCurrencyAmount } =
  await import("@/components/billing/format-currency");
const { TimeEntryForm } = await import("./time-entry-form");

const WORKSPACE_ID = "00000000-0000-7000-8000-00000000b001";
const USER_ID = "00000000-0000-7000-8000-00000000b002";
const DATE_WORKED = "2026-10-01";
const SUBMIT_LABEL = "Record time";
const NO_RATE = { hourlyRate: null, currency: null };
const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const rateOptions = (activityCode: string) =>
  resolvedRateOptions({
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    date: DATE_WORKED,
    activityCode,
  });

const mount = () => {
  const submitted: TimeEntryFormValues[] = [];
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(entitySummariesOptions(WORKSPACE_ID).queryKey, [
    { id: "work-item-1", name: "Work item" },
  ]);
  client.setQueryData(billingCodesOptions(WORKSPACE_ID, "task").queryKey, []);
  client.setQueryData(billingCodesOptions(WORKSPACE_ID, "activity").queryKey, [
    {
      id: toSafeId<"billingCode">("00000000-0000-7000-8000-00000000b003"),
      type: "activity",
      code: "A1",
      label: "Review",
      active: true,
      sortOrder: 1,
    },
    {
      id: toSafeId<"billingCode">("00000000-0000-7000-8000-00000000b004"),
      type: "activity",
      code: "A2",
      label: "Preparation",
      active: true,
      sortOrder: 2,
    },
  ]);
  client.setQueryData(rateOptions("A1").queryKey, {
    hourlyRate: 10_000,
    currency: "EUR",
  });
  client.setQueryData(rateOptions("A2").queryKey, NO_RATE);
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <AuthenticatedUserProvider
            user={{
              activeOrganizationId: "00000000-0000-7000-8000-00000000b005",
              email: "member@example.test",
              id: USER_ID,
              image: null,
              name: "Member",
              preferredName: null,
              timezoneId: "UTC",
              wordEditShortcut: null,
            }}
          >
            <TimeEntryForm
              defaultValues={{
                matterId: "work-item-1",
                dateWorked: DATE_WORKED,
                activityCode: "A1",
                narrative: "Review documents",
              }}
              onSubmit={(values) => {
                submitted.push(values);
              }}
              submitLabel={SUBMIT_LABEL}
              userId={USER_ID}
              workspaceId={WORKSPACE_ID}
            />
          </AuthenticatedUserProvider>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { client, submitted };
};

const chooseActivity = async (code: "A1" | "A2") => {
  const trigger = screen.getByRole("combobox", {
    name: messages.billing.codes.activityCode,
  });
  await act(async () => {
    fireEvent.mouseDown(trigger, { button: 0 });
  });
  const option = await screen.findByRole("option", {
    name: new RegExp(code, "u"),
  });
  await act(async () => {
    fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
    fireEvent.click(option);
  });
};

const overrideRate = async () => {
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: messages.billing.rates.override }),
    );
  });
  await act(async () => {
    fireEvent.change(screen.getByPlaceholderText("350.00"), {
      target: { value: "275.50" },
    });
    fireEvent.change(screen.getByDisplayValue("EUR"), {
      target: { value: "EUR" },
    });
  });
};

const submit = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: SUBMIT_LABEL }));
  });
};

const expectAutomaticRate = async () => {
  await screen.findByText(
    `${formatCurrencyAmount(10_000, "EUR")}${messages.billing.rates.perHour}`,
  );
};

describe("TimeEntryForm activity pricing", () => {
  test("clears the automatic rate and currency when the next activity has no rate", async () => {
    const { submitted } = mount();
    await expectAutomaticRate();
    await chooseActivity("A2");
    await screen.findByText(messages.billing.rates.noRateFound);
    expect(
      screen.queryByText(
        `${formatCurrencyAmount(10_000, "EUR")}${messages.billing.rates.perHour}`,
      ),
    ).toBeNull();
    await submit();
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted.at(0)).toMatchObject({
      activityCode: "A2",
      rateAtEntry: 0,
      currency: DEFAULT_CURRENCY,
    });
  });

  const pricingCases = {
    automatic: { type: "automatic" },
    manual: { type: "manual", draft: "275.50", currency: "EUR" },
  } as const satisfies Record<
    TimeEntryPricingSelection["type"],
    TimeEntryPricingSelection
  >;
  test.each(Object.values(pricingCases))(
    "blocks button and direct form submission while the current activity lookup is pending in $type mode",
    async ({ type: mode }) => {
      const { client, submitted } = mount();
      await expectAutomaticRate();
      if (mode === "manual") {
        await overrideRate();
      }
      const deferred = Promise.withResolvers<typeof NO_RATE>();
      const options = rateOptions("A2");
      client.removeQueries({ queryKey: options.queryKey, exact: true });
      // The observer must join this in-flight lookup instead of making a request.
      const pending = Result.tryPromise(
        async () =>
          await client.query({
            ...options,
            queryFn: async () => await deferred.promise,
          }),
      );
      await chooseActivity("A2");
      const button = screen.getByRole("button", { name: SUBMIT_LABEL });
      await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
      await submit();
      const form = button.closest("form");
      if (form === null) {
        panic("Time-entry submit button is outside the form");
      }
      await act(async () => {
        fireEvent.submit(form);
      });
      expect(submitted).toEqual([]);
      await act(async () => {
        deferred.resolve(NO_RATE);
        expect(Result.isOk(await pending)).toBe(true);
      });
      await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
      await submit();
      await waitFor(() => expect(submitted).toHaveLength(1));
      expect(submitted.at(0)).toMatchObject(
        mode === "manual"
          ? { activityCode: "A2", rateAtEntry: 27_550, currency: "EUR" }
          : { activityCode: "A2", rateAtEntry: 0, currency: DEFAULT_CURRENCY },
      );
    },
  );

  test("preserves an explicit manual rate and currency when the activity changes", async () => {
    const { submitted } = mount();
    await expectAutomaticRate();
    await overrideRate();
    await chooseActivity("A2");
    expect(screen.getByPlaceholderText("350.00")).toHaveProperty(
      "value",
      "275.50",
    );
    expect(screen.getByDisplayValue("EUR")).toBeDefined();
    await submit();
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted.at(0)).toMatchObject({
      activityCode: "A2",
      rateAtEntry: 27_550,
      currency: "EUR",
    });
  });
});
