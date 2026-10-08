import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register();

const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FileChatOverlayErrorFallback } =
  await import("./file-chat-overlay-error-fallback");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const renderFallback = (error: Error, onRetry: () => void) =>
  render(
    <IntlProvider locale="en" messages={messages}>
      <FileChatOverlayErrorFallback error={error} onRetry={onRetry} />
    </IntlProvider>,
  );

test("a failed chat load names the document chat and retries", () => {
  let retries = 0;
  const view = renderFallback(new Error("thread read failed"), () => {
    retries += 1;
  });

  const alert = view.getByRole("alert");
  expect(alert.textContent).toContain(messages.chat.overlayLoadFailed);
  expect(alert.textContent).not.toContain(messages.common.somethingWentWrong);
  fireEvent.click(view.getByRole("button", { name: messages.common.tryAgain }));
  expect(retries).toBe(1);
  expect(view.queryByRole("button", { name: messages.common.reload })).toBe(
    null,
  );
});

test("a chunk removed by a deploy asks for a reload instead of a retry", () => {
  let retries = 0;
  const view = renderFallback(
    new TypeError(
      "Failed to fetch dynamically imported module: https://app.example/assets/gated-chat-composer-old.js",
    ),
    () => {
      retries += 1;
    },
  );

  expect(view.getByRole("alert").textContent).toContain(
    messages.chat.overlayUpdated,
  );
  expect(view.queryByRole("button", { name: messages.common.tryAgain })).toBe(
    null,
  );
  expect(
    view.getByRole("button", { name: messages.common.reload }),
  ).toBeDefined();
  expect(retries).toBe(0);
});
