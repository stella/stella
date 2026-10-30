import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, jest, test } from "bun:test";

import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  BROWSER_EXTENSION_STATUS,
  type BrowserExtensionResponse,
  type BrowserExtensionStatus,
} from "@stll/api-contract/browser-control";
import { restoreRealTimers } from "@stll/property-testing/fake-timers";

import arMessages from "@/i18n/langs/ar.json";
import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.stella.test" });
const { act, cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { BrowserExtensionChip } = await import("./browser-extension-chip");
const {
  BROWSER_EXTENSION_ANNOUNCEMENT_DEADLINE_MS,
  getBrowserExtensionState,
  mountBrowserExtensionBridge,
} = await import("@/features/chat/browser-control/browser-extension-bridge");

const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);
let unmountBridge: (() => void) | undefined;

beforeEach(() => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: window.navigator,
  });
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36",
  });
  unmountBridge = mountBrowserExtensionBridge();
});

afterEach(() => {
  cleanup();
  unmountBridge?.();
  unmountBridge = undefined;
  restoreRealTimers();
  if (originalNavigator) {
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  } else {
    Reflect.deleteProperty(globalThis, "navigator");
  }
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const report = async ({
  allSitesGranted,
  controllerId,
}: {
  allSitesGranted: boolean;
  controllerId: string | null;
}) => {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          allSitesGranted,
          controlledTabId: null,
          controllerId,
          protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
          requestId: "chip-state",
          source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
          type: "pong",
        } satisfies BrowserExtensionResponse,
        origin: window.location.origin,
        source: window,
      }),
    );
  });
};

const showChip = (installUrl?: string) =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <BrowserExtensionChip installUrl={installUrl} />
    </IntlProvider>,
  );

// Total over the contract: adding a bridge state requires choosing and exercising its UI.
const states = {
  [BROWSER_EXTENSION_STATUS.checking]: async () => undefined,
  [BROWSER_EXTENSION_STATUS.unsupportedBrowser]: async () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 Firefox/140.0",
    });
  },
  [BROWSER_EXTENSION_STATUS.notInstalled]: async () => {
    // Restart under the fake clock so only the announcement deadline advances.
    unmountBridge?.();
    jest.useFakeTimers();
    unmountBridge = mountBrowserExtensionBridge();
    await act(async () => {
      jest.advanceTimersByTime(BROWSER_EXTENSION_ANNOUNCEMENT_DEADLINE_MS);
    });
    restoreRealTimers();
  },
  [BROWSER_EXTENSION_STATUS.needsSiteAccess]: async () => {
    await report({ allSitesGranted: false, controllerId: null });
  },
  [BROWSER_EXTENSION_STATUS.notPaired]: async () => {
    await report({ allSitesGranted: true, controllerId: null });
  },
  [BROWSER_EXTENSION_STATUS.connected]: async () => {
    await report({ allSitesGranted: true, controllerId: "controller-1" });
  },
} satisfies Record<BrowserExtensionStatus, () => Promise<void>>;

for (const status of Object.values(BROWSER_EXTENSION_STATUS)) {
  test(`the live bridge renders ${status}`, async () => {
    await states[status]();
    expect(getBrowserExtensionState().status).toBe(status);
    const ui = showChip();
    switch (status) {
      case BROWSER_EXTENSION_STATUS.checking:
      case BROWSER_EXTENSION_STATUS.unsupportedBrowser:
        expect(ui.container.innerHTML).toBe("");
        break;
      case BROWSER_EXTENSION_STATUS.connected:
        expect(
          screen.getByText(messages.chat.browserExtension.connected),
        ).toBeTruthy();
        break;
      case BROWSER_EXTENSION_STATUS.needsSiteAccess:
      case BROWSER_EXTENSION_STATUS.notPaired:
        expect(
          screen.queryByText(messages.chat.browserExtension.connected),
        ).toBeNull();
        fireEvent.click(
          screen.getByRole("button", {
            name: messages.chat.browserExtension.connect,
          }),
        );
        expect(
          await screen.findByText(
            messages.chat.browserExtension.connectDescription,
          ),
        ).toBeTruthy();
        expect(screen.queryByRole("link")).toBeNull();
        break;
      case BROWSER_EXTENSION_STATUS.notInstalled:
        fireEvent.click(
          screen.getByRole("button", {
            name: messages.chat.browserExtension.install,
          }),
        );
        expect(
          await screen.findByText(
            messages.chat.browserExtension.installDescription,
          ),
        ).toBeTruthy();
        expect(screen.queryByRole("link")).toBeNull();
        break;
    }
  });
}

test("the mounted chip changes from checking to install when the announcement deadline expires", async () => {
  unmountBridge?.();
  jest.useFakeTimers();
  unmountBridge = mountBrowserExtensionBridge();
  const ui = showChip();
  expect(ui.container.innerHTML).toBe("");
  await act(async () => {
    jest.advanceTimersByTime(BROWSER_EXTENSION_ANNOUNCEMENT_DEADLINE_MS);
  });
  expect(
    screen.getByRole("button", {
      name: messages.chat.browserExtension.install,
    }),
  ).toBeTruthy();
});

test("the connected tooltip explains the separate website tab", async () => {
  await states[BROWSER_EXTENSION_STATUS.connected]();
  showChip();
  const trigger = screen.getByRole("button", {
    name: messages.chat.browserExtension.connected,
  });
  await act(async () => {
    trigger.focus();
  });
  expect(
    await screen.findByText(messages.chat.browserExtension.description),
  ).toBeTruthy();
});

test("the install popover links to the supplied store destination", async () => {
  await states[BROWSER_EXTENSION_STATUS.notInstalled]();
  const installUrl = "https://example.test/extension";
  showChip(installUrl);
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.chat.browserExtension.install,
    }),
  );
  expect(
    await screen.findByText(messages.chat.browserExtension.installDescription),
  ).toBeTruthy();
  const link = screen.getByRole("link", {
    name: messages.chat.browserExtension.install,
  });
  expect(link.getAttribute("href")).toBe(installUrl);
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});

test("pongs update the mounted chip and a missing controller never shows connected", async () => {
  showChip();
  expect(
    screen.queryByText(messages.chat.browserExtension.connected),
  ).toBeNull();
  await report({ allSitesGranted: true, controllerId: null });
  expect(
    screen.queryByText(messages.chat.browserExtension.connected),
  ).toBeNull();
  expect(
    screen.getByRole("button", {
      name: messages.chat.browserExtension.connect,
    }),
  ).toBeTruthy();
  await report({ allSitesGranted: true, controllerId: "controller-1" });
  expect(
    screen.getByText(messages.chat.browserExtension.connected),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", {
      name: messages.chat.browserExtension.connect,
    }),
  ).toBeNull();
  await report({ allSitesGranted: true, controllerId: null });
  expect(
    screen.queryByText(messages.chat.browserExtension.connected),
  ).toBeNull();
  expect(
    screen.getByRole("button", {
      name: messages.chat.browserExtension.connect,
    }),
  ).toBeTruthy();
});

test("Arabic setup uses the translated instructions and label", async () => {
  await states[BROWSER_EXTENSION_STATUS.notPaired]();
  render(
    <IntlProvider locale="ar" messages={arMessages} timeZone="UTC">
      <div dir="rtl">
        <BrowserExtensionChip />
      </div>
    </IntlProvider>,
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: arMessages.chat.browserExtension.connect,
    }),
  );
  expect(
    await screen.findByText(
      arMessages.chat.browserExtension.connectDescription,
    ),
  ).toBeTruthy();
});
