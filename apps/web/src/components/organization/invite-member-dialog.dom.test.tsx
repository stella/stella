import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";

import englishMessages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/admin/members" });
const originalFetch = globalThis.fetch;
const refusal = (code: string, message: string) =>
  Response.json({ code, message }, { status: 400 });
const memberRefusal = () =>
  refusal(
    "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
    "User is already a member of this organization",
  );
let answer = memberRefusal;
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

const renderDialog = () => {
  const queryClient = createAppQueryClient();
  queryClient.setQueryData(roleOptions.queryKey, "owner");
  return render(
    <QueryClientProvider client={queryClient}>
      <AnalyticsContext value={noopAnalytics}>
        <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
          <InviteMemberDialog />
        </IntlProvider>
      </AnalyticsContext>
    </QueryClientProvider>,
  );
};

const submitInvite = async (view: ReturnType<typeof renderDialog>) => {
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: englishMessages.common.invite }),
    );
  });
  await view.findByRole("dialog");
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
      ),
    ).toHaveLength(1);
  });
  expect(addToast).not.toHaveBeenCalled();
  expect(view.queryByText(englishMessages.errors.actionFailed)).toBeNull();
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
      ),
    ).toHaveLength(1);
  });
  expect(addToast).not.toHaveBeenCalled();
});
