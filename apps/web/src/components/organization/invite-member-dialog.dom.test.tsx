import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import englishMessages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000/admin/members" });
const originalFetch = globalThis.fetch;
const refusal = (code: string, message: string) =>
  Response.json({ code, message }, { status: 400 });
const memberRefusal = () =>
  refusal(
    "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
    "User is already a member of this organization",
  );
let answer: () => Promise<Response> | Response = memberRefusal;
globalThis.fetch = Object.assign(async () => answer(), {
  preconnect: originalFetch.preconnect,
});

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { stellaToast } = await import("@stll/ui/toast");
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { noopAnalytics } = await import("@/lib/analytics/noop");
const { roleOptions } = await import("@/lib/auth-queries");
const { createAppQueryClient } = await import("@/lib/react-query");
const { InviteMemberDialog } = await import("./invite-member-dialog");

const renderDialog = (suggestedEmail?: string) => {
  const queryClient = createAppQueryClient();
  queryClient.setQueryData(roleOptions.queryKey, "owner");
  return render(
    <QueryClientProvider client={queryClient}>
      <AnalyticsContext value={noopAnalytics}>
        <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
          <InviteMemberDialog suggestedEmail={suggestedEmail} />
        </IntlProvider>
      </AnalyticsContext>
    </QueryClientProvider>,
  );
};

const openDialog = async (view: ReturnType<typeof renderDialog>) => {
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: englishMessages.common.invite }),
    );
  });
  await view.findByRole("dialog");
};

const addressField = (view: ReturnType<typeof renderDialog>) => {
  const field = view.getByRole("textbox");
  if (!(field instanceof HTMLInputElement)) {
    throw new TypeError("Expected the address field to be an input");
  }
  return field;
};

const submitInvite = async (view: ReturnType<typeof renderDialog>) => {
  await openDialog(view);
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "person@example.com" },
  });
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", {
        name: englishMessages.organization.invitations.sendInvitation,
      }),
    );
  });
};

afterEach(async () => {
  await act(async () => stellaToast.dismiss());
  cleanup();
  answer = memberRefusal;
  mock.restore();
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

test("an address that is already a member is told once, beside the field", async () => {
  const addToast = spyOn(stellaToast, "add");
  const view = renderDialog();

  await submitInvite(view);

  await waitFor(() => {
    expect(
      view.getAllByText(
        englishMessages.errors.apiCodes.alreadyOrganizationMember,
      ).length,
    ).toBe(1);
  });
  expect(addToast).not.toHaveBeenCalled();
  expect(view.queryByText(englishMessages.errors.actionFailed)).toBeNull();
});

test("a refusal that arrives after the dialog closed reaches a toast", async () => {
  const { promise: released, resolve: release } =
    Promise.withResolvers<undefined>();
  answer = async () => {
    await released;
    return memberRefusal();
  };
  const addToast = spyOn(stellaToast, "add");
  const view = renderDialog();

  await submitInvite(view);
  // Unsaved changes hold back the first close; the second one discards.
  for (const closeAttempt of ["holds", "discards"]) {
    const close = view
      .getAllByRole("button", { name: englishMessages.common.cancel })
      .at(-1);
    if (close === undefined) {
      throw new TypeError(`Expected a close button: ${closeAttempt}`);
    }
    await act(async () => {
      fireEvent.click(close);
    });
  }
  await waitFor(() => {
    expect(view.queryByRole("dialog") === null).toBe(true);
  });

  await act(async () => {
    release(undefined);
    await released;
  });

  await waitFor(() => {
    expect(addToast).toHaveBeenCalled();
  });
});

test("an address already invited says where to resend, without a toast", async () => {
  answer = () =>
    refusal(
      "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION",
      "User is already invited to this organization",
    );
  const addToast = spyOn(stellaToast, "add");
  const view = renderDialog();

  await submitInvite(view);

  await waitFor(() => {
    expect(
      view.getAllByText(
        englishMessages.errors.apiCodes.invitationAlreadyPending,
      ).length,
    ).toBe(1);
  });
  expect(addToast).not.toHaveBeenCalled();
});

test.each([
  ["  person@example.com ", "person@example.com"],
  ["Person@Example.com", "person@example.com"],
  ["person", ""],
  ["", ""],
])(
  "the search text %p opens the dialog with the address %p",
  async (search, expected) => {
    const view = renderDialog(search);

    await openDialog(view);

    expect(addressField(view).value).toBe(expected);
  },
);

test("a prefilled address closes without asking to discard it", async () => {
  const view = renderDialog("person@example.com");

  await openDialog(view);
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: englishMessages.common.cancel }),
    );
  });

  await waitFor(() => {
    expect(view.queryByRole("dialog") === null).toBe(true);
  });
});

test("each opening takes the search text of that moment", async () => {
  const view = renderDialog("first@example.com");
  await openDialog(view);
  fireEvent.change(addressField(view), {
    target: { value: "typed@example.com" },
  });
  for (const closeAttempt of ["holds", "discards"]) {
    const close = view
      .getAllByRole("button", { name: englishMessages.common.cancel })
      .at(-1);
    if (close === undefined) {
      throw new TypeError(`Expected a close button: ${closeAttempt}`);
    }
    await act(async () => {
      fireEvent.click(close);
    });
  }
  await waitFor(() => {
    expect(view.queryByRole("dialog") === null).toBe(true);
  });

  view.rerender(
    <QueryClientProvider client={createAppQueryClient()}>
      <AnalyticsContext value={noopAnalytics}>
        <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
          <InviteMemberDialog suggestedEmail="second@example.com" />
        </IntlProvider>
      </AnalyticsContext>
    </QueryClientProvider>,
  );
  await openDialog(view);

  expect(addressField(view).value).toBe("second@example.com");
});
