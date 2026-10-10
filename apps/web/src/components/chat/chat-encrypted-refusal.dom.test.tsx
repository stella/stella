import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

// A DOM for this file only; everything that touches it loads afterwards.
GlobalRegistrator.register({ url: "https://app.example.test/chat" });

const previousApiUrl = process.env["VITE_API_URL"];
process.env["VITE_API_URL"] = previousApiUrl ?? "https://api.example.test";

const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { chatFetchClient } = await import("@/features/chat/chat-fetch");
const { ChatErrorMessage } =
  await import("@/components/chat/chat-thread-messages");

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  if (previousApiUrl === undefined) {
    delete process.env["VITE_API_URL"];
  } else {
    process.env["VITE_API_URL"] = previousApiUrl;
  }
  await unregisterDomEnvironment();
});

/** The chat request the API refused, as the chat transport surfaces it. */
const refusedChatRequest = async (body: unknown): Promise<Error> => {
  globalThis.fetch = Object.assign(
    async () =>
      await Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
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

const renderError = (error: Error) =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ChatErrorMessage
        error={error}
        isGenerating={false}
        onResend={() => {}}
      />
    </IntlProvider>,
  );

test("an encrypted attachment's refusal tells the user why, not a generic failure", async () => {
  const error = await refusedChatRequest({
    code: "encrypted_content",
    message: "Encrypted document content cannot be extracted.",
  });

  const view = renderError(error);

  expect(
    view.getByText(
      "Encrypted document content cannot be extracted. Remove the password from the file and try again.",
    ),
  ).toBeDefined();
  expect(
    view.queryByText(/There was an issue sending your message/u),
  ).toBeNull();
});

test("an unrelated refusal keeps the generic copy", async () => {
  const error = await refusedChatRequest({
    code: "some_other_refusal",
    message: "internal detail",
  });

  const view = renderError(error);

  expect(
    view.getByText(/There was an issue sending your message/u),
  ).toBeDefined();
  expect(view.queryByText(/internal detail/u)).toBeNull();
});
