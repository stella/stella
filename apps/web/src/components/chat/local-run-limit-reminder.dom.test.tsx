import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { ChatThreadRef } from "@/lib/chat-thread-ref";

GlobalRegistrator.register({ url: "https://app.example.test" });
Object.assign(import.meta.env, { VITE_API_URL: "https://api.example.test" });
const originalFetch = globalThis.fetch;
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider, createFormatter } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { default: en } = await import("@/i18n/langs/en.json");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { MEDIUM_DATE_SHORT_TIME_FORMAT } = await import("@/lib/relative-time");
const { chatLimitReminderOptions } =
  await import("@/features/chat/chat-limit-reminder");
const { LocalRunLimitReminder } = await import("./local-run-limit-reminder");
const { toSafeId } = await import("@/lib/safe-id");

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

const ORGANIZATION_ID = "org-limit-reminder";
const USER = {
  activeOrganizationId: ORGANIZATION_ID,
  email: "member@example.test",
  id: "user-limit-reminder",
  image: null,
  name: "Member",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const THREAD_REF = {
  scope: "global",
  threadId: toSafeId<"chatThread">("00000000-0000-4000-8000-000000000001"),
} as const satisfies ChatThreadRef;
const RESETS_AT = "2026-11-16T15:30:00.000Z";
const shownTime = createFormatter({ locale: "en", timeZone: "UTC" }).dateTime(
  new Date(RESETS_AT),
  MEDIUM_DATE_SHORT_TIME_FORMAT,
);

type StoredReminder =
  { remindAt: null } | { remindAt: string; onReset: "notify" | "continue" };

/** The member's chat with what the server reports it stores for it. */
const renderWith = (stored: StoredReminder) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    chatLimitReminderOptions({
      activeOrganizationId: ORGANIZATION_ID,
      threadRef: THREAD_REF,
      userId: USER.id,
    }).queryKey,
    stored,
  );
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <AuthenticatedUserProvider user={USER}>
            <LocalRunLimitReminder disabled={false} threadRef={THREAD_REF} />
          </AuthenticatedUserProvider>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

/**
 * Answers every request with `answer` (a write, and the read that refreshes
 * after it), keeping each write it was sent.
 */
const recordWrites = (answer: StoredReminder) => {
  const sent: { method: string; path: string; body: unknown }[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const text = await request.text();
      if (request.method === "GET") {
        return Response.json(answer);
      }
      sent.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: text === "" ? undefined : JSON.parse(text),
      });
      return Response.json(answer);
    },
    { preconnect: () => undefined },
  );
  return sent;
};

const scheduled = (key: "limitResumeScheduled" | "limitReminderScheduled") =>
  en.chat.localRun[key].replace("{time}", () => shownTime);

test("a stopped turn offers to continue by itself or to notify, and continuing shows when, with a way to cancel", async () => {
  const sent = recordWrites({ remindAt: RESETS_AT, onReset: "continue" });
  renderWith({ remindAt: null });
  expect(
    screen.getByRole("button", { name: en.chat.localRun.limitReminderNotify }),
  ).toBeTruthy();

  fireEvent.click(
    screen.getByRole("button", { name: en.chat.localRun.limitResumeContinue }),
  );

  await waitFor(() => {
    expect(screen.getByText(scheduled("limitResumeScheduled"))).toBeTruthy();
  });
  expect(sent).toEqual([
    {
      method: "PUT",
      path: `/v1/chat/threads/${THREAD_REF.threadId}/limit-reminder`,
      body: { onReset: "continue" },
    },
  ]);
  expect(screen.getByRole("button", { name: en.common.cancel })).toBeTruthy();
  expect(
    screen.queryByRole("button", {
      name: en.chat.localRun.limitResumeContinue,
    }),
  ).toBeNull();
});

test("a reload shows what the server stores: a continue, or a notification", () => {
  renderWith({ remindAt: RESETS_AT, onReset: "continue" });
  expect(screen.getByText(scheduled("limitResumeScheduled"))).toBeTruthy();
  cleanup();

  renderWith({ remindAt: RESETS_AT, onReset: "notify" });
  expect(screen.getByText(scheduled("limitReminderScheduled"))).toBeTruthy();
  expect(screen.queryByText(scheduled("limitResumeScheduled"))).toBeNull();
});

test("cancelling a continue removes it and offers both choices again", async () => {
  const sent = recordWrites({ remindAt: null });
  renderWith({ remindAt: RESETS_AT, onReset: "continue" });

  fireEvent.click(screen.getByRole("button", { name: en.common.cancel }));

  await waitFor(() => {
    expect(
      screen.getByRole("button", {
        name: en.chat.localRun.limitResumeContinue,
      }),
    ).toBeTruthy();
  });
  expect(sent.map(({ method }) => method)).toEqual(["DELETE"]);
  expect(screen.queryByText(scheduled("limitResumeScheduled"))).toBeNull();
});
