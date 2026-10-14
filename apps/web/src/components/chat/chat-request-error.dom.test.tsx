import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { createWebTestEnvironment } from "../../../tests/environment.test-fixtures";

GlobalRegistrator.register({ url: "https://app.example.test/chat" });

const testEnvironment = createWebTestEnvironment({ file: import.meta.path });
testEnvironment.setEnvIfAbsent("VITE_API_URL", "https://api.example.test");

const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { default: en } = await import("@/i18n/langs/en.json");
const { default: cs } = await import("@/i18n/langs/cs.json");
const { ChatRequestError } = await import("@/features/chat/chat-request-error");
const { ChatErrorMessage } =
  await import("@/components/chat/chat-thread-messages");

afterEach(cleanup);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const ERROR_COPY = {
  preparation_failed: {
    kind: "preparation_failed",
    copy: "sendErrorPreparationFailed",
  },
  connection_failed: {
    kind: "connection_failed",
    copy: "sendErrorConnectionFailed",
  },
  timed_out: { kind: "timed_out", copy: "sendErrorTimedOut" },
  not_started: { kind: "not_started", copy: "sendErrorNotStarted" },
} as const satisfies Record<
  InstanceType<typeof ChatRequestError>["kind"],
  {
    kind: InstanceType<typeof ChatRequestError>["kind"];
    copy: keyof typeof en.chat;
  }
>;

for (const { locale, messages } of [
  { locale: "en", messages: en },
  { locale: "cs", messages: cs },
]) {
  for (const { kind, copy } of Object.values(ERROR_COPY)) {
    test(`${locale} assistant bubble explains ${kind} through a wrapped cause`, () => {
      const error = new ChatRequestError({
        kind,
        message: "Internal request diagnostic",
        cause: new TypeError("Private transport detail"),
      });
      const wrapped = new TypeError("SDK wrapper diagnostic", {
        cause: error,
      });
      const view = render(
        <IntlProvider locale={locale} messages={messages} timeZone="UTC">
          <ChatErrorMessage error={wrapped} isGenerating={false} />
        </IntlProvider>,
      );

      expect(view.getByText(messages.chat[copy])).toBeDefined();
      expect(view.queryByText(messages.chat.sendError)).toBeNull();
      expect(view.container.textContent).not.toContain("diagnostic");
      expect(view.container.textContent).not.toContain("Private transport");
    });
  }
}
