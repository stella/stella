import { useState } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";

import englishMessages from "@/i18n/langs/en.json";
import { MEMBER_SESSION } from "@/lib/account/auth-session.test-fixtures";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({
  url: "http://localhost:3000/contacts?tab=people",
});
const originalFetch = globalThis.fetch;
const sessionRejection = () =>
  Response.json(
    { code: "permission_denied", message: "Sign in to continue." },
    { status: 401 },
  );
let answer = sessionRejection;
let requests = 0;
globalThis.fetch = Object.assign(
  async () => {
    requests += 1;
    return answer();
  },
  { preconnect: originalFetch.preconnect },
);

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { ToastProvider, stellaToast } = await import("@stll/ui/toast");
const { sessionOptions } = await import("@/lib/auth-query-options");
const { useCreateContact } = await import("@/lib/contacts/mutations");
const { installSessionExpiredNotice, resetSessionExpiredNoticeForTests } =
  await import("@/lib/errors/session-expired");
const { createAppQueryClient } = await import("@/lib/react-query");

const SAVE_LABEL = "Save";

const ContactForm = () => {
  const createContact = useCreateContact();
  const [displayName, setDisplayName] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        createContact.mutate({ type: "person", displayName });
      }}
    >
      <input
        aria-label="Name"
        dir="ltr"
        onChange={(event) => setDisplayName(event.target.value)}
        value={displayName}
      />
      <button type="submit">{SAVE_LABEL}</button>
    </form>
  );
};

type RenderOptions = { signedIn: boolean };

const renderForm = ({ signedIn }: RenderOptions) => {
  const queryClient = createAppQueryClient();
  const stopNotice = installSessionExpiredNotice(queryClient);
  if (signedIn) {
    queryClient.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  }
  const view = render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
        <ContactForm />
        <ToastProvider />
      </IntlProvider>
    </QueryClientProvider>,
  );
  const typeName = (name: string) =>
    fireEvent.change(view.getByLabelText("Name"), { target: { value: name } });
  const save = async () => {
    const before = requests;
    fireEvent.click(view.getByText(SAVE_LABEL));
    await waitFor(() => {
      expect(requests).toBe(before + 1);
      expect(queryClient.isMutating()).toBe(0);
    });
  };
  return { queryClient, save, stopNotice, typeName, view };
};

afterEach(async () => {
  await act(async () => stellaToast.dismiss());
  cleanup();
  resetSessionExpiredNoticeForTests();
  answer = sessionRejection;
  requests = 0;
  mock.restore();
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

test("failed saves of an expired session show one notice and keep the form", async () => {
  const { save, stopNotice, typeName, view } = renderForm({ signedIn: true });
  typeName("Test contact");

  await save();
  await save();
  await save();

  expect(view.getAllByText(englishMessages.auth.sessionExpired)).toHaveLength(
    1,
  );
  expect(view.queryByText(englishMessages.errors.actionFailed)).toBeNull();
  expect(view.queryByText(englishMessages.errors.api.unauthorized)).toBeNull();
  expect(view.getByLabelText("Name")).toHaveProperty("value", "Test contact");
  expect(window.location.pathname).toBe("/contacts");
  expect(requests).toBe(3);
  stopNotice();
});

test("the sign-in action opens the way back in a new tab and runs nothing", async () => {
  const open = spyOn(window, "open").mockReturnValue(null);
  const { save, stopNotice, typeName, view } = renderForm({ signedIn: true });
  typeName("Test contact");
  await save();

  fireEvent.click(view.getByText(englishMessages.auth.signIn));

  expect(open).toHaveBeenCalledTimes(1);
  expect(open.mock.calls.at(0)?.slice(0, 2)).toEqual([
    `/auth?redirectTo=${encodeURIComponent("/contacts?tab=people")}`,
    "_blank",
  ]);
  expect(view.getByLabelText("Name")).toHaveProperty("value", "Test contact");
  expect(requests).toBe(1);
  stopNotice();
});

test("a member's session read clears the notice and saving is left to the person", async () => {
  const { queryClient, save, stopNotice, view } = renderForm({
    signedIn: true,
  });
  await save();

  await act(async () => {
    queryClient.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  });

  await waitFor(() => {
    expect(view.queryByText(englishMessages.auth.signIn)).toBeNull();
  });
  expect(requests).toBe(1);
  stopNotice();
});

test("a session read that comes back empty leaves the notice available", async () => {
  const { queryClient, save, stopNotice, view } = renderForm({
    signedIn: true,
  });

  await act(async () => {
    queryClient.setQueryData(sessionOptions.queryKey, null);
  });
  await save();

  expect(view.getAllByText(englishMessages.auth.sessionExpired)).toHaveLength(
    1,
  );
  stopNotice();
});

test("a visitor who never signed in gets the plain message, no session notice", async () => {
  const { save, stopNotice, view } = renderForm({ signedIn: false });

  await save();

  expect(view.queryByText(englishMessages.auth.sessionExpired)).toBeNull();
  expect(view.getByText(englishMessages.errors.api.unauthorized)).toBeTruthy();
  stopNotice();
});

test("a 401 that refuses something else is not an expired session", async () => {
  answer = () =>
    Response.json(
      { code: "INVALID_EMAIL_OR_PASSWORD", message: "Wrong password." },
      { status: 401 },
    );
  const { save, stopNotice, view } = renderForm({ signedIn: true });

  await save();

  expect(view.queryByText(englishMessages.auth.sessionExpired)).toBeNull();
  expect(view.getByText(englishMessages.errors.actionFailed)).toBeTruthy();
  stopNotice();
});
