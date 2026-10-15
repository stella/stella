import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register();

const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FileChatOverlayBoundary, FileChatOverlayErrorFallback } =
  await import("./file-chat-overlay-boundary");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const renderFallback = (
  error: Error,
  onRetry: () => void,
  onDismiss: () => void = () => undefined,
) =>
  render(
    <IntlProvider locale="en" messages={messages}>
      <FileChatOverlayErrorFallback
        error={error}
        onDismiss={onDismiss}
        onRetry={onRetry}
      />
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

test("the bar can always be dismissed", () => {
  for (const error of [
    new Error("thread read failed"),
    new TypeError("Failed to fetch dynamically imported module: /old.js"),
  ]) {
    let dismissals = 0;
    const view = renderFallback(
      error,
      () => undefined,
      () => {
        dismissals += 1;
      },
    );
    fireEvent.click(
      view.getByRole("button", { name: messages.common.dismiss }),
    );
    expect(dismissals).toBe(1);
    view.unmount();
  }
});

let overlayRenders = 0;
// An optional overlay that fails while rendering, as a missing provider does.
const FailingOverlay = () => {
  overlayRenders += 1;
  throw new Error("overlay render failed");
};

test("a dismissed overlay failure leaves the reader working without the overlay", async () => {
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const view = render(
      <IntlProvider locale="en" messages={messages}>
        <article data-testid="reader" />
        <FileChatOverlayBoundary
          area="file-chat-overlay"
          onRetry={() => undefined}
          overlayKey="statute:89/2012"
        >
          <FailingOverlay />
        </FileChatOverlayBoundary>
      </IntlProvider>,
    );

    const alert = await waitFor(() => view.getByRole("alert"));
    expect(alert.textContent).toContain(messages.chat.overlayLoadFailed);
    const rendersBeforeDismiss = overlayRenders;

    fireEvent.click(
      view.getByRole("button", { name: messages.common.dismiss }),
    );

    await waitFor(() => expect(view.queryByRole("alert")).toBe(null));
    expect(view.getByTestId("reader")).toBeDefined();
    expect(overlayRenders).toBe(rendersBeforeDismiss);
  } finally {
    console.error = originalConsoleError;
  }
});

test("try again re-renders the overlay after preparing a fresh attempt", async () => {
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    let failing = true;
    let retries = 0;
    const RecoveringOverlay = () => {
      if (failing) {
        throw new Error("thread read failed");
      }
      return <aside data-testid="overlay" />;
    };
    const view = render(
      <IntlProvider locale="en" messages={messages}>
        <FileChatOverlayBoundary
          area="file-chat-overlay"
          onRetry={() => {
            retries += 1;
            failing = false;
          }}
          overlayKey="statute:89/2012"
        >
          <RecoveringOverlay />
        </FileChatOverlayBoundary>
      </IntlProvider>,
    );

    await waitFor(() => view.getByRole("alert"));
    fireEvent.click(
      view.getByRole("button", { name: messages.common.tryAgain }),
    );

    await waitFor(() => expect(view.getByTestId("overlay")).toBeDefined());
    expect(view.queryByRole("alert")).toBe(null);
    expect(retries).toBe(1);
  } finally {
    console.error = originalConsoleError;
  }
});
