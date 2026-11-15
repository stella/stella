import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, test } from "bun:test";

import { nextMacrotask } from "@stll/concurrency/event-loop";

// The platform is read from the user agent when the modules load, so the
// Windows labels need a test file of their own.
GlobalRegistrator.register({
  settings: {
    navigator: {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    },
  },
  url: "http://localhost/",
});

const { act, cleanup, render } = await import("@testing-library/react");
const { clearMocks } = await import("@tauri-apps/api/mocks");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");
const { default: OnboardingApp } =
  await import("../src/onboarding/OnboardingApp");
const { installNativeSide, nativeSide } =
  await import("./onboarding-dictation-native");

// React's scheduler and the mocked IPC answers run on a macrotask; each
// test and the file let one pass while the DOM is still registered.
afterEach(async () => {
  await act(nextMacrotask);
  cleanup();
  clearMocks();
});

afterAll(async () => {
  await nextMacrotask();
  await GlobalRegistrator.unregister();
});

test("the dictation step names the Windows shortcut", async () => {
  installNativeSide(nativeSide());
  const { findByText } = render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <OnboardingApp />
    </DesktopIntlProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });

  await findByText(
    defaultMessages.dictation.description.replace(
      "{shortcut}",
      "Ctrl+Alt+Space",
    ),
  );
});
