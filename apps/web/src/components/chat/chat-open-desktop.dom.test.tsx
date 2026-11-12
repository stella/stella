import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";

import type {
  ChatLocalRunReadiness,
  ChatLocalRunRefusal,
} from "@stll/api-contract/chat-run-target";
import { CHAT_LOCAL_RUN_REFUSAL } from "@stll/api-contract/chat-run-target";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { AuthenticatedUser } from "@/lib/authenticated-user-context";

import { createWebTestEnvironment } from "../../../tests/environment.test-fixtures";

// A DOM for this file only; everything that touches it loads afterwards.
GlobalRegistrator.register({ url: "https://app.example.test/chat" });

const testEnvironment = createWebTestEnvironment({ file: import.meta.path });
testEnvironment.setEnvIfAbsent("VITE_API_URL", "https://api.example.test");

const originalFetch = globalThis.fetch;

const { act } = await import("react");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { chatFetchClient } = await import("@/features/chat/chat-fetch");
const { DESKTOP_PING_URL } =
  await import("@/features/chat/desktop-launch.logic");
const desktopBridge = await import("@/lib/desktop-bridge");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { ChatErrorMessage } =
  await import("@/components/chat/chat-thread-messages");

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  mock.restore();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const user = {
  id: "open-desktop-test-user",
  activeOrganizationId: "open-desktop-test-organization",
  email: "open-desktop@example.test",
  name: "Open desktop test",
  image: null,
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
} satisfies AuthenticatedUser;

const CONNECTED: ChatLocalRunReadiness = {
  status: "enabled",
  runners: [
    {
      desktopId: "0192f3a0-6b1c-7d2e-8f30-000000000001",
      connected: true,
      lastSeenAt: "2026-11-12T10:00:00.000Z",
      harnesses: [],
    },
  ],
  maxApprovals: "full_auto",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A turn for the member's computer the API refused with `code`. */
const refusedTurn = async (code: ChatLocalRunRefusal): Promise<Error> => {
  globalThis.fetch = Object.assign(
    async () =>
      await Promise.resolve(
        json({ code, message: "English text for agents and logs" }, 409),
      ),
    { preconnect: () => undefined },
  );
  try {
    await chatFetchClient("https://api.example.test/chat", { method: "POST" });
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
  }
  throw new TypeError("expected the chat request to be refused");
};

test("the refusal's Open stella desktop opens it once, waits for the computer, then sends the turn again", async () => {
  const error = await refusedTurn(CHAT_LOCAL_RUN_REFUSAL.noComputer);
  // The member's computers are read until one connects; the read is held so
  // the test sees the wait.
  const readiness = Promise.withResolvers<Response>();
  const reads: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      reads.push(url);
      return await readiness.promise;
    },
    { preconnect: () => undefined },
  );
  const open = spyOn(desktopBridge, "openDesktopUrl").mockImplementation(
    () => undefined,
  );
  const resends: number[] = [];

  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <AuthenticatedUserProvider user={user}>
          <ChatErrorMessage
            error={error}
            isGenerating={false}
            onResend={() => {
              resends.push(resends.length);
            }}
          />
        </AuthenticatedUserProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

  expect(
    view.getByText(messages.chat.localRun.refusalNoComputer),
  ).toBeDefined();
  expect(
    view.getByRole("button", { name: messages.chat.resend }),
  ).toBeDefined();
  const button = view.getByRole("button", {
    name: messages.settings.account.desktopOpenApp,
  });

  await act(async () => {
    fireEvent.click(button);
  });

  // Opened on the click itself, and only once.
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith(DESKTOP_PING_URL);
  const opening = await view.findByRole("button", {
    name: messages.settings.account.desktopCardOpeningTitle,
  });
  expect(opening).toHaveProperty("disabled", true);
  await act(async () => {
    fireEvent.click(opening);
  });
  expect(open).toHaveBeenCalledTimes(1);
  expect(resends).toEqual([]);
  expect(reads.some((url) => url.includes("/chat/local-runners"))).toBe(true);

  await act(async () => {
    readiness.resolve(json(CONNECTED));
    await readiness.promise;
  });

  await waitFor(() => {
    expect(resends).toEqual([0]);
  });
  expect(open).toHaveBeenCalledTimes(1);
  expect(
    await view.findByRole("button", {
      name: messages.settings.account.desktopOpenApp,
    }),
  ).toBeDefined();
});

test("a refusal for another reason offers no Open stella desktop", async () => {
  const error = await refusedTurn(CHAT_LOCAL_RUN_REFUSAL.harnessUnavailable);

  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <AuthenticatedUserProvider user={user}>
          <ChatErrorMessage
            error={error}
            isGenerating={false}
            onResend={() => undefined}
          />
        </AuthenticatedUserProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

  expect(
    view.getByText(messages.chat.localRun.refusalHarnessUnavailable),
  ).toBeDefined();
  expect(
    view.queryByRole("button", {
      name: messages.settings.account.desktopOpenApp,
    }),
  ).toBeNull();
});
